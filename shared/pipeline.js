/**
 * 解析流水线：归一化 → @提及 → LLM（可注入）→ 校验 → 兜底。
 * 服务端与前端本地模式共用；`llm` 由调用方注入（服务端用服务端 Key，本地模式用手机上的 Key）。
 */

import { normalizeText } from './normalize.js';
import {
  buildParseMessages, parseModelJson, coerceResult, fallbackParse, extractMentions,
  makeCtx, detectIntent, normalizeQuery, splitWarnings,
} from './parse-core.js';

let seq = 0;
/** 生成本地唯一 id（无依赖） */
export function uid(prefix = 'g') {
  seq = (seq + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 运行一次解析。
 * @param {{
 *   text: string,
 *   ctx: any,
 *   llm?: ((messages:any[], opts?:any)=>Promise<string>)|null,
 *   allowFallback?: boolean,
 * }} args
 * @returns {Promise<{intent:string, records:any[], query:any, target:any, clarification:any, warnings:string[], engine:string, normalized:string, mentions:any[]}>}
 */
export async function runParse({ text, ctx, llm = null, allowFallback = true }) {
  const c = makeCtx(ctx || {});
  const norm = normalizeText(text);
  const { mentions, cleaned } = extractMentions(norm.text, c.users);
  const input = cleaned || norm.text;
  const warnings = [];
  // @ 提及是「谁付的钱」的权威来源，交给 coerceResult 使用
  c.mentionedUsers = mentions;

  if (llm) {
    const messages = buildParseMessages({ text: input, ctx: c });
    try {
      const content = await llm(messages, { json: true, ctx: c });
      let raw = parseModelJson(content);
      let engine = 'llm';
      if (!raw) {
        // 一次修复重试：把错误输出与原要求一起回灌
        warnings.push('模型输出不是合法 JSON，已重试一次');
        const repair = [
          ...messages,
          { role: 'assistant', content: String(content || '').slice(0, 1500) },
          { role: 'user', content: '上面的内容不是合法 JSON。请只输出一个符合格式要求的 JSON 对象，不要解释、不要 markdown 代码块。' },
        ];
        const content2 = await llm(repair, { json: true, ctx: c });
        raw = parseModelJson(content2);
        engine = 'llm-repaired';
      }
      if (raw) {
        const res = coerceResult(raw, { text: input, ctx: c });
        res.engine = engine;
        res.normalized = input;
        res.mentions = mentions;
        const split = splitWarnings([...(res.warnings || []), ...warnings]);
        res.warnings = split.user;
        res.internalWarnings = split.internal;
        if (res.query) res.query = normalizeQuery(res.query, c.now);
        return res;
      }
      warnings.push('模型两次都未返回合法 JSON，已改用本地规则识别');
      warnings.push('智能解析暂时不可用，这笔是按规则识别的，请确认卡片信息');
    } catch (err) {
      warnings.push(`模型调用失败（${String(err && err.message || err).slice(0, 120)}），已改用本地规则识别`);
      // 技术原因只进日志/调试面板；用户这边给一句能理解、可行动的提示
      warnings.push('智能解析暂时不可用，这笔是按规则识别的，请确认卡片信息');
    }
  }

  if (!allowFallback) {
    return {
      intent: 'add_record', records: [], query: null, target: null,
      clarification: { field: 'amount', question: '解析服务暂时不可用，请手动填写。', options: [] },
      warnings, engine: 'none', normalized: input, mentions,
    };
  }

  const fb = fallbackParse(input, c);
  fb.engine = 'rules';
  fb.normalized = input;
  fb.mentions = mentions;
  const split = splitWarnings([...(fb.warnings || []), ...warnings]);
  fb.warnings = split.user;
  fb.internalWarnings = split.internal;
  if (fb.query) fb.query = normalizeQuery(fb.query, c.now);
  return fb;
}

/**
 * 记录草稿 → 入库行（服务端 SQLite 与前端本地库使用同一结构）。
 * @param {any} draft coerceResult/fallbackParse 产出的记录草稿
 * @param {{bookId:number, authorAccountId:number, clientMsgId:string|null, groupId?:string|null, source?:string}} meta
 */
export function draftToRow(draft, meta) {
  const occurredAt = `${draft.occurredDate} ${draft.occurredTime || '12:00'}`;
  return {
    bookId: meta.bookId,
    authorAccountId: meta.authorAccountId ?? null,
    payerAccountId: draft.payerAccountId ?? meta.authorAccountId ?? null,
    type: draft.type,
    amountCents: draft.amountCents,
    currency: 'CNY',
    category: draft.category,
    subcategory: draft.subcategory || '',
    merchant: draft.merchant || '',
    note: draft.note || '',
    occurredAt,
    occurredDate: draft.occurredDate,
    occurredTime: draft.occurredTime || null,
    occurredText: draft.occurredText || '',
    source: meta.source || 'text',
    rawText: draft.sourceText || '',
    confidence: draft.confidence ?? 0.8,
    status: 'confirmed',
    groupId: meta.groupId || null,
    clientMsgId: meta.clientMsgId,
    version: 1,
    participants: (draft.participants || []).map((p) => ({
      accountId: p.accountId, name: p.name, shareCents: p.shareCents,
    })),
  };
}

/** 简单断言：这句话能否直接被当成一笔账（用于前端做发送前校验） */
export function looksLikeRecord(text) {
  const norm = normalizeText(text).text;
  return detectIntent(norm) === 'add_record' && /\d/.test(norm);
}

/**
 * 定位「刚才那笔」「上周打车那条」指向的记录。
 * @param {any[]} records 按时间倒序的记录列表（最近的在前面）
 * @param {{record_id?:any, recent_offset?:number, amount?:number, category?:string, keyword?:string}} target
 * @returns {{record:any|null, candidates:any[]}}
 */
export function resolveTarget(records, target = {}) {
  const list = (records || []).filter((r) => !r.deletedAt && r.status !== 'deleted');
  if (!list.length) return { record: null, candidates: [] };
  if (target.record_id != null) {
    const hit = list.find((r) => String(r.id) === String(target.record_id));
    return { record: hit || null, candidates: hit ? [hit] : [] };
  }
  if (target.recent_offset != null && Number(target.recent_offset) >= 1) {
    const hit = list[Number(target.recent_offset) - 1] || null;
    return { record: hit, candidates: hit ? [hit] : [] };
  }
  const cands = list.filter((r) => {
    if (target.amount != null && Math.abs(r.amountCents - Math.round(Number(target.amount) * 100)) > 1) return false;
    if (target.category && r.category !== target.category) return false;
    if (target.keyword) {
      const hay = `${r.category} ${r.subcategory || ''} ${r.note || ''} ${r.merchant || ''}`;
      if (!hay.includes(String(target.keyword))) return false;
    }
    return true;
  });
  if (cands.length === 1) return { record: cands[0], candidates: cands };
  // 没有匹配条件时默认最近一笔
  if (!target.amount && !target.category && !target.keyword) return { record: list[0], candidates: [list[0]] };
  return { record: null, candidates: cands.slice(0, 8) };
}

export { detectIntent, normalizeQuery };
