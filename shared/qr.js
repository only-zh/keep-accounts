/**
 * 极简二维码编码器（零依赖）：字节模式 + 纠错等级 L + 版本 1~4。
 *
 * 为什么只做到版本 4：本项目只需要编码 8 位邀请码（或类似短文本），
 * 版本 4 在 L 级下能放 80 字节，完全够用；范围越小，实现越可控。
 * 版本 1~4 在 L 级下都是「单块」，因此不需要做块交织。
 *
 * 输出为布尔矩阵（true = 深色），另外提供 SVG 字符串渲染。
 * 正确性由 tests/qr.test.mjs 用浏览器原生 BarcodeDetector 做「编码→解码」往返验证。
 */

// 版本 → 尺寸 / 数据码字 / 纠错码字 / 对齐图案中心
const VERSIONS = {
  1: { size: 21, dataBytes: 19, ecBytes: 7, align: [] },
  2: { size: 25, dataBytes: 34, ecBytes: 10, align: [6, 18] },
  3: { size: 29, dataBytes: 55, ecBytes: 15, align: [6, 22] },
  4: { size: 33, dataBytes: 80, ecBytes: 20, align: [6, 26] },
};

const EC_LEVEL_L_BITS = 1; // 格式信息里 L 的两位取值是 01
const MASKS = 8;

/* ------------------------------ GF(256) ------------------------------ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function initGalois() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}());

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 生成多项式 g(x) = (x - a^0)(x - a^1)...(x - a^(n-1))，系数从高次到低次 */
function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon 纠错码字 */
function reedSolomon(data, ecBytes) {
  const gen = generatorPoly(ecBytes);
  const res = new Uint8Array(data.length + ecBytes);
  res.set(data);
  for (let i = 0; i < data.length; i += 1) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j += 1) {
      res[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return res.slice(data.length);
}

/* --------------------------- 比特流编码 --------------------------- */

class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
  toBytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => { if (bit) out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
  }
}

function utf8Bytes(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text));
  // 兜底（理论上浏览器/Node 都有 TextEncoder）
  const out = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/** 选择能容纳内容的最小版本 */
function pickVersion(byteLength) {
  // 4 位模式 + 8 位长度（版本 1~9 都是 8 位）+ 数据 + 最多 4 位终止符
  const needBits = 4 + 8 + byteLength * 8;
  for (const v of [1, 2, 3, 4]) {
    if (needBits <= VERSIONS[v].dataBytes * 8) return v;
  }
  return null;
}

/** 生成数据码字（含填充） */
function buildDataCodewords(bytes, version) {
  const { dataBytes } = VERSIONS[version];
  const buf = new BitBuffer();
  buf.put(0b0100, 4);           // 字节模式
  buf.put(bytes.length, 8);     // 长度（版本 1~9 为 8 位）
  for (const b of bytes) buf.put(b, 8);

  const capacityBits = dataBytes * 8;
  // 终止符
  const term = Math.min(4, capacityBits - buf.length);
  buf.put(0, Math.max(0, term));

  let codewords = buf.toBytes();
  // 补齐到整字节
  if (codewords.length < dataBytes) {
    const padded = new Uint8Array(dataBytes);
    padded.set(codewords);
    // 填充字节 0xEC / 0x11 交替
    for (let i = codewords.length; i < dataBytes; i += 1) {
      padded[i] = (i - codewords.length) % 2 === 0 ? 0xec : 0x11;
    }
    codewords = padded;
  }
  return codewords;
}

/* ---------------------------- 矩阵构建 ---------------------------- */

function createMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFinder(m, row, col) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      m[rr][cc] = dark;
    }
  }
}

function placeAlignment(m, centerRow, centerCol) {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      const dark = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
      m[centerRow + r][centerCol + c] = dark;
    }
  }
}

function placeTiming(m) {
  const size = m.length;
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    if (m[6][i] === null) m[6][i] = dark;
    if (m[i][6] === null) m[i][6] = dark;
  }
}

function reserveFormatAreas(m) {
  const size = m.length;
  for (let i = 0; i < 9; i += 1) {
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
  for (let i = 0; i < 8; i += 1) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
  }
  m[size - 8][8] = true; // 固定的深色模块
}

/** 8 种掩码 */
function maskBit(pattern, i, j) {
  switch (pattern) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
    default: return false;
  }
}

/** 把码字按之字形填进矩阵（isData 标记哪些格子是数据区） */
function placeData(m, codewords, mask) {
  const size = m.length;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let row = size - 1;
  let inc = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // 跳过竖直定时图案
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        const cc = col - c;
        if (m[row][cc] === null) {
          let dark = false;
          if (bitIndex < totalBits) {
            dark = ((codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
            bitIndex += 1;
          }
          if (maskBit(mask, row, cc)) dark = !dark;
          m[row][cc] = dark;
        }
      }
      row += inc;
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
    }
  }
}

/** 格式信息（15 位，BCH + 掩码常量 0x5412） */
function formatBits(mask) {
  const data = (EC_LEVEL_L_BITS << 3) | mask;
  let value = data << 10;
  const poly = 0x537;
  for (let i = 14; i >= 10; i -= 1) {
    if ((value >>> i) & 1) value ^= poly << (i - 10);
  }
  return ((data << 10) | value) ^ 0x5412;
}

function placeFormat(m, mask) {
  const size = m.length;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    // 左上角竖排
    if (i < 6) m[i][8] = dark;
    else if (i < 8) m[i + 1][8] = dark;
    else m[size - 15 + i][8] = dark;
    // 左上角横排 + 右下角
    if (i < 8) m[8][size - i - 1] = dark;
    else if (i < 9) m[8][15 - i - 1 + 1] = dark;
    else m[8][15 - i - 1] = dark;
  }
  m[size - 8][8] = true;
}

/* ---------------------------- 掩码评分 ---------------------------- */

function penalty(m) {
  const size = m.length;
  let score = 0;

  // 规则 1：连续同色 >= 5
  for (let i = 0; i < size; i += 1) {
    let runRow = 1;
    let runCol = 1;
    for (let j = 1; j < size; j += 1) {
      if (m[i][j] === m[i][j - 1]) runRow += 1; else { if (runRow >= 5) score += 3 + (runRow - 5); runRow = 1; }
      if (m[j][i] === m[j - 1][i]) runCol += 1; else { if (runCol >= 5) score += 3 + (runCol - 5); runCol = 1; }
    }
    if (runRow >= 5) score += 3 + (runRow - 5);
    if (runCol >= 5) score += 3 + (runCol - 5);
  }

  // 规则 2：2x2 同色块
  for (let i = 0; i < size - 1; i += 1) {
    for (let j = 0; j < size - 1; j += 1) {
      const v = m[i][j];
      if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) score += 3;
    }
  }

  // 规则 3：类似定位图案的 1:1:3:1:1
  const pattern = [true, false, true, true, true, false, true];
  const matchAt = (getter, start) => {
    for (let k = 0; k < 7; k += 1) if (getter(start + k) !== pattern[k]) return false;
    return true;
  };
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= size - 7; j += 1) {
      if (matchAt((k) => m[i][k], j)
        && ((j >= 4 && [0, 1, 2, 3].every((p) => m[i][j - 4 + p] === false))
          || (j + 11 <= size && [7, 8, 9, 10].every((p) => m[i][j + p] === false)))) score += 40;
      if (matchAt((k) => m[k][i], j)
        && ((j >= 4 && [0, 1, 2, 3].every((p) => m[j - 4 + p][i] === false))
          || (j + 11 <= size && [7, 8, 9, 10].every((p) => m[j + p][i] === false)))) score += 40;
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (let i = 0; i < size; i += 1) for (let j = 0; j < size; j += 1) if (m[i][j]) dark += 1;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/* ------------------------------ 对外 API ------------------------------ */

/**
 * 编码为二维码矩阵。
 * @param {string} text
 * @returns {{ size:number, modules:boolean[][], version:number, mask:number }}
 */
export function encodeQr(text) {
  const content = String(text ?? '');
  const bytes = utf8Bytes(content);
  const version = pickVersion(bytes.length);
  if (!version) {
    throw new Error(`内容太长（${bytes.length} 字节），最多支持 ${VERSIONS[4].dataBytes - 3} 字节左右`);
  }
  const { size, ecBytes, align } = VERSIONS[version];
  const data = buildDataCodewords(bytes, version);
  const ec = reedSolomon(data, ecBytes);
  const codewords = new Uint8Array(data.length + ec.length);
  codewords.set(data);
  codewords.set(ec, data.length);

  // 固定图案
  const base = createMatrix(size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);
  placeTiming(base);
  if (align.length) {
    for (const r of align) {
      for (const c of align) {
        const nearFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
        if (!nearFinder) placeAlignment(base, r, c);
      }
    }
  }
  reserveFormatAreas(base);

  // 选择惩罚分最低的掩码
  let best = null;
  for (let mask = 0; mask < MASKS; mask += 1) {
    const m = base.map((row) => row.slice());
    placeData(m, codewords, mask);
    placeFormat(m, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { score, mask, modules: m };
  }

  return { size, modules: best.modules, version, mask: best.mask };
}

/**
 * 渲染为 SVG 字符串（含 4 模块静区，按像素自适应大小）。
 * @param {string} text
 * @param {{scale?:number, quiet?:number, dark?:string, light?:string, className?:string}} [opts]
 */
export function qrSvg(text, opts = {}) {
  const { modules, size } = encodeQr(text);
  const quiet = opts.quiet ?? 4;
  const scale = opts.scale ?? 6;
  const dim = (size + quiet * 2) * scale;
  const dark = opts.dark || '#0F1115';
  const light = opts.light || '#FFFFFF';
  let path = '';
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) path += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  const cls = opts.className ? ` class="${opts.className}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}"${cls} shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/></svg>`;
}

/** 从扫码结果里提取邀请码：支持裸 8 位码、keepaccounts://join/CODE、任意含 join/CODE 的链接 */
export function extractInviteCode(raw) {
  const text = String(raw || '').trim();
  if (/^[A-Z0-9]{8}$/i.test(text)) return text.toUpperCase();
  const m = text.match(/(?:join[/=:])([A-Z0-9]{8})\b/i) || text.match(/\b([A-Z0-9]{8})\b/);
  return m ? m[1].toUpperCase() : null;
}
