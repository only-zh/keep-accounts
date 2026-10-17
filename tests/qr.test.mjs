/**
 * 二维码编码器的结构性测试（Node 端，不依赖浏览器）。
 * 「编码 → 解码」的往返验证在 public/qr-selftest.html 里用浏览器原生 BarcodeDetector 完成。
 *
 * 用法：node tests/qr.test.mjs
 */

import { encodeQr, qrSvg, extractInviteCode } from '../shared/qr.js';

let pass = 0;
let fail = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass += 1;
  else { fail += 1; failures.push(`${label}\n    期望: ${b}\n    实际: ${a}`); }
}
function ok(cond, label) {
  if (cond) pass += 1;
  else { fail += 1; failures.push(label); }
}

/* ---------------- 尺寸与版本 ---------------- */
{
  const qr = encodeQr('8RFNVDYK');
  eq(qr.version, 1, '8 字节内容落在版本 1');
  eq(qr.size, 21, '版本 1 尺寸 21×21');
  ok(Array.isArray(qr.modules) && qr.modules.length === 21, '返回矩阵');
  ok(qr.modules.every((row) => row.length === 21), '矩阵是正方形');
  ok(qr.modules.every((row) => row.every((v) => typeof v === 'boolean')), '矩阵元素都是布尔值');
}
{
  const qr = encodeQr('随便一段中文内容也能编码');
  ok(qr.size >= 21, 'UTF-8 中文可编码');
  ok(qr.version >= 1 && qr.version <= 4, '中文落在支持的版本区间');
}
{
  const big = 'x'.repeat(60);
  const qr = encodeQr(big);
  eq(qr.version, 4, '60 字节内容升到版本 4');
  eq(qr.size, 33, '版本 4 尺寸 33×33');
}
{
  let threw = null;
  try { encodeQr('x'.repeat(200)); } catch (e) { threw = e; }
  ok(!!threw && /太长/.test(threw.message), '超长内容抛出中文错误');
}

/* ---------------- 固定图案 ---------------- */
function finderOk(m, r0, c0) {
  const pattern = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ];
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      if (m[r0 + r][c0 + c] !== !!pattern[r][c]) return false;
    }
  }
  return true;
}
{
  const { modules, size } = encodeQr('8RFNVDYK');
  ok(finderOk(modules, 0, 0), '左上定位图案正确');
  ok(finderOk(modules, 0, size - 7), '右上定位图案正确');
  ok(finderOk(modules, size - 7, 0), '左下定位图案正确');
  ok(modules[size - 8][8] === true, '固定的深色模块存在');

  let timingRowOk = true;
  let timingColOk = true;
  for (let i = 8; i < size - 8; i += 1) {
    if (modules[6][i] !== (i % 2 === 0)) timingRowOk = false;
    if (modules[i][6] !== (i % 2 === 0)) timingColOk = false;
  }
  ok(timingRowOk, '水平定时图案交替正确');
  ok(timingColOk, '垂直定时图案交替正确');
}
{
  // 版本 2 及以上应包含对齐图案（中心 18,18）
  // 30 字节：4+8+240=252 bit ≤ 272 bit（v2 容量），刚好落在版本 2
  const { modules, size } = encodeQr('x'.repeat(30));
  ok(size === 25, '30 字节内容为版本 2（25×25）');
  const center = modules[18][18];
  let alignOk = true;
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      const expect = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
      if (modules[18 + r][18 + c] !== expect) alignOk = false;
    }
  }
  ok(center === true && alignOk, '版本 2 的对齐图案正确');
}

/* ---------------- 确定性 ---------------- */
{
  const a = encodeQr('8RFNVDYK');
  const b = encodeQr('8RFNVDYK');
  eq(JSON.stringify(a.modules), JSON.stringify(b.modules), '同一内容输出稳定（可复现）');
  const c = encodeQr('8RFNVDYL');
  ok(JSON.stringify(a.modules) !== JSON.stringify(c.modules), '不同内容输出不同');
}

/* ---------------- SVG 渲染 ---------------- */
{
  const svg = qrSvg('8RFNVDYK', { scale: 4, quiet: 4 });
  ok(svg.startsWith('<svg'), '输出 SVG');
  ok(svg.includes('viewBox="0 0 116 116"'), '静区与缩放计算正确（(21+8)*4=116）');
  ok((svg.match(/<path/g) || []).length === 1, '深色模块合并为单条 path');
  ok(svg.includes('fill="#FFFFFF"'), '默认浅色底');
}

/* ---------------- 邀请码提取 ---------------- */
eq(extractInviteCode('8RFNVDYK'), '8RFNVDYK', '裸邀请码');
eq(extractInviteCode('8rfnvdyk'), '8RFNVDYK', '小写也接受（统一大写）');
eq(extractInviteCode('keepaccounts://join/8RFNVDYK'), '8RFNVDYK', '自定义协议');
eq(extractInviteCode('https://example.com/join/8RFNVDYK'), '8RFNVDYK', '网页链接');
eq(extractInviteCode('邀请码：8RFNVDYK 快来'), '8RFNVDYK', '夹在文本里');
eq(extractInviteCode('hello world'), null, '无法识别返回 null');
eq(extractInviteCode(''), null, '空字符串返回 null');

console.log(`\n二维码编码测试：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
} else {
  console.log('全部通过 ✅');
}
