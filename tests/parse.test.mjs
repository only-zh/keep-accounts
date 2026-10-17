/**
 * 解析回归用例（零依赖断言）。
 * 用法：node tests/parse.test.mjs
 *
 * 这些用例覆盖「没有大模型时的规则兜底」路径；同一个用例集在有 Key 时也可以
 * 通过 `--llm` 走真实模型（见 tests/llm-eval.mjs）。
 */

import { cnToNumber, normalizeText, normalizeAmounts } from '../shared/normalize.js';
import { resolveDate, resolveRange, tzNow, ymdAdd, startOfWeek, monthRange } from '../shared/date.js';
import { fallbackParse, extractAmount, makeCtx, detectIntent, coerceResult } from '../shared/parse-core.js';
import { computeStats, filterRecords, presetRange } from '../shared/stats.js';

let pass = 0;
let fail = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label}\n    期望: ${b}\n    实际: ${a}`);
  }
}
function ok(cond, label) {
  if (cond) pass += 1;
  else { fail += 1; failures.push(label); }
}

/* ---------------- 中文数字 ---------------- */
eq(cnToNumber('三十五'), 35, 'cnToNumber 三十五');
eq(cnToNumber('两百'), 200, 'cnToNumber 两百');
eq(cnToNumber('一万二'), 12000, 'cnToNumber 一万二（口语省略）');
eq(cnToNumber('三千五'), 3500, 'cnToNumber 三千五');
eq(cnToNumber('一万零五'), 10005, 'cnToNumber 一万零五');
eq(cnToNumber('十五'), 15, 'cnToNumber 十五');
eq(cnToNumber('一百二十'), 120, 'cnToNumber 一百二十');
eq(cnToNumber('12.5'), 12.5, 'cnToNumber 阿拉伯小数');

/* ---------------- 金额归一化 ---------------- */
eq(normalizeAmounts('三十五块五'), '35.5元', '口语金额 三十五块五');
eq(extractAmount(normalizeText('三十五块五').text).cents, 3550, 'extractAmount 三十五块五');
eq(extractAmount(normalizeText('午饭三十五').text)?.cents, 3500, 'extractAmount 午饭三十五（无单位）');
eq(extractAmount('打车28块5').cents, 2850, 'extractAmount 28块5');
eq(extractAmount('买了瓶水 2.5元').cents, 250, 'extractAmount 2.5元');
eq(extractAmount('这个月话费100').cents, 10000, 'extractAmount 话费100');

/* ---------------- 日期 ---------------- */
const NOW = tzNow('Asia/Shanghai', new Date('2025-10-13T04:00:00Z')); // 2025-10-13 12:00 +08，周一
eq(NOW.ymd, '2025-10-13', 'tzNow 东八区日期');
eq(NOW.weekday, 1, 'tzNow 周一');
eq(resolveDate('今天午饭', NOW).date, '2025-10-13', '日期 今天');
eq(resolveDate('昨天晚上吃火锅', NOW).date, '2025-10-12', '日期 昨天');
eq(resolveDate('前天', NOW).date, '2025-10-11', '日期 前天');
eq(resolveDate('3天前', NOW).date, '2025-10-10', '日期 3天前');
eq(resolveDate('上周三', NOW).date, '2025-10-08', '日期 上周三');
eq(resolveDate('周五', NOW).date, '2025-10-17', '日期 周五（本周）');
eq(resolveDate('9月28号', NOW).date, '2025-09-28', '日期 9月28号');
eq(resolveDate('上个月15号', NOW).date, '2025-09-15', '日期 上个月15号');
eq(resolveDate('15号', NOW).date, '2025-09-15', '日期 15号（已过则为本月，未到取本月）');
eq(resolveDate('今天午饭', NOW).assumed, false, '日期 显式给出不算 assumed');
eq(resolveDate('午饭35', NOW).assumed, true, '日期 未提及算 assumed');
eq(resolveRange('这个月', NOW).from, '2025-10-01', '区间 本月起');
eq(resolveRange('上周', NOW).from, '2025-10-06', '区间 上周起');
eq(resolveRange('近7天', NOW).from, '2025-10-07', '区间 近7天');
ok(resolveRange('全部', NOW) === null, '区间 全部 → null（不限）');

/* ---------------- 兜底解析 ---------------- */
const ctx = makeCtx({
  now: NOW,
  users: [{ id: 1, name: '我' }, { id: 2, name: '张三' }, { id: 3, name: '李四' }],
  currentUser: { id: 1, name: '我' },
});

{
  const r = fallbackParse('昨天午饭35', ctx);
  eq(r.records.length, 1, '兜底 昨天午饭35 出一笔');
  eq(r.records[0].amountCents, 3500, '兜底 昨天午饭35 金额');
  eq(r.records[0].category, '餐饮', '兜底 昨天午饭35 类别');
  eq(r.records[0].occurredDate, '2025-10-12', '兜底 昨天午饭35 日期');
  eq(r.records[0].payerAccountId, 1, '兜底 默认付款人=当前用户');
}
{
  const r = fallbackParse('打车花了28块5', ctx);
  eq(r.records[0].amountCents, 2850, '兜底 打车花了28块5 金额');
  eq(r.records[0].category, '交通', '兜底 打车 类别');
}
{
  const r = fallbackParse('发工资8000', ctx);
  eq(r.records[0].type, 'income', '兜底 发工资 → income');
  eq(r.records[0].category, '收入', '兜底 发工资 → 类别 收入');
  eq(r.records[0].amountCents, 800000, '兜底 发工资 金额');
}
{
  const r = fallbackParse('@张三 火锅240 AA', ctx);
  eq(r.records[0].amountCents, 24000, '兜底 @张三 火锅240 金额');
  eq(r.records[0].payerAccountId, 2, '兜底 @张三 → 付款人张三');
  eq(r.records[0].category, '餐饮', '兜底 火锅 → 餐饮');
}
{
  const r = fallbackParse('帮我记一下 电影票 两张 90', ctx);
  eq(r.records[0].category, '娱乐', '兜底 电影票 → 娱乐');
  eq(r.records[0].amountCents, 9000, '兜底 电影票 金额取 90 而不是 两');
}
{
  const r = fallbackParse('这个月吃饭花了多少', ctx);
  eq(r.intent, 'query', '兜底 查询意图');
  eq(r.query.from, '2025-10-01', '兜底 查询区间=本月');
  ok(r.query.group_by === 'category', '兜底 查询分组=category');
}
eq(fallbackParse('撤销', ctx).intent, 'undo', '兜底 撤销意图');
eq(fallbackParse('把刚才那笔改成35', ctx).intent, 'update_record', '兜底 修改意图');
eq(fallbackParse('删掉打车那条', ctx).intent, 'delete_record', '兜底 删除意图');
{
  const r = fallbackParse('今天心情不错', ctx);
  ok(r.clarification && r.clarification.field === 'amount', '兜底 无金额 → 追问金额');
}

/* ---------------- coerceResult 校验 ---------------- */
{
  const raw = {
    intent: 'add_record',
    records: [
      { type: 'expense', amount: 35.5, category: '餐饮', subcategory: '午餐', date_iso: '2025-10-12', payer: '张三', confidence: 0.9 },
      { type: 'expense', amount: null, category: '交通' },
      { type: 'expense', amount: 20, category: '不存在的类别', note: '打车', date_iso: '2030-01-01' },
    ],
  };
  const r = coerceResult(raw, { text: '昨天午饭35.5，打车20', ctx });
  eq(r.records.length, 2, 'coerce 丢弃无金额的记录');
  eq(r.records[0].amountCents, 3550, 'coerce 元→分');
  eq(r.records[0].payerAccountId, 2, 'coerce payer 名字→id');
  eq(r.records[1].category, '交通', 'coerce 非法类别 → 关键词兜底');
  eq(r.records[1].occurredDate, '2025-10-13', 'coerce 未来日期 → 今天');
  ok(r.warnings.some((w) => w.includes('跳过')), 'coerce 记录警告：跳过无金额');
}
{
  const r = coerceResult({ intent: 'add_record', records: [] }, { text: '午饭', ctx });
  ok(r.clarification && r.clarification.field === 'amount', 'coerce 空 records → 追问');
}

/* ---------------- 统计 ---------------- */
{
  const recs = [
    { id: 1, bookId: 1, payerAccountId: 1, type: 'expense', amountCents: 3000, category: '餐饮', occurredDate: '2025-10-01', status: 'confirmed', participants: [] },
    { id: 2, bookId: 1, payerAccountId: 1, type: 'expense', amountCents: 2000, category: '交通', occurredDate: '2025-10-02', status: 'confirmed', participants: [] },
    { id: 3, bookId: 1, payerAccountId: 2, type: 'expense', amountCents: 8000, category: '餐饮', occurredDate: '2025-10-03', status: 'confirmed', participants: [{ accountId: 2, name: '张三', shareCents: 4000 }, { accountId: 1, name: '我', shareCents: 4000 }] },
    { id: 4, bookId: 1, payerAccountId: 1, type: 'expense', amountCents: 6000, category: '购物', occurredDate: '2025-10-04', status: 'confirmed', participants: [] },
    { id: 5, bookId: 1, payerAccountId: 1, type: 'income', amountCents: 500000, category: '收入', occurredDate: '2025-10-04', status: 'confirmed', participants: [] },
    { id: 6, bookId: 1, payerAccountId: 1, type: 'expense', amountCents: 999, category: '餐饮', occurredDate: '2025-09-30', status: 'deleted', participants: [] },
  ];
  const users = [{ id: 1, name: '我', emoji: '🙂' }, { id: 2, name: '张三', emoji: '🐯' }];
  const s = computeStats(recs, { from: '2025-10-01', to: '2025-10-31', users, filters: { bookId: 1 } });
  eq(s.expenseCents, 19000, 'stats 支出总额（剔除已删除）');
  eq(s.incomeCents, 500000, 'stats 收入总额');
  eq(s.count, 5, 'stats 记录笔数');
  eq(s.meal.cents, 11000, 'stats 餐食总额');
  eq(Math.round(s.meal.share * 100), 58, 'stats 餐食占比');
  eq(s.byCategory[0].category, '餐饮', 'stats 分类第一=餐饮');
  eq(s.large.count, 2, 'stats 大额（>=50）笔数：80 与 60');
  eq(s.byDay.length, 31, 'stats 按天补齐到整月');
  eq(s.byDay[0].date, '2025-10-01', 'stats 第一天');
  const me = s.byUser.find((u) => u.accountId === 1);
  eq(me.paidCents, 11000, 'stats 我付的钱');
  eq(me.shareCents, 15000, 'stats 我该承担的（含 40 分摊）');
  eq(s.maxRecord.id, 3, 'stats 最大一笔');
  eq(s.compare.cents, 0, 'stats 上月同期为 0');
  eq(filterRecords(recs, { from: '2025-10-01', to: '2025-10-31' }).length, 5, 'filter 时间区间');
  eq(filterRecords(recs, { keyword: '打车' }).length, 0, 'filter 关键词（备注为空）');
  eq(presetRange('last30', '2025-10-13').from, '2025-09-14', 'presetRange last30');
}

/* ---------------- 输出 ---------------- */
console.log(`\n解析回归：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
} else {
  console.log('全部通过 ✅');
}
