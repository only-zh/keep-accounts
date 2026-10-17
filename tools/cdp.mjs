/**
 * 极简 Chrome DevTools Protocol 客户端（零依赖），用于需要「真实等待异步结果」的浏览器测试。
 *
 * 为什么需要它：`--virtual-time-budget` 会快进定时器，但不会推进原生后台任务
 * （例如 BarcodeDetector.detect、IndexedDB 的某些事务），导致页面卡在 await 上。
 * 通过 CDP 可以直接 `Runtime.evaluate({awaitPromise:true})`，按真实时间等结果。
 *
 * 用法：
 *   import { withPage } from './cdp.mjs';
 *   const result = await withPage('http://127.0.0.1:8787/page.html', 'document.title');
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* ------------------------------ WebSocket ------------------------------ */

class WsClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.handlers = new Map();
    this.nextId = 1;
    this.closed = false;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => { this.closed = true; });
  }

  /** 连接并完成 HTTP Upgrade 握手 */
  static connect(wsUrl, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const key = randomBytes(16).toString('base64');
      const socket = net.connect(Number(url.port || 80), url.hostname);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('WebSocket 连接超时')); }, timeoutMs);
      socket.once('error', (err) => { clearTimeout(timer); reject(err); });
      socket.once('connect', () => {
        const path = url.pathname + (url.search || '');
        socket.write(
          `GET ${path} HTTP/1.1\r\n`
          + `Host: ${url.host}\r\n`
          + 'Upgrade: websocket\r\n'
          + 'Connection: Upgrade\r\n'
          + `Sec-WebSocket-Key: ${key}\r\n`
          + 'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let handshake = Buffer.alloc(0);
      const onHandshakeData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const idx = handshake.indexOf('\r\n\r\n');
        if (idx < 0) return;
        socket.removeListener('data', onHandshakeData);
        const head = handshake.subarray(0, idx).toString();
        if (!/HTTP\/1\.1 101/.test(head)) {
          clearTimeout(timer);
          reject(new Error(`WebSocket 握手失败：${head.split('\r\n')[0]}`));
          return;
        }
        clearTimeout(timer);
        const client = new WsClient(socket);
        const rest = handshake.subarray(idx + 4);
        if (rest.length) client.onData(rest);
        resolve(client);
      };
      socket.on('data', onHandshakeData);
    });
  }

  /** 发送一条文本帧（客户端帧必须加掩码） */
  send(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;
      let payload = buf.subarray(offset, offset + len);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      this.buffer = buf.subarray(offset + len);
      if (opcode === 0x8) { this.closed = true; continue; }
      if (opcode === 0x9) continue; // ping，忽略
      if (opcode !== 0x1 && opcode !== 0x2) continue;
      if (!fin) continue; // 本项目消息都很小，不预期分片
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
      const handler = this.handlers.get(msg.id);
      if (handler) {
        this.handlers.delete(msg.id);
        if (msg.error) handler.reject(new Error(msg.error.message || 'CDP 错误'));
        else handler.resolve(msg.result);
      }
    }
  }

  call(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
      this.handlers.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

/* ------------------------------ 启动 Chrome ------------------------------ */

function httpJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('CDP HTTP 超时')); });
    req.on('error', reject);
  });
}

async function waitForDebugger(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Chrome 调试端口未就绪');
}

/**
 * 打开一个页面，执行表达式（等待 Promise），返回 JSON 结果。
 * @param {string} url
 * @param {string} expression 需要在页面里求值的表达式（可返回 Promise）
 * @param {{timeoutMs?:number, port?:number, keepOpen?:boolean}} [opts]
 */
export async function withPage(url, expression, opts = {}) {
  const port = opts.port || 9333 + Math.floor(Math.random() * 200);
  const profile = mkdtempSync(join(tmpdir(), 'cdp-profile-'));
  const timeoutMs = opts.timeoutMs || 45000;

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=520,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    const target = await waitForDebugger(port);
    ws = await WsClient.connect(target.webSocketDebuggerUrl);
    await ws.call('Page.enable');
    await ws.call('Runtime.enable');

    const loaded = new Promise((resolve) => {
      // 直接等 Page.loadEventFired
      const original = ws.onData.bind(ws);
      void original;
      const check = setInterval(() => {
        if (ws.closed) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, timeoutMs);
    });
    await ws.call('Page.navigate', { url });
    await loaded;

    // 等页面自己的脚本把结果写进 DOM（最多 timeoutMs）
    const evaluate = await ws.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);

    if (evaluate.exceptionDetails) {
      throw new Error(`页面内异常：${evaluate.exceptionDetails.text} ${evaluate.exceptionDetails.exception?.description || ''}`);
    }
    return evaluate.result ? evaluate.result.value : null;
  } finally {
    if (ws) ws.close();
    try { chrome.kill('SIGKILL'); } catch { /* ignore */ }
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }, 200);
  }
}

/** 让页面把某个属性/标题里的 JSON 取出来（带轮询等待） */
export function waitForAttr(attr, timeoutMs = 30000) {
  return `(async () => {
    const deadline = Date.now() + ${timeoutMs};
    while (Date.now() < deadline) {
      const v = document.documentElement.getAttribute('${attr}');
      if (v) return v;
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  })()`;
}

/**
 * 多步执行：适合「先写 localStorage 再刷新」这类会重建执行上下文的场景。
 * @param {string} url
 * @param {Array<string|{expr:string, delayMs?:number}>} steps
 * @param {{timeoutMs?:number}} [opts]
 */
export async function withPageSteps(url, steps, opts = {}) {
  const port = opts.port || 9533 + Math.floor(Math.random() * 200);
  const profile = mkdtempSync(join(tmpdir(), 'cdp-profile-'));
  const timeoutMs = opts.timeoutMs || 45000;

  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=520,900', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  const results = [];
  try {
    const target = await waitForDebugger(port);
    ws = await WsClient.connect(target.webSocketDebuggerUrl);
    await ws.call('Page.enable');
    await ws.call('Runtime.enable');
    await ws.call('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 1200));

    for (const step of steps) {
      if (typeof step === 'object' && step.screenshot) {
        await new Promise((r) => setTimeout(r, step.delayMs || 400));
        const shot = await ws.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(step.screenshot, Buffer.from(shot.data, 'base64'));
        results.push(step.screenshot);
        continue;
      }
      const expr = typeof step === 'string' ? step : step.expr;
      const delay = (typeof step === 'object' && step.delayMs) || 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      let value = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const out = await ws.call('Runtime.evaluate', {
            expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
          }, timeoutMs);
          if (out.exceptionDetails) {
            if (attempt === 2) throw new Error(`页面内异常：${out.exceptionDetails.text}`);
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          value = out.result ? out.result.value : null;
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      results.push(value);
    }
    return results;
  } finally {
    if (ws) ws.close();
    try { chrome.kill('SIGKILL'); } catch { /* ignore */ }
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }, 200);
  }
}

/** 轮询等待表达式为真（页面内循环） */
export function waitFor(expr, timeoutMs = 20000) {
  return `(async () => {
    const deadline = Date.now() + ${timeoutMs};
    while (Date.now() < deadline) {
      try { const v = ${expr}; if (v) return v; } catch (e) { /* 上下文可能正在重建 */ }
      await new Promise(r => setTimeout(r, 150));
    }
    return null;
  })()`;
}
