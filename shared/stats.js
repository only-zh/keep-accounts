/**
 * 统计聚合：筛选、指标、分类占比、人员排行、日维度、趋势、日历、大额消费。
 * 纯函数，前后端共用（服务端 /api/stats 与前端统计页用的是同一份实现）。
 */

import { MEAL_CATEGORIES, iconOf } from './categories.js';
import { ymdAdd, ymdDiff, monthRange, startOfWeek, weekdayOf, fromYmd } from './date.js';

/** 默认大额阈值：50 元 */
export const DEFAULT_LARGE_CENTS = 5000;

/**
 * 记录是否有效（未删除）
 */
export function isAlive(r) {
  return r && !r.deletedAt && r.status !== 'deleted';
}

/**
 * 按条件筛选记录。
 * @param {any[]} records
 * @param {{
 *   from?:string, to?:string, accountIds?:number[], categories?:string[], types?:string[],
 *   minCents?:number, maxCents?:number, keyword?:string, mealOnly?:boolean, largeOnly?:boolean,
 *   largeThresholdCents?:number, bookId?:number|string, includeDeleted?:boolean,
 *   occurredFrom?:string, occurredTo?:string,
 * }} f
 */
export function filterRecords(records, f = {}) {
  const large = f.largeThresholdCents ?? DEFAULT_LARGE_CENTS;
  const kw = f.keyword ? String(f.keyword).trim().toLowerCase() : '';
  return (records || []).filter((r) => {
    if (!f.includeDeleted && !isAlive(r)) return false;
    if (f.bookId != null && String(r.bookId) !== String(f.bookId)) return false;
    if (f.from && r.occurredDate < f.from) return false;
    if (f.to && r.occurredDate > f.to) return false;
    if (f.occurredFrom && r.occurredDate < f.occurredFrom) return false;
    if (f.occurredTo && r.occurredDate > f.occurredTo) return false;
    if (f.accountIds && f.accountIds.length) {
      const ids = f.accountIds.map(Number);
      const hit = ids.includes(Number(r.payerAccountId))
        || (r.participants || []).some((p) => ids.includes(Number(p.accountId)));
      if (!hit) return false;
    }
    if (f.categories && f.categories.length && !f.categories.includes(r.category)) return false;
    if (f.types && f.types.length && !f.types.includes(r.type)) return false;
    if (f.minCents != null && r.amountCents < f.minCents) return false;
    if (f.maxCents != null && r.amountCents > f.maxCents) return false;
    if (f.mealOnly && !MEAL_CATEGORIES.includes(r.category)) return false;
    if (f.largeOnly && r.amountCents < large) return false;
    if (kw) {
      const hay = `${r.category || ''} ${r.subcategory || ''} ${r.note || ''} ${r.merchant || ''} ${r.rawText || ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
}

/** 上一段等长区间（用于环比） */
export function previousRange(from, to) {
  const len = ymdDiff(to, from) + 1;
  return { from: ymdAdd(from, -len), to: ymdAdd(from, -1), len };
}

/**
 * 计算统计结果。
 * @param {any[]} allRecords 全部记录（函数内部会按 filters 筛选）
 * @param {{
 *   filters?:any, from:string, to:string, users?:any[], compare?:boolean,
 *   largeThresholdCents?:number, meId?:number,
 * }} opts
 */
export function computeStats(allRecords, opts) {
  const filters = opts.filters || {};
  const large = opts.largeThresholdCents ?? filters.largeThresholdCents ?? DEFAULT_LARGE_CENTS;
  const f = { ...filters, from: filters.from ?? opts.from, to: filters.to ?? opts.to, largeThresholdCents: large };
  const rows = filterRecords(allRecords, f);

  const users = opts.users || [];
  const nameOf = (id) => users.find((u) => Number(u.id) === Number(id))?.name || '未知';
  const emojiOf = (id) => users.find((u) => Number(u.id) === Number(id))?.emoji || '🙂';

  const expenseRows = rows.filter((r) => r.type === 'expense' || r.type === 'transfer');
  const incomeRows = rows.filter((r) => r.type === 'income' || r.type === 'refund');
  const sum = (arr) => arr.reduce((a, r) => a + (r.amountCents || 0), 0);

  const expenseCents = sum(expenseRows);
  const incomeCents = sum(incomeRows);
  const totalCents = expenseCents;

  // 分类聚合
  const catMap = new Map();
  for (const r of expenseRows) {
    const key = r.category || '其他';
    const cur = catMap.get(key) || { category: key, icon: iconOf(key), cents: 0, count: 0 };
    cur.cents += r.amountCents;
    cur.count += 1;
    catMap.set(key, cur);
  }
  const byCategory = [...catMap.values()]
    .map((c) => ({ ...c, share: expenseCents ? c.cents / expenseCents : 0 }))
    .sort((a, b) => b.cents - a.cents);

  // 人员聚合：同时给出「谁付的钱」与「谁该承担的份额」
  const userMap = new Map();
  const ensureUser = (id) => {
    const key = Number(id);
    if (!userMap.has(key)) {
      userMap.set(key, {
        accountId: key, name: nameOf(key), emoji: emojiOf(id),
        paidCents: 0, shareCents: 0, cents: 0, count: 0, paidCount: 0,
      });
    }
    return userMap.get(key);
  };
  for (const r of expenseRows) {
    const payer = ensureUser(r.payerAccountId);
    payer.paidCents += r.amountCents;
    payer.paidCount += 1;
    const parts = (r.participants || []).filter((p) => p.shareCents > 0);
    if (parts.length > 1) {
      for (const p of parts) {
        const u = ensureUser(p.accountId);
        u.shareCents += p.shareCents;
        u.count += 1;
      }
    } else {
      payer.shareCents += r.amountCents;
      payer.count += 1;
    }
  }
  const byUser = [...userMap.values()]
    .map((u) => ({ ...u, cents: u.shareCents }))
    .sort((a, b) => b.shareCents - a.shareCents);

  // 按天
  const dayMap = new Map();
  for (const r of rows) {
    const key = r.occurredDate;
    const cur = dayMap.get(key) || { date: key, cents: 0, count: 0, incomeCents: 0 };
    if (r.type === 'income' || r.type === 'refund') cur.incomeCents += r.amountCents;
    else { cur.cents += r.amountCents; cur.count += 1; }
    dayMap.set(key, cur);
  }
  const from = f.from || (rows.length ? rows.map((r) => r.occurredDate).sort()[0] : opts.from);
  const to = f.to || (rows.length ? rows.map((r) => r.occurredDate).sort().slice(-1)[0] : opts.to);
  const byDay = fillDays(dayMap, from, to);

  // 星期分布
  const byWeekday = Array.from({ length: 7 }, (_, i) => ({ weekday: i, label: `周${'日一二三四五六'[i]}`, cents: 0, count: 0 }));
  for (const d of byDay) {
    const wd = weekdayOf(d.date);
    byWeekday[wd].cents += d.cents;
    byWeekday[wd].count += d.count;
  }

  // 餐食
  const mealRows = expenseRows.filter((r) => MEAL_CATEGORIES.includes(r.category));
  const mealCents = sum(mealRows);

  // 大额
  const largeRows = expenseRows.filter((r) => r.amountCents >= large).sort((a, b) => b.amountCents - a.amountCents);
  const largeCents = sum(largeRows);

  // 极值
  const maxRow = expenseRows.slice().sort((a, b) => b.amountCents - a.amountCents)[0] || null;
  const days = Math.max(1, ymdDiff(to, from) + 1);

  // 环比
  let compare = null;
  if (opts.compare !== false && f.from && f.to) {
    const prev = previousRange(f.from, f.to);
    const prevRows = filterRecords(allRecords, { ...filters, from: prev.from, to: prev.to, largeThresholdCents: large });
    const prevCents = prevRows.filter((r) => r.type === 'expense' || r.type === 'transfer')
      .reduce((a, r) => a + r.amountCents, 0);
    compare = {
      from: prev.from, to: prev.to, cents: prevCents,
      deltaCents: expenseCents - prevCents,
      deltaPct: prevCents > 0 ? (expenseCents - prevCents) / prevCents : null,
    };
  }

  // 日历（按天）
  const calendar = {};
  for (const d of byDay) calendar[d.date] = { value: d.cents, count: d.count };

  const top = rows.slice().sort((a, b) => b.amountCents - a.amountCents).slice(0, 5);

  return {
    range: { from, to, days },
    count: rows.length,
    expenseCount: expenseRows.length,
    totalCents,
    expenseCents,
    incomeCents,
    netCents: incomeCents - expenseCents,
    avgPerDayCents: Math.round(expenseCents / days),
    avgPerRecordCents: expenseRows.length ? Math.round(expenseCents / expenseRows.length) : 0,
    meal: { cents: mealCents, share: expenseCents ? mealCents / expenseCents : 0, count: mealRows.length },
    large: { thresholdCents: large, cents: largeCents, count: largeRows.length, records: largeRows, share: expenseCents ? largeCents / expenseCents : 0 },
    maxRecord: maxRow,
    byCategory,
    byUser,
    byDay,
    byWeekday,
    calendar,
    compare,
    top,
    records: rows,
  };
}

/** 把稀疏的按天数据补齐为连续日期序列 */
export function fillDays(dayMap, from, to) {
  if (!from || !to) return [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const out = [];
  const total = Math.max(0, ymdDiff(to, from));
  for (let i = 0; i <= total; i += 1) {
    const date = ymdAdd(from, i);
    const hit = dayMap.get(date);
    out.push(hit || { date, cents: 0, count: 0, incomeCents: 0 });
  }
  return out;
}

/** 常用区间预设 */
export function presetRange(key, today) {
  const thisMonth = monthRange(today);
  const monday = startOfWeek(today);
  switch (key) {
    case 'today': return { from: today, to: today, label: '今天' };
    case 'yesterday': return { from: ymdAdd(today, -1), to: ymdAdd(today, -1), label: '昨天' };
    case 'week': return { from: monday, to: ymdAdd(monday, 6), label: '本周' };
    case 'last_week': { const s = ymdAdd(monday, -7); return { from: s, to: ymdAdd(s, 6), label: '上周' }; }
    case 'month': return { ...thisMonth, label: '本月' };
    case 'last_month': {
      const { y, m } = fromYmd(today);
      const base = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
      return { ...monthRange(base), label: '上个月' };
    }
    case 'year': return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31`, label: '今年' };
    case 'last7': return { from: ymdAdd(today, -6), to: today, label: '近 7 天' };
    case 'last30': return { from: ymdAdd(today, -29), to: today, label: '近 30 天' };
    case 'all': default: return { from: '1970-01-01', to: today, label: '全部' };
  }
}
