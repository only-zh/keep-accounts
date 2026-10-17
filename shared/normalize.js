/**
 * 文本归一化：全角转半角、中文数字转阿拉伯数字、口语金额单位换算、语气词清理。
 * 零依赖，Node 与浏览器通用。
 */

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const CN_UNITS = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const CN_BIG = { 万: 10000, 萬: 10000, 亿: 100000000, 億: 100000000 };
const CN_ALL = '零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万萬亿億';
const CN_SMALL = '零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖';

/**
 * 中文数字 → 阿拉伯数字。支持「三十五」「两百」「一万二」「十五」「一万零五」。
 * @param {string} str
 * @returns {number} 无法解析返回 NaN
 */
export function cnToNumber(str) {
  const s = String(str || '').trim();
  if (!s) return NaN;
  if (/^[0-9]+(\.[0-9]+)?$/.test(s)) return Number(s);

  let total = 0;
  let section = 0;
  let num = 0;
  let lastBig = 0;
  let lastUnit = 0;
  let sawZero = false;
  let sawAny = false;

  for (const ch of s) {
    if (ch in CN_DIGITS) {
      num = CN_DIGITS[ch];
      if (ch === '零' || ch === '〇') sawZero = true;
      sawAny = true;
    } else if (ch in CN_UNITS) {
      const u = CN_UNITS[ch];
      if (num === 0) num = 1; // 十五 → 15
      section += num * u;
      num = 0;
      lastUnit = u;
      sawAny = true;
    } else if (ch in CN_BIG) {
      const b = CN_BIG[ch];
      section = (section + num) * b;
      total += section;
      section = 0;
      num = 0;
      lastBig = b;
      sawZero = false;
      sawAny = true;
    } else {
      return NaN; // 出现无法识别的字符，交给调用方放弃
    }
  }
  // 口语省略：「一万二」= 12000，「三千五」= 3500，「一百二」= 120
  // 「零」出现时视为明确断句（一万零五 = 10005），不做省略推断
  if (num > 0 && !sawZero) {
    if (lastBig > 0 && section === 0) {
      total += num * (lastBig / 10);
      num = 0;
    } else if (lastUnit > 0) {
      section += num * (lastUnit / 10);
      num = 0;
    }
  }
  const result = total + section + num;
  return sawAny ? result : NaN;
}

/** 全角 → 半角，统一标点与空白 */
export function toHalfWidth(text) {
  let s = String(text || '');
  try {
    s = s.normalize('NFKC');
  } catch {
    /* 老环境忽略 */
  }
  return s;
}

const FILLER_PATTERNS = [
  /(帮我|帮忙|麻烦|请|给我|替我)?(记一笔|记一下|记个账|记账|记录一下|记上|记录|添加一笔|加一笔)/g,
  /^(那个|就是|然后|呃|嗯|额|emmm|em|啊)+/g,
  /(一下|一笔|一条)$/g,
];

/**
 * 口语金额归一化：
 *  三十五块五   → 35.5
 *  三块五毛二   → 3.52
 *  五毛         → 0.5
 *  一万二       → 12000
 * 只改写「带金额单位」的片段，避免误伤「一起」「十一」等普通词。
 * @param {string} text
 */
export function normalizeAmounts(text) {
  let s = text;

  // ① 中文数字 + 元/块 + 中文/阿拉伯小数（口语「块五」= 5 角）
  const yuanRe = new RegExp(`([${CN_ALL}]+|[0-9]+(?:\\.[0-9]+)?)\\s*(块钱|块|元|圆|rmb|RMB)`, 'g');
  s = s.replace(yuanRe, (m, numStr, unit) => {
    let val = cnToNumber(numStr);
    if (!Number.isFinite(val)) return m;
    return `${trimNum(val)}${unit === '块钱' ? '块' : unit}`;
  });

  // ② 元后面的尾数统一改写成小数形式，避免「35块5」这种歧义写法：
  //    35块5 → 35.5元 ; 35块5毛 → 35.5元 ; 3块5毛2 → 3.52元 ; 3元5分 → 3.05元
  const DEC = `([0-9]|[${CN_SMALL}])`;
  const YUAN = '(?:块钱|块|元|圆)';
  const jiaoFenRe = new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${YUAN}\\s*${DEC}\\s*(?:毛|角)\\s*(?:${DEC}\\s*分?)?`, 'g');
  s = s.replace(jiaoFenRe, (m, intPart, jiao, fen) => {
    const jv = cnToNumber(jiao);
    if (!Number.isFinite(jv)) return m;
    let dec = String(jv);
    if (fen !== undefined) {
      const fv = cnToNumber(fen);
      if (Number.isFinite(fv)) dec += String(fv);
    }
    return `${trimNum(Number(intPart) + Number(`0.${dec}`))}元`;
  });
  const fenRe = new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${YUAN}\\s*${DEC}\\s*分`, 'g');
  s = s.replace(fenRe, (m, intPart, fen) => {
    const fv = cnToNumber(fen);
    if (!Number.isFinite(fv)) return m;
    return `${trimNum(Number(intPart) + fv / 100)}元`;
  });
  const bareTailRe = new RegExp(
    `([0-9]+(?:\\.[0-9]+)?)\\s*${YUAN}\\s*${DEC}(?![0-9${CN_SMALL}]|个|位|人|月|日|号|点|次|折|楼|路|公里|岁|克|斤)`,
    'g',
  );
  s = s.replace(bareTailRe, (m, intPart, jiao) => {
    const jv = cnToNumber(jiao);
    if (!Number.isFinite(jv) || jv > 9) return m;
    return `${trimNum(Number(intPart) + jv / 10)}元`;
  });

  // ③ 单独的毛/角/分：「五毛」→ 0.5 ；「三毛五」→ 0.35
  const jiaoRe = new RegExp(`(^|[^0-9.])(${CN_SMALL}+|[0-9]+)\\s*(毛|角)(${CN_SMALL}|[0-9])?`, 'g');
  s = s.replace(jiaoRe, (m, pre, jiaoStr, unit, fenStr) => {
    const jv = cnToNumber(jiaoStr);
    if (!Number.isFinite(jv) || jv > 9) return m;
    let out = `${jv / 10}`;
    if (fenStr !== undefined) {
      const fv = cnToNumber(fenStr);
      if (Number.isFinite(fv) && fv <= 9) out = String(jv / 10 + fv / 100);
    }
    return `${pre}${out}元`;
  });

  return s;
}

/**
 * 整句里完全没有阿拉伯数字时，把句尾的中文数字也转成阿拉伯数字。
 * 「午饭三十五」→「午饭35」；「一起吃饭」里的「一」不在句尾，不受影响。
 */
export function normalizeBareNumbers(text) {
  const s = String(text || '');
  if (/[0-9]/.test(s)) return s;
  return s.replace(new RegExp(`([${CN_ALL}]+)(?=\\s*(?:[，。,.!！?？、]|$))`, 'g'), (m0, numStr) => {
    const v = cnToNumber(numStr);
    return Number.isFinite(v) ? String(v) : m0;
  });
}

/** 去掉浮点误差尾巴 */
function trimNum(n) {
  return String(Math.round(n * 100) / 100);
}

/** 把不带单位、但明显是金额的阿拉伯数字片段保留原样（占位，便于阅读） */

/**
 * 主入口：归一化一段用户输入。
 * @param {string} raw
 * @returns {{text:string, raw:string, notes:string[]}}
 */
export function normalizeText(raw) {
  const notes = [];
  let s = toHalfWidth(String(raw || ''));
  s = s.replace(/\s+/g, ' ').trim();
  const before = s;
  s = normalizeAmounts(s);
  s = normalizeBareNumbers(s);
  if (s !== before) notes.push('amount-unit-normalized');

  for (const re of FILLER_PATTERNS) {
    const b = s;
    s = s.replace(re, '');
    if (s !== b) notes.push('filler-removed');
  }
  s = s.replace(/\s+/g, ' ').trim();
  return { text: s, raw: String(raw || ''), notes };
}

/** 从一段文本里找「像金额」的数字（含小数），返回 {value, index, text} 列表（单位：元） */
export function findAmounts(text) {
  const out = [];
  const re = /([0-9]+(?:\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = Number(m[1]);
    if (!Number.isFinite(v)) continue;
    out.push({ value: v, index: m.index, text: m[1] });
  }
  return out;
}
