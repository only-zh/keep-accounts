/**
 * 日期 / 时间 / 区间解析：把「昨天」「上周三」「10月1号」「这个月」这类口语表达
 * 解析为带时区（默认 Asia/Shanghai）的 YYYY-MM-DD。
 * 零依赖纯函数，Node 与浏览器通用。
 */

export const TZ_DEFAULT = 'Asia/Shanghai';

const CN_NUM = '零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾';

/** 把日期格式化为 YYYY-MM-DD（UTC 安全的纯日期运算） */
export function toYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** 解析 YYYY-MM-DD → {y,m,d} */
export function fromYmd(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return { y, m, d };
}

/** 日期加减天数 */
export function ymdAdd(ymd, days) {
  const { y, m, d } = fromYmd(ymd);
  return toYmd(y, m, d + days);
}

/** 日期加减月数（自动处理月末） */
export function ymdAddMonths(ymd, months) {
  const { y, m, d } = fromYmd(ymd);
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  return toYmd(base.getUTCFullYear(), base.getUTCMonth() + 1, Math.min(d, lastDay));
}

/** 两个日期相差天数 (a - b) */
export function ymdDiff(a, b) {
  const A = Date.UTC(...Object.values(fromYmd(a)).map((v, i) => (i === 1 ? v - 1 : v)));
  const B = Date.UTC(...Object.values(fromYmd(b)).map((v, i) => (i === 1 ? v - 1 : v)));
  return Math.round((A - B) / 86400000);
}

/** 星期几：0=周日 … 6=周六 */
export function weekdayOf(ymd) {
  const { y, m, d } = fromYmd(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 本周一 */
export function startOfWeek(ymd) {
  const wd = (weekdayOf(ymd) + 6) % 7; // 周一=0
  return ymdAdd(ymd, -wd);
}

/** 某月天数 */
export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 某月第一天 / 最后一天 */
export function monthRange(ymd) {
  const { y, m } = fromYmd(ymd);
  return { from: toYmd(y, m, 1), to: toYmd(y, m, daysInMonth(y, m)) };
}

/**
 * 取指定时区的「现在」。
 * @param {string} tz
 * @param {Date} [date]
 */
export function tzNow(tz = TZ_DEFAULT, date = new Date()) {
  const parts = {};
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    });
  }
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    tz,
    ymd,
    hour,
    minute: Number(parts.minute),
    hm: `${String(hour).padStart(2, '0')}:${String(Number(parts.minute)).padStart(2, '0')}`,
    weekday: weekdayOf(ymd),
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
  };
}

/** 中文数字或阿拉伯数字 → 数字 */
function anyNum(s) {
  if (s === undefined || s === null || s === '') return NaN;
  if (/^[0-9]+$/.test(s)) return Number(s);
  const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (s in map) return map[s];
  if (s === '十一') return 11;
  if (s === '十二') return 12;
  return NaN;
}

const WEEKDAY_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7 };

function parseWeekday(ch) {
  if (!ch) return NaN;
  if (/^[1-7]$/.test(ch)) return Number(ch);
  return WEEKDAY_MAP[ch] ?? NaN;
}

/**
 * 解析时间点（不改变日期），返回 HH:MM 或 null。
 * @param {string} text
 */
export function resolveTime(text) {
  const t = String(text || '');
  let m;
  if ((m = t.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/))) {
    return `${String(Math.min(23, Number(m[1]))).padStart(2, '0')}:${String(Math.min(59, Number(m[2]))).padStart(2, '0')}`;
  }
  if ((m = t.match(/(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*点\s*(半|(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分?)?/))) {
    let h = anyNum(m[1]);
    let mi = m[2] === '半' ? 30 : anyNum(m[3]);
    if (!Number.isFinite(mi)) mi = 0;
    if (Number.isFinite(h)) {
      if (/下午|晚上|傍晚|夜里|晚间/.test(t) && h < 12) h += 12;
      if (/凌晨|半夜|深夜/.test(t) && h === 12) h = 0;
      if (h >= 0 && h <= 23) return `${String(h).padStart(2, '0')}:${String(Math.min(59, mi)).padStart(2, '0')}`;
    }
  }
  if (/凌晨|半夜|深夜/.test(t)) return '00:30';
  if (/早上|早晨|一早|上午|早餐|早饭/.test(t)) return '08:00';
  if (/中午|正午|午餐|午饭/.test(t)) return '12:00';
  if (/下午|午后/.test(t)) return '14:00';
  if (/傍晚|黄昏|晚饭|晚餐/.test(t)) return '18:30';
  if (/晚上|夜里|夜晚|晚间|今晚|宵夜|夜宵/.test(t)) return '20:00';
  return null;
}

/**
 * 解析日期（相对「今天」）。
 * @param {string} text 归一化后的文本
 * @param {ReturnType<typeof tzNow>} now
 * @returns {{date:string, time:string|null, matched:string, granularity:'day', assumed:boolean, future:boolean, offsetDays:number}}
 */
export function resolveDate(text, now) {
  const t = String(text || '');
  const today = now.ymd;
  let date = null;
  let matched = '';
  let assumed = false;
  let offsetDays = 0;

  const set = (ymd, tag) => { if (date === null) { date = ymd; matched = tag; } };

  // 绝对日期：2024年10月1日 / 2024-10-01
  let m;
  if ((m = t.match(/(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/))) {
    set(toYmd(Number(m[1]), Number(m[2]), Number(m[3])), m[0]);
  }
  if (date === null && (m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/))) {
    const mm = Number(m[1]); const dd = Number(m[2]);
    let cand = toYmd(now.y, mm, dd);
    if (ymdDiff(cand, today) > 0) cand = toYmd(now.y - 1, mm, dd); // 未来日期视为去年
    set(cand, m[0]);
  }
  if (date === null && (m = t.match(/(\d{1,2})\s*月(?![日月])/))) {
    set(toYmd(now.y, Number(m[1]), 1), m[0]);
  }

  // 相对日
  if (date === null) {
    if (/大前天/.test(t)) { offsetDays = -3; set(ymdAdd(today, -3), '大前天'); }
    else if (/前天/.test(t)) { offsetDays = -2; set(ymdAdd(today, -2), '前天'); }
    else if (/昨天|昨儿|昨日|昨晚|昨晚上/.test(t)) { offsetDays = -1; set(ymdAdd(today, -1), '昨天'); }
    else if (/明天|明日|明儿/.test(t)) { offsetDays = 1; set(ymdAdd(today, 1), '明天'); }
    else if (/后天/.test(t)) { offsetDays = 2; set(ymdAdd(today, 2), '后天'); }
    else if (/今天|今日|今儿|今晚|刚刚|刚才|这会儿/.test(t)) { set(today, '今天'); }
  }
  if (date === null && (m = t.match(new RegExp(`([0-9]+|[${CN_NUM}]+)\\s*天\\s*(前|以前)`)))) {
    const n = anyNum(m[1]);
    if (Number.isFinite(n)) { offsetDays = -n; set(ymdAdd(today, -n), m[0]); }
  }
  if (date === null && (m = t.match(new RegExp(`([0-9]+|[${CN_NUM}]+)\\s*天\\s*后`)))) {
    const n = anyNum(m[1]);
    if (Number.isFinite(n)) { offsetDays = n; set(ymdAdd(today, n), m[0]); }
  }
  if (date === null && (m = t.match(new RegExp(`([0-9]+|[${CN_NUM}]+)\\s*(个)?\\s*星期\\s*(前|以前)`)))) {
    const n = anyNum(m[1]);
    if (Number.isFinite(n)) { offsetDays = -7 * n; set(ymdAdd(today, -7 * n), m[0]); }
  }

  // 周：上周三 / 这周三 / 周三
  if (date === null && (m = t.match(/(上上|上|这|本|下)?\s*(?:个)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])?/))) {
    const prefix = m[1] || '';
    const wd = parseWeekday(m[2]);
    const thisMonday = startOfWeek(today);
    if (Number.isFinite(wd)) {
      const base = prefix === '上' ? ymdAdd(thisMonday, -7)
        : prefix === '上上' ? ymdAdd(thisMonday, -14)
          : prefix === '下' ? ymdAdd(thisMonday, 7)
            : thisMonday; // 本周 / 无前缀
      set(ymdAdd(base, wd - 1), m[0]);
    } else if (prefix === '上' || prefix === '上上' || prefix === '下') {
      const base = prefix === '上' ? ymdAdd(thisMonday, -7) : prefix === '上上' ? ymdAdd(thisMonday, -14) : ymdAdd(thisMonday, 7);
      set(base, m[0]);
    } else if (prefix === '这' || prefix === '本' || /周|星期|礼拜/.test(m[0])) {
      set(thisMonday, m[0]);
    }
  }

  // 月：上个月 / 这个月 / 上个月 15 号
  if (date === null && (m = t.match(/(上上|上|这|本|下)?\s*(?:个)?\s*月\s*(?:初|底)?\s*([0-9]{1,2}|[零〇一二两三四五六七八九十]{1,3})?\s*[日号]?/))) {
    const prefix = m[1] || '';
    const dayStr = m[2];
    if (prefix || dayStr) {
      const base = prefix === '上' ? ymdAddMonths(today, -1)
        : prefix === '上上' ? ymdAddMonths(today, -2)
          : prefix === '下' ? ymdAddMonths(today, 1)
            : today;
      let d = Number.isFinite(anyNum(dayStr)) ? anyNum(dayStr) : null;
      if (/月初/.test(m[0])) d = 1;
      if (/月底/.test(m[0])) d = daysInMonth(Number(base.slice(0, 4)), Number(base.slice(5, 7)));
      set(d ? ymdAddMonths(base, 0).replace(/-\d{2}$/, `-${String(d).padStart(2, '0')}`) : base, m[0]);
    }
  }

  // N 号 / N 日（本月，若未来则上月）
  if (date === null && (m = t.match(/([0-9]{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*[日号]/))) {
    const d = anyNum(m[1]);
    if (Number.isFinite(d) && d >= 1 && d <= 31) {
      let cand = toYmd(now.y, now.m, d);
      if (ymdDiff(cand, today) > 0) cand = ymdAddMonths(cand, -1);
      set(cand, m[0]);
    }
  }

  // 去年 / 今年 / 明年
  if (date === null && (m = t.match(/(去年|前年|今年|明年|去年底)/))) {
    const y = m[1] === '去年' ? now.y - 1 : m[1] === '前年' ? now.y - 2 : m[1] === '明年' ? now.y + 1 : now.y;
    set(toYmd(y, now.m, now.d), m[1]);
  }

  if (date === null) {
    date = today;
    assumed = true;
  }

  const time = resolveTime(t);
  const future = ymdDiff(date, today) > 0;
  return { date, time, matched, granularity: 'day', assumed, future, offsetDays };
}

/**
 * 解析时间区间（用于查询意图）。返回 null 表示没有明确区间。
 * @param {string} text
 * @param {ReturnType<typeof tzNow>} now
 * @returns {{from:string, to:string, label:string}|null}
 */
export function resolveRange(text, now) {
  const t = String(text || '');
  const today = now.ymd;
  const thisMonth = monthRange(today);
  const thisWeek = { from: startOfWeek(today), to: ymdAdd(startOfWeek(today), 6) };
  let m;

  if (/今天|今日|今儿/.test(t)) return { from: today, to: today, label: '今天' };
  if (/昨天|昨日|昨儿/.test(t)) return { from: ymdAdd(today, -1), to: ymdAdd(today, -1), label: '昨天' };
  if (/前天/.test(t)) return { from: ymdAdd(today, -2), to: ymdAdd(today, -2), label: '前天' };
  if (/本周|这周|这个?星期|这个?礼拜/.test(t)) return { ...thisWeek, label: '本周' };
  if (/上周|上个星期|上个礼拜/.test(t)) {
    const s = ymdAdd(thisWeek.from, -7);
    return { from: s, to: ymdAdd(s, 6), label: '上周' };
  }
  if (/本月|这个?月|当月/.test(t)) return { ...thisMonth, label: '本月' };
  if (/上个?月|上月/.test(t)) {
    const { y, m: mm } = fromYmd(today);
    const base = mm === 1 ? toYmd(y - 1, 12, 1) : toYmd(y, mm - 1, 1);
    return { ...monthRange(base), label: '上个月' };
  }
  if ((m = t.match(new RegExp(`(?:最近|近|过去)\\s*([0-9]+|[${CN_NUM}]+)\\s*天`)))) {
    const n = anyNum(m[1]);
    if (Number.isFinite(n)) return { from: ymdAdd(today, -(n - 1)), to: today, label: `近${n}天` };
  }
  if ((m = t.match(new RegExp(`(?:最近|近|过去)\\s*([0-9]+|[${CN_NUM}]+)\\s*(?:个)?\\s*月`)))) {
    const n = anyNum(m[1]);
    if (Number.isFinite(n)) return { from: ymdAddMonths(thisMonth.from, -(n - 1)), to: thisMonth.to, label: `近${n}个月` };
  }
  if ((m = t.match(new RegExp(`([0-9]+|[${CN_NUM}]+)\\s*月\\s*([0-9]+|[${CN_NUM}]+)?\\s*[日号]?\\s*(?:到|至|-|~)\\s*([0-9]+|[${CN_NUM}]+)\\s*月\\s*([0-9]+|[${CN_NUM}]+)\\s*[日号]?`)))) {
    const r = resolveDate(`${m[1]}月${m[2] ?? 1}日`, now);
    const r2 = resolveDate(`${m[3]}月${m[4]}日`, now);
    return { from: r.date, to: r2.date, label: `${r.date} ~ ${r2.date}` };
  }
  if ((m = t.match(/(20\d{2})年/))) return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31`, label: `${m[1]}年` };
  if (/今年/.test(t)) return { from: `${now.y}-01-01`, to: today, label: '今年' };
  if (/去年/.test(t)) return { from: `${now.y - 1}-01-01`, to: `${now.y - 1}-12-31`, label: '去年' };
  if (/全年|所有|全部|总共|一共|累计|历史/.test(t)) return null;

  const d = resolveDate(t, now);
  if (!d.assumed && d.matched) return { from: d.date, to: d.date, label: d.matched };
  return null;
}
