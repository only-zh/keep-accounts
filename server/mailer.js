/**
 * 零依赖 SMTP 邮件发送（注册验证码用）。
 *
 * 只用 node:net / node:tls / node:crypto / node:os / node:process，
 * 不引入任何第三方库，符合本项目的"零依赖"约束。
 *
 * 支持三种连接方式（smtpSecure）：
 *   ssl      —— 连上就是 TLS（默认端口 465）
 *   starttls —— 明文连接后 STARTTLS 升级（默认端口 587）
 *   none     —— 全明文（默认端口 25，仅调试用）
 *
 * 未配置时 createMailer 返回 null，调用方走"开发模式"（验证码直接显示在接口返回里）。
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';
/** smtpSecure → 默认端口 */
const DEFAULT_PORT = { ssl: 465, starttls: 587, none: 25 };
/** smtpSecure → 中文说明（给前端展示） */
const SECURE_LABEL = { ssl: 'SSL/TLS', starttls: 'STARTTLS', none: '明文' };
/** 取 cfg 上的字符串字段，兼容 undefined / null */
function str(value) {
  return value === undefined || value === null ? '' : String(value);
}
/* ------------------------------ 地址与编码工具 ------------------------------ */
/** 粗略但够用的邮箱格式判断（用于 smtpFrom 校验与 Message-ID 域名） */
function looksLikeEmail(value) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(str(value).trim());
}
/** 从 "名字 <a@b.com>" / "a@b.com" 里取出地址部分 */
function extractEmail(value) {
  const text = str(value).trim();
  const m = text.match(/<([^<>]+)>/);
  return (m ? m[1] : text).trim();
}
/** 是否含非 ASCII（即需要 RFC 2047 编码） */
function isNonAscii(value) {
  return /[^\x20-\x7e]/.test(str(value));
}
/** RFC 2047 B 编码：中文显示名 / 中文主题必须走这个，不能裸发 */
function rfc2047(text) {
  const raw = str(text);
  if (!isNonAscii(raw)) return raw;
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  // 折成多个 encoded-word（每个 ≤ 75 字符），避免整行超长被网关截断
  const words = [];
  for (let i = 0; i < b64.length; i += 60) words.push(`=?UTF-8?B?${b64.slice(i, i + 60)}?=`);
  return words.join('\r\n ');
}
/** 需要时给地址套上显示名："名字" <a@b.com>；显示名非 ASCII 时 RFC 2047 编码 */
function formatAddress(name, email) {
  const addr = extractEmail(email);
  const display = str(name).trim();
  if (!display) return addr;
  return `${rfc2047(display)} <${addr}>`;
}
/** base64 正文按 76 字符折行（RFC 2045） */
function base64Body(text) {
  const b64 = Buffer.from(str(text), 'utf8').toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}
/** 日期：RFC 2822 格式 */
function rfc2822Date(date = new Date()) {
  return date.toUTCString().replace(/GMT$/, '+0000');
}
/** 生成本次邮件的唯一 Message-ID */
function makeMessageId(fromEmail) {
  const domain = looksLikeEmail(fromEmail) ? extractEmail(fromEmail).split('@')[1] : (os.hostname() || 'localhost');
  return `<${Date.now().toString(36)}.${crypto.randomBytes(10).toString('hex')}@${domain}>`;
}
/** 折行一个头部：后续行以空格开头（RFC 5322 软折行） */
function foldHeader(name, value) {
  const line = `${name}: ${value}`;
  if (line.length <= 78) return line;
  const out = [];
  let rest = line;
  while (rest.length > 78) {
    let cut = rest.lastIndexOf(' ', 78);
    if (cut <= 0) cut = 78;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut + 1)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}
/**
 * 组装完整 MIME 邮件：纯文本用 text/plain；有 html 时用 multipart/alternative。
 * @param {{from:string,fromName:string,to:string,subject:string,text:string,html?:string,messageId:string}} msg
 * @returns {string} CRLF 连接的邮件原文（不含结尾的 . 终止行）
 */
function buildMime(msg) {
  const headers = [
    foldHeader('From', formatAddress(msg.fromName, msg.from)),
    foldHeader('To', extractEmail(msg.to)),
    foldHeader('Subject', rfc2047(msg.subject)), // 中文主题必须编码
    `Date: ${rfc2822Date()}`,
    `Message-ID: ${msg.messageId}`,
    'MIME-Version: 1.0',
  ];

  if (msg.html) {
    const boundary = `=_ka_${crypto.randomBytes(12).toString('hex')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const part = (type, body) => [
      `--${boundary}`,
      `Content-Type: ${type}; charset=utf-8`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(body),
    ].join('\r\n');
    return [
      ...headers,
      '',
      part('text/plain', msg.text),
      part('text/html', msg.html),
      `--${boundary}--`,
    ].join('\r\n');
  }

  headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
  return [...headers, '', base64Body(msg.text)].join('\r\n');
}
/* ------------------------------- SMTP 协议层 -------------------------------- */
/** 把一条 SMTP 响应（多行已拼接）解析成状态码 + 文本 */
function parseReply(reply) {
  const lines = str(reply).split('\r\n').filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const code = Number(last.slice(0, 3)) || 0;
  const text = lines.map((l) => l.slice(4)).join(' ').trim();
  return { code, text };
}
/** 构造带 SMTP 状态行的中文错误 */
function smtpError(what, reply) {
  return new Error(`${what}失败（${str(reply).trim()}）：请检查 SMTP 配置`);
}
/** 把网络层错误翻译成中文（保留原始错误码，便于排查） */
function connectionError(err) {
  const code = err && err.code ? `（${err.code}）` : '';
  return new Error(`SMTP 连接失败${code}：请检查 SMTP_HOST / SMTP_PORT 是否可访问`);
}

/**
 * 会话：负责一行/多行响应的读取与命令往返。holder.current 是当前 socket
 * （STARTTLS 升级后会换成 TLS socket），所有读取共用同一个 data 监听，避免漏数据。
 */
function createSession(holder, timeoutMs) {
  let buffer = '';
  let pending = null;
  let fatal = null;
  let bound = null;
  function settleReject(err) {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }
  function onData(chunk) {
    buffer += chunk.toString('utf8');
    if (!pending) return;
    while (true) {
      const idx = buffer.indexOf('\r\n');
      if (idx < 0) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      // SMTP 响应行：3 位状态码 + '-' 表示后面还有续行，+ ' ' 表示本条响应结束
      if (!/^\d{3}[ -]/.test(line)) continue;
      pending.lines.push(line);
      if (line[3] === '-') continue;
      const p = pending;
      pending = null;
      clearTimeout(p.timer);
      p.resolve(p.lines.join('\r\n')); // 多行响应整段返回，调用方才能读到能力列表
      return;
    }
  }
  /** 把监听挂到当前 socket 上（只在握手里或 STARTTLS 后各调一次） */
  function bind() {
    const sock = holder.current;
    if (bound === sock) return;
    if (bound) {
      bound.removeListener('data', onData);
      bound.removeListener('close', onClose);
      bound.removeListener('error', onError);
    }
    bound = sock;
    buffer = '';
    sock.on('data', onData);
    sock.on('close', onClose);
    sock.on('error', onError);
  }
  function onClose() {
    if (bound !== holder.current) return; // 旧明文 socket 关闭不影响已升级的连接
    settleReject(new Error('SMTP 连接被服务器关闭'));
  }
  function onError(err) {
    fatal = connectionError(err);
    settleReject(fatal);
  }
  bind();
  /** 读一条完整响应（超时由调用方的整体硬定时器 + socket 超时共同兜底） */
  function read() {
    if (fatal) return Promise.reject(fatal);
    if (pending) return Promise.reject(new Error('SMTP 读取状态冲突'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        reject(new Error(`SMTP 读取超时（${timeoutMs}ms）`));
      }, timeoutMs);
      pending = { resolve, reject, timer, lines: [] };
    });
  }
  /** 发一条命令并校验期望的状态码 */
  async function cmd(line, expectCode, what) {
    holder.current.write(`${line}\r\n`);
    const reply = await read();
    const { code } = parseReply(reply);
    if (code !== expectCode) throw smtpError(what, reply);
    return reply;
  }
  return { read, cmd, bind, fatal: () => fatal };
}

/** 建立初始连接：ssl 直接 TLS，其余先明文（starttls 稍后升级） */
function connect(cfg, host, port, secure, timeoutMs) {
  return new Promise((resolve, reject) => {
    const options = {
      host,
      port,
      // IP 不做 SNI；自签名证书场景（测试）也能连上
      servername: net.isIP(host) ? undefined : host,
    };
    if (secure === 'ssl') options.rejectUnauthorized = cfg.smtpRejectUnauthorized !== false;
    const sock = secure === 'ssl' ? tls.connect(options) : net.connect(options);
    const event = secure === 'ssl' ? 'secureConnect' : 'connect';
    const failed = (err) => reject(connectionError(err));
    sock.once('error', failed);
    sock.once(event, () => {
      sock.removeListener('error', failed);
      sock.setTimeout(timeoutMs); // 空闲超时，与整体硬定时器双保险
      resolve(sock);
    });
  });
}

/** STARTTLS：在已有明文 socket 上升级为 TLS */
function startTls(cfg, sock, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const upgraded = tls.connect({
      socket: sock,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: cfg.smtpRejectUnauthorized !== false,
    });
    upgraded.once('secureConnect', () => {
      upgraded.setTimeout(timeoutMs);
      resolve(upgraded);
    });
    upgraded.once('error', reject);
  });
}

/**
 * 创建 SMTP 邮件发送器；未配置 SMTP（mailProvider='none'，或 auto 且 smtpHost 为空）时返回 null。
 * @param {object} cfg 服务端配置（loadConfig 的返回值）
 * @returns {null | {provider:'smtp', send:(mail:{to:string,subject:string,text:string,html?:string})=>Promise<{ok:true,messageId:string}>}}
 */
export function createMailer(cfg) {
  const provider = str(cfg.mailProvider || 'auto').toLowerCase();
  if (provider === 'none') return null;
  const host = str(cfg.smtpHost).trim();
  if (!host) return null; // auto 且没填 host → 未配置

  const user = str(cfg.smtpUser).trim();
  const pass = str(cfg.smtpPass);
  const from = extractEmail(cfg.smtpFrom) || (looksLikeEmail(user) ? user : '');
  const fromName = str(cfg.smtpFromName).trim();
  const configuredTimeout = Number(cfg.smtpTimeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 15000;

  /**
   * 发送一封邮件。
   * @param {{to:string,subject:string,text:string,html?:string}} mail
   * @returns {Promise<{ok:true,messageId:string}>} 失败时抛 Error，message 是可直接展示的中文提示
   */
  async function send({ to, subject, text, html }) {
    const rcpt = extractEmail(to);
    if (!looksLikeEmail(from)) throw new Error('未配置发件邮箱（SMTP_FROM）：请在 .env 里填写');
    if (!looksLikeEmail(rcpt)) throw new Error('收件邮箱格式不正确');

    const secureRaw = str(cfg.smtpSecure).toLowerCase();
    const secure = ['ssl', 'starttls', 'none'].includes(secureRaw) ? secureRaw : 'starttls';
    const port = Number(cfg.smtpPort) > 0 ? Number(cfg.smtpPort) : DEFAULT_PORT[secure];
    const messageId = makeMessageId(from);
    const raw = buildMime({ from, fromName, to: rcpt, subject, text, html, messageId });

    // 整体硬超时：卡在任何一步都会到点断开并报错
    let hardTimer = null;
    const deadline = new Promise((_, reject) => {
      hardTimer = setTimeout(() => {
        reject(new Error(`SMTP 超时（${timeoutMs}ms）：服务器无响应，请检查 SMTP_HOST / SMTP_PORT`));
      }, timeoutMs);
    });

    const run = async () => {
      const holder = { current: await connect(cfg, host, port, secure, timeoutMs) };
      // 硬超时到点后主动断开，避免 socket 泄漏（升级后 holder.current 始终是最新的 socket）
      deadline.catch(() => { if (!holder.current.destroyed) holder.current.destroy(); });
      const session = createSession(holder, timeoutMs);

      try {
        // 1) 等服务器问候 220
        const greeting = await session.read();
        if (parseReply(greeting).code !== 220) throw smtpError('SMTP 连接', greeting);

        // 2) EHLO（服务器明确不支持时退回 HELO；网络错误照常抛出）
        let capabilities = [];
        const heloName = os.hostname() || 'localhost';
        holder.current.write(`EHLO ${heloName}\r\n`);
        const ehlo = await session.read();
        if (parseReply(ehlo).code === 250) {
          capabilities = ehlo.split('\r\n').map((l) => l.slice(4).trim().toUpperCase()).filter(Boolean);
        } else {
          await session.cmd(`HELO ${heloName}`, 250, 'HELO');
        }

        // 3) STARTTLS 升级（必须在 AUTH 之前）
        if (secure === 'starttls') {
          if (!capabilities.includes('STARTTLS')) {
            throw new Error('服务器未提供 STARTTLS：请改用 SMTP_SECURE=ssl，或设为 none（明文，不安全）');
          }
          await session.cmd('STARTTLS', 220, 'STARTTLS');
          const upgraded = await startTls(cfg, holder.current, host, timeoutMs);
          holder.current = upgraded;
          session.bind(); // 把读写切到 TLS socket 上
        }

        // 4) AUTH：配了账号才认证；机制以 EHLO 广告为准，PLAIN 优先
        if (user) {
          const mechs = capabilities
            .filter((c) => c.startsWith('AUTH ') || c.startsWith('AUTH='))
            .flatMap((c) => c.replace(/^AUTH[ =]/, '').split(/\s+/));
          const hasPlain = mechs.includes('PLAIN');
          const hasLogin = mechs.includes('LOGIN');
          if (!hasPlain && !hasLogin) {
            throw new Error('服务器未提供 AUTH PLAIN / AUTH LOGIN：请确认 SMTP_HOST 是否为企业邮箱服务器');
          }
          try {
            if (hasPlain) {
              // AUTH PLAIN <base64(\0user\0pass)>
              const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
              await session.cmd(`AUTH PLAIN ${token}`, 235, 'SMTP 认证');
            } else {
              // AUTH LOGIN：依次发 base64(用户名)、base64(密码)
              await session.cmd('AUTH LOGIN', 334, 'SMTP 认证');
              await session.cmd(Buffer.from(user, 'utf8').toString('base64'), 334, 'SMTP 认证');
              await session.cmd(Buffer.from(pass, 'utf8').toString('base64'), 235, 'SMTP 认证');
            }
          } catch (err) {
            const code = (str(err.message).match(/（(\d{3})/) || [])[1] || '未知';
            throw new Error(`SMTP 认证失败（${code}）：请检查 SMTP_USER / SMTP_PASS`);
          }
        }

        // 5) 信封：MAIL FROM / RCPT TO / DATA
        await session.cmd(`MAIL FROM:<${from}>`, 250, 'MAIL FROM');
        await session.cmd(`RCPT TO:<${rcpt}>`, 250, 'RCPT TO');
        await session.cmd('DATA', 354, 'DATA');

        // 6) 正文：CRLF 换行 + 点填充（行首的 . 再多加一个 .），以 \r\n.\r\n 结束
        const stuffed = raw.split('\r\n').map((line) => (line.startsWith('.') ? `.${line}` : line)).join('\r\n');
        holder.current.write(`${stuffed}\r\n.\r\n`);
        const done = await session.read();
        if (parseReply(done).code !== 250) throw smtpError('发送邮件', done);

        // 7) QUIT（尽力而为，服务器不回也不影响结果）
        try {
          holder.current.write('QUIT\r\n');
          await Promise.race([session.read(), new Promise((r) => setTimeout(r, 500))]);
        } catch { /* 服务器先断开就算了 */ }

        return { ok: true, messageId };
      } finally {
        if (!holder.current.destroyed) holder.current.destroy(); // 任何路径都不留悬挂连接
      }
    };

    try {
      return await Promise.race([run(), deadline]);
    } finally {
      clearTimeout(hardTimer);
    }
  }

  return { provider: 'smtp', send };
}

/**
 * 邮件能力信息（前端设置页据此提示用户）；configured=false 时后端走"开发模式"。
 * @param {object} cfg 服务端配置（loadConfig 的返回值）
 * @returns {{provider:string, configured:boolean, label:string}} label 为中文提示
 */
export function mailCapabilities(cfg) {
  const provider = str(cfg.mailProvider || 'auto').toLowerCase();
  const host = str(cfg.smtpHost).trim();
  if (provider === 'none' || !host) {
    return { provider: 'none', configured: false, label: '未配置邮箱（验证码直接显示在页面上）' };
  }
  const secure = str(cfg.smtpSecure).toLowerCase() || 'starttls';
  const port = Number(cfg.smtpPort) > 0 ? Number(cfg.smtpPort) : (DEFAULT_PORT[secure] || 587);
  const auth = str(cfg.smtpUser).trim() ? '已启用登录' : '未启用登录';
  return {
    provider: 'smtp',
    configured: true,
    label: `SMTP 邮件（${host}:${port}，${SECURE_LABEL[secure] || secure}，${auth}）`,
  };
}
