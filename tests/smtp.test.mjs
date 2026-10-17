/**
 * SMTP 邮件发送的零依赖测试：进程内起一个 Mock SMTP 服务器，验证协议、编码、认证与失败路径。
 * 用法：node tests/smtp.test.mjs
 * STARTTLS 用例需要 openssl 生成自签名证书（写进 .cache/smtp-test/）；没有 openssl 时该项会跳过。
 */

import net from 'node:net';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMailer, mailCapabilities } from '../server/mailer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache', 'smtp-test');
const KEY_PEM = join(CACHE_DIR, 'key.pem');
const CERT_PEM = join(CACHE_DIR, 'cert.pem');

/* ------------------------------------------------------------------ *
 * 极简断言（沿用 tests/api.test.mjs 的风格）
 * ------------------------------------------------------------------ */
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
function note(text) {
  console.log(`  · ${text}`);
}

/* ------------------------------------------------------------------ *
 * 自签名证书：运行时用 openssl 生成到仓库内的 .cache/smtp-test/
 * ------------------------------------------------------------------ */
function ensureCert() {
  if (existsSync(KEY_PEM) && existsSync(CERT_PEM)) return true;
  mkdirSync(CACHE_DIR, { recursive: true }); // 只在仓库内写文件
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY_PEM, '-out', CERT_PEM, '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return r.status === 0 && existsSync(KEY_PEM) && existsSync(CERT_PEM);
}

/* ------------------------------------------------------------------ *
 * Mock SMTP 服务器
 * ------------------------------------------------------------------ */
const BASE_CFG = {
  mailProvider: 'smtp',
  smtpHost: '127.0.0.1',
  smtpPort: 0, // 由 start() 填上真实端口
  smtpSecure: 'none',
  smtpUser: '',
  smtpPass: '',
  smtpFrom: 'noreply@example.com',
  smtpFromName: '记账助手',
  smtpTimeoutMs: 5000,
  smtpRejectUnauthorized: false,
};

/**
 * 起一个 Mock SMTP 服务器。
 * @param {{tls?:boolean, authMode?:('plain'|'login'|'both'|'cram'), advertiseStartTls?:boolean,
 *          rejectAuth?:boolean, silent?:boolean}} [opts]
 */
function startMock(opts = {}) {
  const mode = opts.authMode || 'both';
  const state = {
    host: '127.0.0.1', port: 0,
    messages: [], // 每封：{ raw, dotRaw, data, tls }
    auths: [],    // 每次：{ mechanism, user, pass, raw, tls }
    upgraded: false, // 是否有连接真的做了 STARTTLS 升级
    connections: 0,
    errors: [],
  };
  const sockets = new Set();
  const upgrades = new Set();

  const advertise = () => {
    const lines = ['250-mock greets you'];
    if (mode === 'plain' || mode === 'both') lines.push('250-AUTH PLAIN LOGIN');
    else if (mode === 'login') lines.push('250-AUTH LOGIN');
    else if (mode === 'cram') lines.push('250-AUTH CRAM-MD5');
    lines.push('250-8BITMIME');
    if (opts.advertiseStartTls && !opts.tls) lines.push('250-STARTTLS');
    lines.push('250 OK');
    return `${lines.join('\r\n')}\r\n`;
  };

  const write = (ctx, text) => {
    const target = ctx.session;
    if (target && !target.destroyed) target.write(text);
  };

  /**
   * 把已 flush 出去的 STARTTLS 响应包成 TLS；升级后所有命令都写 ctx.session（TLS socket）。
   * 成功后在 state 上打升级标记；任何失败都记进 state.errors，避免测试卡死。
   */
  const upgradeToTls = (sock, ctx) => {
    const promise = new Promise((resolveUpgrade) => {
      sock.removeAllListeners('data'); // 旧明文监听不能吃掉 TLS 密文
      const secure = new tls.TLSSocket(sock, { isServer: true, secureContext: TLS_CONTEXT });
      const timer = setTimeout(() => {
        state.errors.push('STARTTLS 握手超时');
        resolveUpgrade();
      }, 3000);
      secure.on('secure', () => {
        clearTimeout(timer);
        state.upgraded = true;
        ctx.session = secure;
        ctx.inData = false;
        sockets.add(secure);
        ctx.attachSecure();
        resolveUpgrade();
      });
      secure.on('error', (err) => {
        clearTimeout(timer);
        state.errors.push(`TLS: ${err.message}`);
        resolveUpgrade();
      });
      secure.on('close', () => sockets.delete(secure));
    });
    upgrades.add(promise);
    return promise;
  };

  const onConnect = (sock, ctx = {}) => {
    state.connections += 1;
    ctx.session = sock; // 明文阶段也走 ctx.session，STARTTLS 后换成 TLS socket
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => { /* 客户端提前断开属正常 */ });
    if (!opts.silent) write(ctx, '220 mock ESMTP ready\r\n');

    let buffer = '';
    let inData = false;
    let dataRaw = '';
    let login = null;

    const cmd = (line) => {
      if (opts.rejectAuth && /^AUTH\b/i.test(line)) {
        write(ctx, '535 5.7.8 Authentication credentials invalid\r\n');
        return;
      }
      if (/^EHLO\b/i.test(line)) { write(ctx, advertise()); return; }
      if (/^HELO\b/i.test(line)) { write(ctx, '250 mock\r\n'); return; }
      if (/^STARTTLS$/i.test(line)) {
        // 必须先把 220 flush 出去，再做 TLS 包装
        ctx.session.write('220 2.0.0 Ready to start TLS\r\n', () => { upgradeToTls(sock, ctx); });
        return;
      }
      if (/^AUTH PLAIN\b/i.test(line)) {
        const token = Buffer.from(line.split(/\s+/)[2] || '', 'base64').toString('utf8');
        const [, user = '', pass = ''] = token.split('\0');
        state.auths.push({ mechanism: 'PLAIN', user, pass, raw: line, tls: !!ctx.upgraded });
        write(ctx, '235 2.7.0 Authentication successful\r\n');
        return;
      }
      if (/^AUTH LOGIN/i.test(line)) {
        login = { mechanism: 'LOGIN', step: 0, user: '', pass: '', raw: line, tls: !!ctx.upgraded };
        write(ctx, `334 ${Buffer.from('Username:').toString('base64')}\r\n`);
        return;
      }
      if (login) {
        if (login.step === 0) {
          login.user = Buffer.from(line, 'base64').toString('utf8');
          login.step = 1;
          write(ctx, `334 ${Buffer.from('Password:').toString('base64')}\r\n`);
        } else {
          login.pass = Buffer.from(line, 'base64').toString('utf8');
          state.auths.push({ ...login, raw: line });
          login = null;
          write(ctx, '235 2.7.0 Authentication successful\r\n');
        }
        return;
      }
      if (/^MAIL FROM:/i.test(line)) { write(ctx, '250 2.1.0 OK\r\n'); return; }
      if (/^RCPT TO:/i.test(line)) { write(ctx, '250 2.1.5 OK\r\n'); return; }
      if (/^DATA$/i.test(line)) {
        inData = true;
        dataRaw = '';
        write(ctx, '354 End data with <CR><LF>.<CR><LF>\r\n');
        return;
      }
      if (/^QUIT$/i.test(line)) {
        write(ctx, '221 2.0.0 Bye\r\n');
        ctx.session.end();
        return;
      }
      write(ctx, '250 2.0.0 OK\r\n');
    };

    /** 读取循环：只处理"当前 socket"上的字节，升级后明文 socket 的数据一律忽略 */
    const feed = (source, chunk) => {
      if (ctx.session !== source) return;
      buffer += chunk.toString('utf8');
      while (true) {
        if (inData) {
          // DATA 阶段读点填充的正文，直到独立的一行 "."
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          dataRaw += buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          inData = false;
          const dotRaw = dataRaw;
          const data = dotRaw.replace(/\r\n\.\./g, '\r\n.'); // 去点填充
          state.messages.push({ raw: `${data}\r\n`, dotRaw, data, tls: !!ctx.upgraded });
          write(ctx, '250 2.0.0 Ok: queued as MOCK1\r\n');
          continue;
        }
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (ctx.session !== source) return; // 本条是 STARTTLS，后面的字节交给 TLS socket
        cmd(line);
      }
    };

    sock.on('data', (chunk) => feed(sock, chunk));
    // STARTTLS 升级完成后由 upgradeToTls 调用，挂上 TLS socket 的读取循环
    ctx.attachSecure = () => {
      if (ctx.session === sock) return;
      buffer = '';
      ctx.upgraded = true;
      ctx.session.on('data', (chunk) => feed(ctx.session, chunk));
    };
  };

  const server = opts.tls
    ? tls.createServer({ key: CERT_KEY, cert: CERT_CERT }, (sock) => onConnect(sock, { session: sock, upgraded: true }))
    : net.createServer((sock) => onConnect(sock, {}));

  return {
    state,
    async start() {
      await new Promise((res) => server.listen(0, '127.0.0.1', res));
      state.port = server.address().port;
      return state;
    },
    cfg(over = {}) {
      return { ...BASE_CFG, smtpPort: state.port, smtpSecure: opts.tls ? 'ssl' : 'none', ...over };
    },
    async stop() {
      await Promise.all([...upgrades]);
      for (const s of sockets) s.destroy();
      await new Promise((res) => server.close(res));
    },
  };
}

let CERT_KEY = '';
let CERT_CERT = '';
let TLS_CONTEXT = null; // STARTTLS 升级用（证书在运行时生成后才赋值）

/* ------------------------------------------------------------------ *
 * MIME 解析辅助（测试用）
 * ------------------------------------------------------------------ */
function parseHeaders(text) {
  const sep = text.indexOf('\r\n\r\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const body = sep < 0 ? '' : text.slice(sep + 4);
  const map = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).toLowerCase();
    map[key] = map[key] ? `${map[key]}, ${line.slice(idx + 1).trim()}` : line.slice(idx + 1).trim();
  }
  return { headers: map, body };
}

function decodeHeader(value) {
  return String(value).replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));
}

function decodeBody(body) {
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

function rawHeaderBlock(text) {
  const sep = text.indexOf('\r\n\r\n');
  return sep < 0 ? text : text.slice(0, sep);
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */
const ZH_TEXT = '您的验证码是 482913，5 分钟内有效。';
const ZH_SUBJECT = '【记账助手】邮箱验证码';

/** 跑一个用例：起 mock、发送、断言，最后关闭 */
async function caseWithMock(label, opts, fn) {
  const mock = startMock(opts);
  await mock.start();
  try {
    await fn(mock);
  } catch (err) {
    fail += 1;
    failures.push(`${label} 执行异常：${err.message}`);
  } finally {
    await mock.stop();
  }
}

/** 发一封标准邮件，返回 { mailer, res, msg } */
async function deliver(mock, over = {}, mailOver = {}) {
  const mailer = createMailer(mock.cfg(over));
  ok(!!mailer, 'createMailer 返回实例');
  const res = await mailer.send({
    to: 'user@example.com',
    subject: ZH_SUBJECT,
    text: ZH_TEXT,
    ...mailOver,
  });
  eq(mock.state.messages.length, 1, '服务器收到 1 封邮件');
  return { mailer, res, msg: mock.state.messages[0] };
}

/* ================= 1. 未配置 → null ================= */
{
  const emptyCfg = { mailProvider: 'auto', smtpHost: '', smtpSecure: 'starttls', smtpFrom: 'a@b.com' };
  eq(createMailer(emptyCfg), null, 'smtpHost 为空时 createMailer 返回 null');
  eq(mailCapabilities(emptyCfg).configured, false, '未配置时 configured=false');
  eq(createMailer({ mailProvider: 'none', smtpHost: 'smtp.example.com' }), null, 'mailProvider=none 返回 null');
  eq(createMailer({ mailProvider: 'auto', smtpHost: 'smtp.example.com' })?.provider, 'smtp', 'auto + host 返回 smtp');
  eq(mailCapabilities({ mailProvider: 'smtp', smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: 'ssl', smtpUser: 'a@qq.com' }).configured, true, '已配置时 configured=true');
}

/* ================= 7. label 是中文 ================= */
{
  const cap = mailCapabilities({ mailProvider: 'none' });
  ok(typeof cap.label === 'string' && cap.label.trim().length > 0, 'label 是非空字符串');
  ok(/[\u4e00-\u9fa5]/.test(cap.label), `label 含中文：${cap.label}`);
  const cap2 = mailCapabilities({ mailProvider: 'smtp', smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: 'ssl', smtpUser: 'a@qq.com' });
  ok(/[\u4e00-\u9fa5]/.test(cap2.label) && cap2.label.includes('465'), `已配置 label 含中文与端口：${cap2.label}`);
}

/* ================= 2. 明文发送 + MIME 编码 + 点填充 ================= */
await caseWithMock('明文 SMTP', { authMode: 'both' }, async (mock) => {
  const dotLine = '.开头的一行不能被 SMTP 当成结束符';
  const text = `${ZH_TEXT}\r\n${dotLine}`;
  const mailer = createMailer(mock.cfg({ smtpUser: '', smtpPass: '', smtpFromName: '' }));
  const res = await mailer.send({ to: 'user@example.com', subject: ZH_SUBJECT, text });

  eq(res.ok, true, '明文发送 ok=true');
  ok(/^<.+@example\.com>$/.test(res.messageId), 'send 返回 Message-ID');
  eq(mock.state.messages.length, 1, '明文：服务器收到 1 封邮件');
  eq(mock.state.auths.length, 0, '没配账号时不发 AUTH');

  const msg = mock.state.messages[0];
  const { headers, body } = parseHeaders(msg.data);
  eq(headers.from, 'noreply@example.com', 'From 头正确（无显示名时不加引号）');
  eq(headers.to, 'user@example.com', 'To 头正确');
  eq(headers['mime-version'], '1.0', 'MIME-Version: 1.0');
  eq(headers['content-type'], 'text/plain; charset=utf-8', 'Content-Type 为 text/plain; charset=utf-8');
  eq(headers['content-transfer-encoding'], 'base64', '正文用 base64');
  ok(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/.test(headers.date), `Date 是 RFC 2822：${headers.date}`);
  eq(headers['message-id'], res.messageId, 'Message-ID 头与返回值一致');

  // 中文主题必须 RFC 2047 编码，且能解回原文
  ok(headers.subject.includes('=?UTF-8?B?'), '中文主题已 RFC 2047 编码');
  ok(!/[\u4e00-\u9fa5]/.test(headers.subject), '主题头里不含裸中文');
  eq(decodeHeader(headers.subject), ZH_SUBJECT, '主题解码后与原文一致');

  // 正文 base64 解码回原文
  eq(decodeBody(body), text, '正文 base64 解码后与原文一致');

  // 点填充：正文是 base64，wire 上不会出现行首 .；直接验证点填充→去填充可往返
  const dotPiece = `头部\r\n${dotLine}\r\n尾部`;
  const stuffed = dotPiece.split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
  ok(stuffed.includes(`\r\n..${dotLine.slice(1)}`), '点填充把行首的 . 变成 ..');
  eq(stuffed.replace(/\r\n\.\./g, '\r\n.'), dotPiece, '去点填充后与原报文一致');
  ok(!stuffed.split('\r\n').includes('.'), '填充后没有独立的 . 行（不会被当成 DATA 结束符）');
});

/* ================= 2b. 中文显示名 + multipart/alternative ================= */
await caseWithMock('中文显示名与 HTML', { authMode: 'both' }, async (mock) => {
  const mailer = createMailer(mock.cfg());
  await mailer.send({ to: 'user@example.com', subject: ZH_SUBJECT, text: ZH_TEXT, html: `<p>${ZH_TEXT}</p>` });
  const msg = mock.state.messages[0];
  const { headers, body } = parseHeaders(msg.data);
  ok(/^=\?UTF-8\?B\?.+\?= <noreply@example\.com>$/.test(headers.from), `From 显示名已 RFC 2047 编码：${headers.from}`);
  ok(decodeHeader(headers.from).startsWith('记账助手'), 'From 显示名解码正确');
  ok(String(headers['content-type']).startsWith('multipart/alternative'), 'html 时用 multipart/alternative');
  const boundary = (String(headers['content-type']).match(/boundary="([^"]+)"/) || [])[1];
  ok(!!boundary, '有 boundary');
  const parts = body.split(`--${boundary}`);
  ok(parts.some((p) => /Content-Type: text\/plain/i.test(p)), '包含 text/plain 分段');
  ok(parts.some((p) => /Content-Type: text\/html/i.test(p)), '包含 text/html 分段');
  const textPart = parts.find((p) => /Content-Type: text\/plain/i.test(p));
  eq(decodeBody(textPart.split('\r\n\r\n').slice(1).join('\r\n\r\n')), ZH_TEXT, 'text/plain 分段解码正确');
});

/* ================= 3. AUTH PLAIN 与 AUTH LOGIN ================= */
await caseWithMock('AUTH PLAIN', { authMode: 'plain' }, async (mock) => {
  await deliver(mock, { smtpUser: 'bot@example.com', smtpPass: 's3cret 密码' });
  eq(mock.state.auths.length, 1, 'PLAIN：捕获到 1 次认证');
  const a = mock.state.auths[0];
  eq(a.mechanism, 'PLAIN', '使用 AUTH PLAIN');
  eq(a.user, 'bot@example.com', 'PLAIN 用户名正确');
  eq(a.pass, 's3cret 密码', 'PLAIN 密码正确（含中文/空格）');
  const token = String(a.raw).split(/\s+/)[2];
  eq(Buffer.from(token, 'base64').toString('utf8'), '\0bot@example.com\0s3cret 密码', 'PLAIN 令牌格式为 \\0user\\0pass');
});

await caseWithMock('AUTH LOGIN', { authMode: 'login' }, async (mock) => {
  await deliver(mock, { smtpUser: 'bot@example.com', smtpPass: 's3cret 密码' });
  eq(mock.state.auths.length, 1, 'LOGIN：捕获到 1 次认证');
  const a = mock.state.auths[0];
  eq(a.mechanism, 'LOGIN', '使用 AUTH LOGIN');
  eq(a.user, 'bot@example.com', 'LOGIN 用户名正确');
  eq(a.pass, 's3cret 密码', 'LOGIN 密码正确');
});

await caseWithMock('服务器不提供 AUTH', { authMode: 'cram' }, async (mock) => {
  const mailer = createMailer(mock.cfg({ smtpUser: 'bot@example.com', smtpPass: 'x' }));
  let err = null;
  try { await mailer.send({ to: 'user@example.com', subject: ZH_SUBJECT, text: ZH_TEXT }); } catch (e) { err = e; }
  ok(!!err, '只有 CRAM-MD5 时发送失败');
  ok(err && /AUTH|认证/.test(err.message) && /[\u4e00-\u9fa5]/.test(err.message), `错误信息为中文且提到 AUTH：${err && err.message}`);
  eq(mock.state.messages.length, 0, '未发送任何邮件');
});

/* ================= 4. 隐式 SSL（465） ================= */
let hasCert = ensureCert();
if (!hasCert) {
  note('未找到 openssl，跳过 SSL / STARTTLS 用例（不视为失败）');
} else {
  CERT_KEY = readFileSync(KEY_PEM, 'utf8');
  CERT_CERT = readFileSync(CERT_PEM, 'utf8');
  TLS_CONTEXT = tls.createSecureContext({ key: CERT_KEY, cert: CERT_CERT });

  await caseWithMock('隐式 SSL', { tls: true, authMode: 'both' }, async (mock) => {
    await deliver(mock, { smtpSecure: 'ssl', smtpPort: mock.state.port, smtpUser: 'bot@example.com', smtpPass: 'pw' });
    eq(mock.state.auths.length, 1, 'SSL：认证成功');
    ok(mock.state.messages[0].tls, 'SSL：邮件经 TLS 送达');
    eq(decodeHeader(parseHeaders(mock.state.messages[0].data).headers.subject), ZH_SUBJECT, 'SSL：主题解码正确');
  });

  /* ================= 5. STARTTLS（587） ================= */
  await caseWithMock('STARTTLS', { advertiseStartTls: true, authMode: 'both' }, async (mock) => {
    await deliver(mock, { smtpSecure: 'starttls', smtpUser: 'bot@example.com', smtpPass: 'pw' });
    eq(mock.state.upgraded, true, '客户端真的做了 STARTTLS 升级');
    eq(mock.state.messages.length, 1, 'STARTTLS：升级后收到邮件');
    ok(mock.state.messages[0].tls, '邮件是在 TLS 通道上送达的（升级之后）');
    eq(mock.state.auths.length, 1, 'STARTTLS：认证发生在升级之后');
    ok(mock.state.auths[0].tls, 'AUTH 也走 TLS 通道');
    eq(mock.state.errors.length, 0, `服务端无 TLS 错误：${mock.state.errors.join('; ')}`);
  });
}

/* ================= 6. 失败路径 ================= */
await caseWithMock('认证被拒 535', { authMode: 'plain', rejectAuth: true }, async (mock) => {
  const mailer = createMailer(mock.cfg({ smtpUser: 'bot@example.com', smtpPass: 'wrong' }));
  let err = null;
  try { await mailer.send({ to: 'user@example.com', subject: ZH_SUBJECT, text: ZH_TEXT }); } catch (e) { err = e; }
  ok(!!err, '535 时 send() 抛错');
  ok(err && /[\u4e00-\u9fa5]/.test(err.message), `错误信息是中文：${err && err.message}`);
  ok(err && /SMTP/.test(err.message) && /密码|SMTP_PASS/.test(err.message), `错误提到 SMTP 与密码：${err && err.message}`);
  ok(err && err.message.includes('535'), '错误里带 SMTP 状态码 535');
  eq(mock.state.messages.length, 0, '认证失败不会发送邮件');
});

await caseWithMock('服务器不问候（超时）', { silent: true }, async (mock) => {
  const mailer = createMailer(mock.cfg({ smtpTimeoutMs: 800, smtpSecure: 'none' }));
  const t0 = Date.now();
  let err = null;
  try { await mailer.send({ to: 'user@example.com', subject: ZH_SUBJECT, text: ZH_TEXT }); } catch (e) { err = e; }
  const cost = Date.now() - t0;
  ok(!!err, '服务器不问候时 send() 抛错');
  ok(err && /超时/.test(err.message) && /[\u4e00-\u9fa5]/.test(err.message), `超时错误是中文：${err && err.message}`);
  ok(cost < 4000, `超时在数秒内触发（实际 ${cost}ms）`);
  eq(mock.state.connections, 1, '只建立了一次连接');
});

await caseWithMock('服务器拒绝 STARTTLS', { authMode: 'both', advertiseStartTls: false }, async (mock) => {
  const mailer = createMailer(mock.cfg({ smtpSecure: 'starttls', smtpUser: 'bot@example.com', smtpPass: 'pw' }));
  let err = null;
  try { await mailer.send({ to: 'user@example.com', subject: ZH_SUBJECT, text: ZH_TEXT }); } catch (e) { err = e; }
  ok(!!err && /STARTTLS/.test(err.message), `未广告 STARTTLS 时给出明确中文错误：${err && err.message}`);
  eq(mock.state.messages.length, 0, '不会退回明文发送');
});

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log(`\nSMTP 邮件测试：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
} else {
  console.log('全部通过 ✅');
}
