/**
 * 解析核心：提示词构造、模型输出解析与校验、规则兜底。
 * 服务端（Node）与前端本地模式（浏览器 / APK）共用同一套逻辑，保证两种模式行为一致。
 */

import { normalizeText, normalizeAmounts, findAmounts, cnToNumber } from './normalize.js';
import { resolveDate, resolveTime, resolveRange, tzNow, ymdDiff, TZ_DEFAULT } from './date.js';
import {
  CATEGORY_TREE, CATEGORY_NAMES, MEAL_CATEGORIES, INCOME_HINTS, REFUND_HINTS, TRANSFER_HINTS,
  matchCategoryByKeyword, guessSub, iconOf, EXPENSE_CATEGORIES,
} from './categories.js';

/** 默认大额阈值：50 元 */
export const DEFAULT_LARGE_THRESHOLD_CENTS = 5000;

/** 金额上限（超过则要求二次确认）：100 万元 */
export const MAX_AMOUNT_CENTS = 100000000;
/** 单笔超过此值触发二次确认 */
export const CONFIRM_AMOUNT_CENTS = 1000000;

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 提取 @某人。
 * 注意：返回的 cleaned 文本会**保留 @ 标记**（只把「@ 张三」规范成「@张三」），
 * 因为 @ 是「指定付款人」的重要语义，不能丢给模型的信息里去掉。
 * @param {string} text
 * @param {Array<{id:number,name:string,aliases?:string[]}>} users
 */
export function extractMentions(text, users = []) {
  const found = [];
  const cleaned = String(text || '').replace(/@\s*([^\s@，。,\.、!！?？]{1,12})/g, (m, name) => {
    const hit = matchUser(name, users);
    if (hit) {
      if (!found.some((u) => u.id === hit.id)) found.push(hit);
      return `@${hit.name} `;
    }
    return m;
  });
  return { mentions: found, cleaned };
}

/** 按名字/别名匹配成员 */
export function matchUser(name, users = []) {
  if (!name) return null;
  const n = String(name).trim();
  for (const u of users) {
    if (u.name === n) return u;
    if ((u.aliases || []).includes(n)) return u;
  }
  // 宽松匹配：文本包含成员名（如「给妈妈买菜」→ 妈妈）
  for (const u of users) {
    if (n.includes(u.name) || u.name.includes(n)) return u;
  }
  return null;
}

/** 在文本里找提到的所有成员 */
export function findUsersInText(text, users = []) {
  const t = String(text || '');
  const out = [];
  for (const u of users) {
    const names = [u.name, ...(u.aliases || [])].filter(Boolean);
    if (names.some((n) => t.includes(n))) out.push(u);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

/**
 * 构造发给 LLM 的消息。
 * @param {{text:string, ctx:ParseCtx}} args
 */
export function buildParseMessages({ text, ctx }) {
  const now = ctx.now || tzNow(ctx.tz || TZ_DEFAULT);
  const today = now.ymd;
  const users = ctx.users || [];
  const recent = (ctx.recent || []).slice(0, 5);

  const sys = [
    '你是一个中文记账助手，负责把用户的一句话解析成结构化记账数据。你只输出 JSON，不要输出任何解释性文字、markdown 代码块或多余字段。',
    '',
    '## 输出格式（严格遵守）',
    '{',
    '  "intent": "add_record | query | update_record | delete_record | undo | chat",',
    '  "records": [',
    '    {',
    '      "type": "expense | income | refund | transfer",',
    '      "amount": 数字（单位：元，如 35.5）,',
    '      "category": "一级类别，必须来自下面的类别表",',
    '      "subcategory": "二级类别，可选，尽量填",',
    '      "date_iso": "YYYY-MM-DD",',
    '      "time_iso": "HH:MM 或 null",',
    '      "date_text": "用户原话里的时间说法，没有就填 今天",',
    '      "merchant": "商户/地点，没有就空字符串",',
    '      "note": "简短备注，如 和同事聚餐",',
    '      "payer": "付款人姓名，未指定则用默认付款人",',
    '      "participants": ["一起消费的人名"],',
    '      "split": "none | equal",',
    '      "confidence": 0.0 到 1.0',
    '    }',
    '  ],',
    '  "query": { "range": "today|yesterday|week|last_week|month|last_month|year|all|自定义", "from": "YYYY-MM-DD 或 null", "to": "YYYY-MM-DD 或 null", "group_by": "category|user|day|none", "filters": { "user": "姓名或null", "category": "类别或null", "keyword": "或null", "min_amount": 数字或null, "max_amount": 数字或null } },',
    '  "target": { "recent_offset": 数字（1 表示最近一笔）, "amount": 数字或null, "category": "或null" },',
    '  "clarification": { "field": "amount|date|category|payer|participants", "question": "一句中文追问", "options": ["快捷选项"] } 或 null',
    '}',
    '',
    '## 硬性规则',
    '1. 只输出用户真正说到的消费/收入。用户没提金额时，不要编造金额，必须把 clarification.field 设为 "amount" 并给出一句追问。',
    '2. 一句话里有多笔消费时，拆成 records 里的多条（例如「早饭12 打车35」→ 两条）。',
    '3. 金额单位是元。注意「块、毛、角、分、万、K、w」等口语单位；「35块5」= 35.5 元；「五毛」= 0.5 元。',
    '4. 日期必须换算成绝对日期 YYYY-MM-DD，锚点是「今天」。没有时间词就用今天。不要输出未来日期。',
    '5. category 必须严格从类别表里选一个一级类别名，不要自创。判断不准时用「其他」。',
    '6. 收入（工资、报销、退款、收到红包、卖出、利息等）type 用 income 或 refund，category 用「收入」。',
    '7. payer 只能是成员表里的人名；用户用「@某人」或「帮某人」指定时按他说的填；参与者用 participants。',
    '8. 如果用户是在查询/统计（花了多少、排行、占比、明细），intent 用 query，并在 query 里填好区间与分组，records 留空数组。',
    '9. 如果用户要求修改或删除之前记的账，intent 用 update_record / delete_record / undo，并在 target 里给出定位信息。',
    '10. 与记账无关的闲聊，intent 用 chat，records 留空数组。',
    '',
    '## 类别表',
    CATEGORY_TREE.map((c) => `${c.name}(${c.subs.join('/')})`).join('、'),
    '',
    '## 当前上下文',
    `今天：${today}（${WEEKDAY_CN[now.weekday]}），当前时间 ${now.hm}，时区 ${now.tz || TZ_DEFAULT}`,
    `成员：${users.length ? users.map((u) => u.name).join('、') : '（暂无，用「我」表示当前用户）'}`,
    `当前说话人：${ctx.currentUser?.name || '我'}`,
    `默认付款人：${ctx.currentUser?.name || '我'}`,
    recent.length
      ? `最近的记录（用于「同上」「再来一笔」这类指代）：\n${recent.map((r, i) => `  ${i + 1}. ${r.date} ${r.category} ¥${(r.amountCents / 100).toFixed(2)} ${r.note || ''}（${r.userName || ''}）`).join('\n')}`
      : '最近的记录：（无）',
  ].join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: String(text) },
  ];
}

/* ------------------------------------------------------------------ *
 * 模型输出解析
 * ------------------------------------------------------------------ */

/** 宽容地从模型输出里抠出 JSON 对象 */
export function parseModelJson(content) {
  if (!content) return null;
  if (typeof content === 'object') return content;
  let s = String(content).trim();
  // 去掉 ```json ``` 包裹
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const tryParse = (str) => {
    try { return JSON.parse(str); } catch { return null; }
  };
  let obj = tryParse(s);
  if (obj) return obj;
  // 抠第一个平衡的 { ... }
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          obj = tryParse(s.slice(start, i + 1));
          if (obj) return obj;
        }
      }
    }
  }
  // 最后的挣扎：去尾逗号、单引号
  const relaxed = s
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/'/g, '"')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  return tryParse(relaxed);
}

/** 标准化类型 */
function normType(v, text) {
  const t = String(v || '').toLowerCase();
  if (['expense', 'income', 'refund', 'transfer'].includes(t)) return t;
  const s = String(text || '');
  if (REFUND_HINTS.some((k) => s.includes(k))) return 'refund';
  if (INCOME_HINTS.some((k) => s.includes(k))) return 'income';
  if (TRANSFER_HINTS.some((k) => s.includes(k))) return 'transfer';
  return 'expense';
}

/** 元 → 分 */
export function toCents(v) {
  const n = typeof v === 'string' ? Number(String(v).replace(/[^\d.]/g, '')) : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * 校验并补全模型输出（不信任模型，一切以服务端/客户端校验为准）。
 * @param {any} raw 模型返回的 JSON
 * @param {{text:string, ctx:ParseCtx}} args
 */
export function coerceResult(raw, { text, ctx }) {
  const warnings = [];
  const now = ctx.now || tzNow(ctx.tz || TZ_DEFAULT);
  const users = ctx.users || [];
  const src = String(text || '');
  const out = {
    intent: 'add_record',
    records: [],
    query: null,
    target: null,
    clarification: null,
    warnings,
    raw: raw || null,
  };
  if (!raw || typeof raw !== 'object') {
    out.clarification = { field: 'amount', question: '这句我没太理解，能再说一次吗？比如「昨天午饭 35」。', options: [] };
    return out;
  }

  const intent = String(raw.intent || 'add_record');
  out.intent = ['add_record', 'query', 'update_record', 'delete_record', 'undo', 'chat'].includes(intent) ? intent : 'add_record';
  out.query = raw.query && typeof raw.query === 'object' ? raw.query : null;
  out.target = raw.target && typeof raw.target === 'object' ? raw.target : null;
  if (raw.clarification && raw.clarification.field) {
    out.clarification = {
      field: String(raw.clarification.field),
      question: String(raw.clarification.question || '这个信息我还需要确认一下。'),
      options: Array.isArray(raw.clarification.options) ? raw.clarification.options.slice(0, 6).map(String) : [],
    };
  }

  const list = Array.isArray(raw.records) ? raw.records : [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const amountCents = toCents(r.amount_cents ?? r.amount);
    if (amountCents === null || amountCents <= 0) {
      warnings.push('模型给出的记录缺少有效金额，已跳过');
      continue;
    }
    if (amountCents > MAX_AMOUNT_CENTS) {
      warnings.push(`金额 ¥${(amountCents / 100).toFixed(2)} 过大，请确认`);
    }
    let category = String(r.category || '').trim();
    if (!CATEGORY_NAMES.includes(category)) {
      // 先在本条记录自己的字段里找关键词；只有整句只有一条记录时才用整句兜底
      const own = matchCategoryByKeyword(`${category} ${r.subcategory || ''} ${r.note || ''} ${r.merchant || ''}`);
      const whole = list.length === 1 ? matchCategoryByKeyword(src) : null;
      category = (own && own.category) || (whole && whole.category) || '其他';
    }
    const type = normType(r.type, `${category} ${r.note || ''} ${src}`);
    if (category === '其他' && type === 'income') category = '收入';

    // 日期
    let dateIso = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date_iso || '')) ? r.date_iso : null;
    let dateText = String(r.date_text || '');
    let assumed = false;
    let dateFuture = false;
    if (!dateIso) {
      const d = resolveDate(dateText || src, now);
      dateIso = d.date;
      assumed = d.assumed;
      dateFuture = d.future;
      if (!dateText) dateText = d.matched || '今天';
    } else {
      dateFuture = ymdDiff(dateIso, now.ymd) > 0;
    }
    if (dateFuture) {
      warnings.push('解析出的日期在未来，已改为今天');
      dateIso = now.ymd;
      dateText = '今天';
    }

    // 时间
    let timeIso = /^\d{1,2}:\d{2}$/.test(String(r.time_iso || '')) ? String(r.time_iso) : null;
    if (timeIso) timeIso = `${timeIso.split(':')[0].padStart(2, '0')}:${timeIso.split(':')[1]}`;
    if (!timeIso) timeIso = resolveTime(src);

    // 人：@ 提及优先（用户显式指定的付款人）
    const mentioned = (ctx.mentionedUsers && ctx.mentionedUsers.length)
      ? ctx.mentionedUsers
      : extractMentions(src, users).mentions;
    let payer = null;
    if (r.payer) payer = matchUser(r.payer, users);
    if (mentioned.length === 1) payer = mentioned[0]; // @某人 → 覆盖模型判断
    if (!payer && mentioned.length > 1) payer = mentioned[0];
    if (!payer && ctx.currentUser) payer = users.find((u) => u.id === ctx.currentUser.id) || null;
    if (!payer) payer = users[0] || null;

    // 参与人（AA / 一起消费）
    const aaHint = /(aa|AA|平摊|平分|均摊|对半分|各付各的|一起付|一起买|一起)/.test(src);
    let participants = [];
    if (Array.isArray(r.participants) && r.participants.length) {
      participants = r.participants.map((n) => matchUser(n, users)).filter(Boolean);
    } else if (mentioned.length) {
      participants = [...mentioned];
    }
    if (aaHint) {
      const me = ctx.currentUser ? users.find((u) => u.id === ctx.currentUser.id) : null;
      if (!participants.length && payer) participants = [payer];
      // 只点名了一个人又说 AA，默认说话人也一起分摊
      if (participants.length === 1 && me && me.id !== participants[0].id) participants.push(me);
      if (payer && !participants.some((p) => p.id === payer.id)) participants.unshift(payer);
    } else if (!participants.length && payer) {
      participants = [payer];
    }
    const shares = splitShares(
      amountCents,
      participants,
      payer,
      (aaHint || participants.length > 1) ? 'equal' : String(r.split || 'none'),
    );

    const def = CATEGORY_TREE.find((c) => c.name === category);
    const sub = String(r.subcategory || '').trim() || (def ? guessSub(def, `${r.note || ''} ${src}`) : '');
    const conf = Number(r.confidence);
    out.records.push({
      type,
      amountCents,
      category,
      subcategory: sub,
      merchant: String(r.merchant || '').trim(),
      note: String(r.note || '').trim(),
      occurredDate: dateIso,
      occurredTime: timeIso,
      occurredText: dateText || '今天',
      dateAssumed: assumed,
      payerAccountId: payer ? payer.id : null,
      payerName: payer ? payer.name : (ctx.currentUser?.name || '我'),
      participants: shares,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.8,
      sourceText: src,
    });
  }

  // 没有解析出任何记录 → 追问金额
  if (!out.records.length && !out.clarification && (out.intent === 'add_record')) {
    out.clarification = { field: 'amount', question: '这笔花了多少钱？', options: [] };
  }
  return out;
}

/** AA 分摊：返回 [{accountId, name, shareCents}] */
export function splitShares(amountCents, participants, payer, split) {
  if (!participants || participants.length === 0) return [];
  if (split === 'none' && participants.length <= 1) {
    return [{ accountId: participants[0].id, name: participants[0].name, shareCents: amountCents }];
  }
  const n = participants.length;
  const base = Math.floor(amountCents / n);
  const rest = amountCents - base * n;
  return participants.map((p, i) => ({
    accountId: p.id,
    name: p.name,
    // 余数分给付款人（第一人）
    shareCents: base + (i === 0 ? rest : 0),
  }));
}

/* ------------------------------------------------------------------ *
 * 规则兜底（无 Key / 模型失败时）
 * ------------------------------------------------------------------ */

const NON_AMOUNT_FOLLOW = /^(月|日|号|点|分|秒|个|人|位|天|年|次|折|%|％|楼|路|号线|公里|km|g|克|ml|毫升|岁)/;

/**
 * 从归一化文本中提取金额（元）。优先带货币单位的数字，其次排除日期/数量后的裸数字。
 * @param {string} text
 * @returns {{value:number, cents:number, unit:boolean, index:number}|null}
 */
export function extractAmount(text) {
  const s = String(text || '');
  // ① 明确带货币单位
  const withUnit = /([0-9]+(?:\.[0-9]+)?)\s*(元|块钱|块|圆|rmb)(?:\s*([0-9]{1,2})(?![个位人月日号点次折楼路岁克斤]))?/i.exec(s);
  if (withUnit) {
    let v = Number(withUnit[1]);
    if (withUnit[3]) v += Number(withUnit[3].length === 1 ? withUnit[3] / 10 : withUnit[3] / 100);
    if (Number.isFinite(v) && v > 0) return { value: v, cents: Math.round(v * 100), unit: true, index: withUnit.index };
  }
  // ② 动词附近：「花了 35」「一共 200」「收入 8000」
  const verbRe = /(花了|花掉|付了|付款|支付|消费|买了|买了单|一共|总共|合计|共计|人均|收入|收了|赚了|报销|充值|花费|支出)\s*([0-9]+(?:\.[0-9]+)?)/;
  const verb = verbRe.exec(s);
  if (verb) {
    const v = Number(verb[2]);
    if (Number.isFinite(v) && v > 0) return { value: v, cents: Math.round(v * 100), unit: false, index: verb.index };
  }
  // ③ 裸数字：排除日期/数量/时间
  const re = /([0-9]+(?:\.[0-9]+)?)/g;
  let m;
  const candidates = [];
  while ((m = re.exec(s)) !== null) {
    const after = s.slice(m.index + m[0].length).trimStart();
    if (NON_AMOUNT_FOLLOW.test(after)) continue;
    const before = s.slice(Math.max(0, m.index - 2), m.index);
    if (/月$/.test(before)) continue;
    const v = Number(m[1]);
    if (!Number.isFinite(v) || v <= 0) continue;
    candidates.push({ value: v, cents: Math.round(v * 100), unit: false, index: m.index });
  }
  if (!candidates.length) return null;
  // 取最后一个（口语里金额常在句尾）
  return candidates[candidates.length - 1];
}

/**
 * 纯规则解析：不依赖任何模型，保证「没有 Key 也能记账」。
 * @param {string} text 原始输入
 * @param {ParseCtx} ctx
 */
export function fallbackParse(text, ctx) {
  const now = ctx.now || tzNow(ctx.tz || TZ_DEFAULT);
  const users = ctx.users || [];
  const norm = normalizeText(text);
  const src = norm.text || String(text || '');
  const warnings = ['未配置大模型，本笔由本地规则识别，请确认'];
  const intent = detectIntent(src);

  if (intent !== 'add_record') {
    return {
      intent,
      records: [],
      query: intent === 'query' ? buildFallbackQuery(src, now) : null,
      target: /撤销|退回|取消上|删掉上一/.test(src) ? { recent_offset: 1 } : null,
      clarification: null,
      warnings,
      raw: null,
    };
  }

  const amount = extractAmount(src);
  if (!amount) {
    return {
      intent: 'add_record',
      records: [],
      query: null,
      target: null,
      clarification: { field: 'amount', question: '这笔花了多少钱？', options: [] },
      warnings,
      raw: null,
    };
  }

  const { mentions } = extractMentions(src, users);
  const dateInfo = resolveDate(src, now);
  const time = resolveTime(src);
  const catHit = matchCategoryByKeyword(src);
  const type = normType('', src);
  let category = catHit ? catHit.category : (type === 'expense' ? '其他' : '收入');
  if (type !== 'expense' && category === '其他') category = '收入';
  const def = CATEGORY_TREE.find((c) => c.name === category);
  let payer = mentions[0] || users.find((u) => u.id === ctx.currentUser?.id) || users[0] || null;
  const participants = mentions.length > 1 ? mentions : [];
  const confidence = 0.4 + (amount.unit ? 0.15 : 0) + (catHit ? 0.2 : 0) + (dateInfo.assumed ? 0 : 0.1);

  // 备注：从原话里剥掉「日期 + 金额 + 记账口头语」，只留下真正有信息量的部分，
  // 避免卡片上出现「10月1号早饭12」这种和原话重复的备注
  let cleanNote = src
    .replace(/([0-9]+(?:\.[0-9]+)?)\s*(元|块钱|块|圆)/g, ' ')
    .replace(/(花了|花掉|付了|付款|支付|消费|一共|总共|合计|共计|人均|买了|记一笔|记录)/g, ' ')
    .replace(/[@＠]/g, '')
    .replace(/[，。,.!！?？、]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (dateInfo.matched) cleanNote = cleanNote.replace(dateInfo.matched, ' ').replace(/\s+/g, ' ').trim();
  // 去掉残留的数字（金额已在卡片上单独展示）与成员名（已有付款人 / 分摊标签）
  cleanNote = cleanNote.replace(/\d+(?:\.\d+)?/g, ' ');
  for (const u of (ctx.users || [])) {
    if (u.name && cleanNote.includes(u.name)) cleanNote = cleanNote.split(u.name).join(' ');
  }
  cleanNote = cleanNote.replace(/\s+/g, ' ').trim();
  // 去掉日期词、数字、人名后若什么都不剩，就不要备注
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(cleanNote)) cleanNote = '';

  return {
    intent: 'add_record',
    records: [{
      type,
      amountCents: amount.cents,
      category,
      subcategory: def ? guessSub(def, src) : '',
      merchant: '',
      note: cleanNote.slice(0, 40),
      occurredDate: dateInfo.date,
      occurredTime: time,
      occurredText: dateInfo.matched || '今天',
      dateAssumed: dateInfo.assumed,
      payerAccountId: payer ? payer.id : null,
      payerName: payer ? payer.name : '我',
      participants: splitShares(amount.cents, participants, payer, participants.length > 1 ? 'equal' : 'none'),
      confidence: Math.min(0.85, confidence),
      sourceText: String(text || ''),
    }],
    query: null,
    target: null,
    clarification: null,
    warnings,
    raw: null,
  };
}

/** 粗判意图（兜底用） */
export function detectIntent(text) {
  const s = String(text || '');
  if (/^(撤销|撤回|取消上一笔|删掉上一笔|退回上一笔)$/.test(s.trim())) return 'undo';
  if (/(删除|删掉|去掉|取消)(那|这|刚才|上)?(笔|条|个)?/.test(s)) return 'delete_record';
  if (/(改成|改为|修改|修正|应该是|其实是)/.test(s)) return 'update_record';
  if (/(多少|花了|统计|排行|排名|占比|一共|总共|合计|趋势|明细|账单|几个|几笔|对比|平均)/.test(s)
    && !/[0-9]+\s*(元|块)/.test(s)) return 'query';
  if (/(查一下|看一下|看看|给我看|汇总)/.test(s)) return 'query';
  return 'add_record';
}

/** 兜底查询条件 */
function buildFallbackQuery(text, now) {
  const range = resolveRange(text, now);
  let groupBy = 'category';
  if (/谁|人员|每个人|各人|按人/.test(text)) groupBy = 'user';
  else if (/每天|按天|日历|日维度/.test(text)) groupBy = 'day';
  const catHit = matchCategoryByKeyword(text);
  return {
    range: range ? range.label : 'all',
    from: range ? range.from : null,
    to: range ? range.to : null,
    group_by: groupBy,
    filters: { category: catHit ? catHit.category : null, user: null, keyword: null, min_amount: null, max_amount: null },
  };
}

/**
 * 把模型/兜底的 query 规格补全为绝对区间。
 * @param {any} query
 * @param {ReturnType<typeof tzNow>} now
 */
export function normalizeQuery(query, now) {
  const q = query && typeof query === 'object' ? { ...query } : {};
  const filters = q.filters && typeof q.filters === 'object' ? { ...q.filters } : {};
  let from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || '')) ? q.from : null;
  let to = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || '')) ? q.to : null;
  const rangeKey = String(q.range || '').toLowerCase();
  const label = String(q.range || '');

  if (!from && !to && rangeKey) {
    const fake = {
      today: '今天', yesterday: '昨天', week: '本周', last_week: '上周',
      month: '本月', last_month: '上个月', year: '今年', all: '全部',
    }[rangeKey];
    if (fake) {
      const r = resolveRange(fake, now);
      if (r) { from = r.from; to = r.to; }
    } else if (label) {
      const r = resolveRange(label, now);
      if (r) { from = r.from; to = r.to; }
    }
  }
  return {
    range: label || 'all',
    from, to,
    group_by: ['category', 'user', 'day', 'none'].includes(String(q.group_by)) ? q.group_by : 'category',
    filters,
  };
}

/**
 * 哪些 warning 属于「内部实现细节」，不该出现在用户面前。
 * （模型调用失败、JSON 重试、未配置 Key、被跳过的脏数据……）
 */
const INTERNAL_WARNING_RE = /未配置大模型|未配置模型|模型输出不是合法 JSON|模型两次都未返回|模型调用失败|模型给出的记录缺少有效金额|已改用本地规则识别/;

/** 把提示拆成「用户该看的」和「只该进日志/调试面板的」 */
export function splitWarnings(list = []) {
  const user = [];
  const internal = [];
  for (const w of list) {
    if (!w) continue;
    (INTERNAL_WARNING_RE.test(String(w)) ? internal : user).push(String(w));
  }
  return { user, internal };
}

/** 提示词/解析上下文默认值 */
export function makeCtx(partial = {}) {
  return {
    now: partial.now || tzNow(partial.tz || TZ_DEFAULT),
    tz: partial.tz || TZ_DEFAULT,
    users: partial.users || [],
    currentUser: partial.currentUser || null,
    recent: partial.recent || [],
    largeThresholdCents: partial.largeThresholdCents ?? DEFAULT_LARGE_THRESHOLD_CENTS,
    ...partial,
  };
}

/** 记录草稿 → 展示用文案（聊天流里的助手回复） */
export function describeRecordDraft(d, users = []) {
  const parts = [];
  const typeCn = { expense: '支出', income: '收入', refund: '退款', transfer: '转账' }[d.type] || '支出';
  parts.push(`${iconOf(d.category)} ${d.category}${d.subcategory ? `·${d.subcategory}` : ''}`);
  parts.push(`¥${(d.amountCents / 100).toFixed(2)}`);
  parts.push(`${d.occurredDate}${d.occurredTime ? ` ${d.occurredTime}` : ''}`);
  if (d.payerName) parts.push(`付款人：${d.payerName}`);
  if (d.participants?.length > 1) parts.push(`分摊：${d.participants.map((p) => `${p.name} ¥${(p.shareCents / 100).toFixed(2)}`).join('、')}`);
  if (d.note) parts.push(d.note);
  return `${typeCn} ${parts.join(' · ')}`;
}

export { MEAL_CATEGORIES, EXPENSE_CATEGORIES, CATEGORY_NAMES, matchCategoryByKeyword, guessSub, iconOf, findAmounts, normalizeAmounts, cnToNumber, resolveRange, resolveDate, tzNow };
