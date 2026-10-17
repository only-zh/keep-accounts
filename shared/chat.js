/**
 * 聊天指令处理器：服务端与前端共用同一份实现。
 *
 * 商业版权限规则（很重要）：
 *   - 记录有两个"人"：author（谁发的这条，决定谁能改）与 payer（这笔钱谁花的，由 @ 决定）
 *   - 普通成员（member）不能用 @ 帮别人记账：输入里的 @ 会被忽略并给出提示
 *   - 管理员/创建者（owner|admin）可以用 @某人 帮别人记账
 *   - 最终权限由服务端 Store.assertCanEdit 兜底，这里只负责不让普通成员误用 @
 *
 * store 需要实现（见 server/store.js）：
 *   listRecords / insertRecord / updateRecord / softDeleteRecord / restoreRecord
 *   listMembers / getSetting / recentRecords / insertMessage / audit
 */

import { runParse, draftToRow, resolveTarget, uid } from './pipeline.js';
import { makeCtx } from './parse-core.js';
import { computeStats, presetRange } from './stats.js';
import { tzNow } from './date.js';
import { iconOf } from './categories.js';

export const MANAGER_ROLES = ['owner', 'admin'];

/** 是否具备管理员权限（可改任意卡片、可用 @ 记账） */
export function isManager(role) {
  return MANAGER_ROLES.includes(String(role || ''));
}

const AT_PATTERN = /@\s*([^\s@，。,\.、!！?？]{1,12})/g;

/** 文本里是否用了 @ */
export function hasMention(text) {
  return /@\s*[^\s@，。,\.!！?？]{1,12}/.test(String(text || ''));
}

/** 构造解析上下文（账本成员、当前账号、最近记录） */
export function buildParseCtx({ store, book, account, tz = 'Asia/Shanghai', now = null }) {
  const members = book ? store.listMembers(book.id) : [];
  const largeThresholdCents = Number(store.getSetting?.('largeThresholdCents', 5000)) || 5000;
  return makeCtx({
    now: now || tzNow(tz),
    tz,
    users: members.map((m) => ({ id: m.accountId, name: m.displayName, emoji: m.emoji })),
    currentUser: account ? { id: account.id, name: account.displayName } : null,
    recent: book ? store.recentRecords(book.id, 5) : [],
    largeThresholdCents,
  });
}

/**
 * 处理一条聊天输入。
 * @param {{
 *   text:string, book:any, account:any, role:string, source?:string, clientMsgId?:string|null,
 *   store:any, llm:any, cfg?:{tz?:string, model?:string, largeThresholdCents?:number}
 * }} args
 */
export async function handleChat({
  text, book, account, role = 'member', source = 'text', clientMsgId = null, store, llm, cfg = {},
}) {
  const tz = cfg.tz || 'Asia/Shanghai';
  const started = Date.now();
  const manager = isManager(role);

  // 普通成员不能用 @ 帮别人记账：抹掉 @ 语义，避免"看起来记到别人头上"
  let input = String(text || '');
  const warnings = [];
  if (hasMention(input) && !manager) {
    input = input.replace(AT_PATTERN, (m, name) => name);
    warnings.push('只有账本管理员可以用 @ 帮别人记账，这笔已记在你自己名下');
  }

  const ctx = buildParseCtx({ store, book, account, tz });
  const parsed = await runParse({ text: input, ctx, llm });

  if (store.audit) {
    store.audit({
      kind: 'parse',
      provider: parsed.engine,
      model: cfg.model || '',
      accountId: account ? account.id : null,
      inputText: text,
      outputText: JSON.stringify(parsed.raw || parsed.records || parsed.query || {}),
      latencyMs: Date.now() - started,
      ok: true,
    });
  }

  const internal = parsed.internalWarnings || [];
  if (internal.length) console.log(`[parse] 内部提示（不展示给用户）：${internal.join(' | ')}`);
  const reply = {
    engine: parsed.engine,
    warnings: [...warnings, ...(parsed.warnings || [])],
    internal,
    intent: parsed.intent,
    records: [],
    clarification: parsed.clarification || null,
    query: parsed.query || null,
    summary: null,
    action: 'none',
    candidates: [],
    text: '',
  };

  const bookRecords = () => store.listRecords({ bookId: book.id, limit: 20000, recentFirst: true });
  const largeThreshold = Number(store.getSetting?.('largeThresholdCents', cfg.largeThresholdCents ?? 5000)) || 5000;

  switch (parsed.intent) {
    case 'undo': {
      // 普通成员只能撤销自己发的；管理员可以撤销最近任意一笔
      const all = bookRecords();
      const mine = manager ? all : all.filter((r) => String(r.authorAccountId) === String(account?.id));
      const { record } = resolveTarget(mine, parsed.target?.recent_offset ? parsed.target : { recent_offset: 1 });
      if (!record) { reply.text = '没有可撤销的记录。'; break; }
      const undone = store.softDeleteRecord(record.id, account ? account.id : null);
      reply.action = 'deleted';
      reply.undone = undone;
      reply.records = [undone];
      reply.text = `已撤销：${iconOf(undone.category)} ${undone.category} ¥${(undone.amountCents / 100).toFixed(2)}（${undone.occurredDate}）`;
      break;
    }
    case 'delete_record': {
      const { record, candidates } = resolveTarget(bookRecords(), parsed.target || {});
      if (!record) {
        reply.action = 'clarify';
        reply.candidates = candidates.map((c) => c.id);
        reply.clarification = {
          field: 'target',
          question: candidates.length ? '找到多笔符合条件的记录，你要删哪一笔？' : '没找到要删除的记录，能说得具体一点吗？',
          options: candidates.map((c) => `${c.occurredDate} ${c.category} ¥${(c.amountCents / 100).toFixed(2)}`),
        };
        break;
      }
      const deleted = store.softDeleteRecord(record.id, account ? account.id : null);
      reply.action = 'deleted';
      reply.records = [deleted];
      reply.text = `已删除：${iconOf(deleted.category)} ${deleted.category} ¥${(deleted.amountCents / 100).toFixed(2)}（${deleted.occurredDate}）`;
      break;
    }
    case 'update_record': {
      const { record, candidates } = resolveTarget(bookRecords(), parsed.target || {});
      const draft = parsed.records?.[0];
      if (!record) {
        reply.action = 'clarify';
        reply.candidates = candidates.map((c) => c.id);
        reply.clarification = {
          field: 'target',
          question: candidates.length > 1 ? '找到多笔，你要改哪一笔？' : '没找到要修改的记录，能说得具体一点吗？',
          options: candidates.map((c) => `${c.occurredDate} ${c.category} ¥${(c.amountCents / 100).toFixed(2)}`),
        };
        break;
      }
      const patch = draft ? {
        amountCents: draft.amountCents,
        category: draft.category,
        type: draft.type,
        occurredDate: draft.occurredDate,
        occurredTime: draft.occurredTime,
        note: draft.note || record.note,
      } : {};
      const updated = store.updateRecord(record.id, patch, null, account ? account.id : null);
      reply.action = 'updated';
      reply.records = [updated];
      reply.text = `已修改为：${iconOf(updated.category)} ${updated.category} ¥${(updated.amountCents / 100).toFixed(2)}（${updated.occurredDate}）`;
      break;
    }
    case 'query': {
      const q = parsed.query || { range: 'all', from: null, to: null, group_by: 'category', filters: {} };
      const range = (q.from || q.to)
        ? { from: q.from || '1970-01-01', to: q.to || tzNow(tz).ymd }
        : presetRange('all', tzNow(tz).ymd);
      const filters = { ...(q.filters || {}), bookId: book.id };
      if (filters.user) {
        const hit = store.listMembers(book.id).find((m) => m.displayName === filters.user);
        if (hit) filters.accountIds = [hit.accountId];
      }
      if (filters.min_amount != null) filters.minCents = Math.round(Number(filters.min_amount) * 100);
      if (filters.max_amount != null) filters.maxCents = Math.round(Number(filters.max_amount) * 100);
      if (filters.category) filters.categories = [filters.category];
      const all = store.listRecords({ bookId: book.id, limit: 20000 });
      const stats = computeStats(all, {
        from: range.from,
        to: range.to,
        filters,
        users: store.listMembers(book.id).map((m) => ({ id: m.accountId, name: m.displayName, emoji: m.emoji })),
        largeThresholdCents: largeThreshold,
      });
      reply.action = 'query';
      reply.query = { ...q, from: range.from, to: range.to };
      reply.summary = stats;
      reply.text = `统计区间 ${range.from} ~ ${range.to}：共 ${stats.count} 笔，支出 ¥${(stats.expenseCents / 100).toFixed(2)}，餐食占比 ${(stats.meal.share * 100).toFixed(1)}%。`;
      break;
    }
    case 'chat': {
      reply.action = 'chat';
      reply.text = '我主要帮你记账：直接说「昨天午饭35」「打车花了28块5」就行，也可以问「这个月花了多少」。';
      break;
    }
    default: {
      const drafts = parsed.records || [];
      if (!drafts.length) {
        reply.action = 'clarify';
        if (!reply.clarification) reply.clarification = { field: 'amount', question: '这笔花了多少钱？', options: [] };
        break;
      }
      const groupId = drafts.length > 1 ? uid('grp') : null;
      const saved = [];
      for (const draft of drafts) {
        const row = draftToRow(draft, {
          bookId: book.id,
          authorAccountId: account ? account.id : null,
          clientMsgId: drafts.length === 1 ? (clientMsgId || null) : null,
          groupId,
          source,
        });
        const rec = store.insertRecord(row);
        saved.push(rec);
        const dup = store.listRecords({
          bookId: book.id, from: rec.occurredDate, to: rec.occurredDate, payerAccountId: rec.payerAccountId, limit: 50,
        }).find((x) => String(x.id) !== String(rec.id) && x.amountCents === rec.amountCents && x.category === rec.category
          && Math.abs(new Date(x.createdAt || Date.now()) - new Date(rec.createdAt || Date.now())) < 5 * 60 * 1000);
        if (dup) reply.warnings.push('这和你刚记的一笔金额、类别都一样，可能是重复记账');
        if ((rec.type === 'expense' || rec.type === 'transfer') && rec.amountCents >= largeThreshold) {
          reply.warnings.push(`这是一笔大额支出（≥¥${(largeThreshold / 100).toFixed(0)}），请确认金额是否正确`);
        }
      }
      reply.action = 'created';
      reply.records = saved;
      reply.text = saved.length === 1
        ? `已记账：${iconOf(saved[0].category)} ${saved[0].category} ¥${(saved[0].amountCents / 100).toFixed(2)}（${saved[0].occurredDate}）`
        : `已记 ${saved.length} 笔，共 ¥${(saved.reduce((a, r) => a + r.amountCents, 0) / 100).toFixed(2)}`;
      break;
    }
  }

  return reply;
}
