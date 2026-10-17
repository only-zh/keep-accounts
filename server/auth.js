/**
 * 账号体系：邮箱验证码、密码（scrypt 加盐）、登录会话（Bearer token）。
 * 零依赖：只用 node:crypto。
 */

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { rowToAccount } from './db.js';
import { HttpError } from './errors.js';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

/* ------------------------------------------------------------------ *
 * 密码
 * ------------------------------------------------------------------ */

/** 生成加盐哈希 */
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password), salt, KEY_LEN, SCRYPT_PARAMS).toString('hex');
  return { hash, salt };
}

/** 恒定时间比较，防时序侧信道 */
export function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  try {
    const candidate = scryptSync(String(password), salt, KEY_LEN, SCRYPT_PARAMS);
    const expected = Buffer.from(hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/** 密码强度校验（返回中文错误信息，null 表示通过） */
export function checkPasswordStrength(password) {
  const p = String(password || '');
  if (p.length < 8) return '密码至少 8 位';
  if (p.length > 64) return '密码不能超过 64 位';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return '密码需同时包含字母和数字';
  if (/^\d+$/.test(p)) return '密码不能是纯数字';
  return null;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  const e = normalizeEmail(email);
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

export function checkDisplayName(name) {
  const n = String(name || '').trim();
  if (n.length < 1) return '请填写昵称';
  if (n.length > 20) return '昵称不能超过 20 个字';
  return null;
}

function code6() {
  return String(randomInt(0, 1000000)).padStart(6, '0');
}

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return email;
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}${'*'.repeat(Math.max(1, name.length - head.length))}@${domain}`;
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

export class Auth {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {any} cfg
   * @param {null | {send:Function, provider:string}} mailer
   */
  constructor(db, cfg, mailer = null) {
    this.db = db;
    this.cfg = cfg;
    this.mailer = mailer;
  }

  /** 是否把验证码直接回显给前端（仅本地开发） */
  get devShowCode() {
    if (this.cfg.devShowCode === 'true') return true;
    if (this.cfg.devShowCode === 'false') return false;
    return !this.mailer; // auto：没配 SMTP 才回显
  }

  /* ---------------- 验证码 ---------------- */

  /**
   * 申请验证码（注册 / 找回密码）。
   * @param {string} rawEmail
   * @param {'register'|'reset'} purpose
   */
  async requestCode(rawEmail, purpose = 'register') {
    const email = normalizeEmail(rawEmail);
    if (!isValidEmail(email)) throw new HttpError(400, '邮箱格式不正确');

    const existing = this.findAccountByEmail(email);
    if (purpose === 'register' && existing) throw new HttpError(409, '这个邮箱已经注册过了，直接登录即可');
    if (purpose === 'reset' && !existing) throw new HttpError(404, '这个邮箱还没有注册');

    const now = Date.now();

    // 重发间隔
    const last = this.db.prepare(
      'SELECT * FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    ).get(email, purpose);
    if (last) {
      const elapsed = (now - new Date(last.created_at).getTime()) / 1000;
      if (elapsed < this.cfg.codeResendSeconds) {
        const wait = Math.ceil(this.cfg.codeResendSeconds - elapsed);
        throw new HttpError(429, `请求过于频繁，请 ${wait} 秒后再试`);
      }
    }

    // 每小时上限
    const hourAgo = new Date(now - 3600 * 1000).toISOString();
    const recent = this.db.prepare(
      'SELECT COUNT(*) AS c FROM email_codes WHERE email = ? AND created_at > ?',
    ).get(email, hourAgo).c;
    if (recent >= this.cfg.codeMaxPerHour) {
      throw new HttpError(429, '该邮箱一小时内申请次数过多，请稍后再试');
    }

    const code = code6();
    const expiresAt = new Date(now + this.cfg.codeTtlMinutes * 60 * 1000).toISOString();
    this.db.prepare(
      'INSERT INTO email_codes (email, code, purpose, expires_at, created_at) VALUES (?,?,?,?,?)',
    ).run(email, code, purpose, expiresAt, new Date(now).toISOString());

    const subject = purpose === 'reset' ? '记账本 · 重置密码验证码' : '记账本 · 注册验证码';
    const text = [
      `你的验证码是：${code}`,
      '',
      `有效期 ${this.cfg.codeTtlMinutes} 分钟，请勿转发给他人。`,
      '如果不是你本人操作，忽略这封邮件即可。',
    ].join('\n');

    let delivered = false;
    let warning = '';
    if (this.mailer) {
      try {
        await this.mailer.send({ to: email, subject, text });
        delivered = true;
      } catch (err) {
        warning = `邮件发送失败（${err.message}）`;
        console.warn(`[mail] 发送失败 → ${email}：${err.message}`);
      }
    }

    if (!delivered) {
      console.log(`[mail] ${this.mailer ? '发送失败，已回显' : '未配置 SMTP，开发模式'}：${maskEmail(email)} 的验证码是 ${code}`);
    }

    return {
      email,
      maskedEmail: maskEmail(email),
      delivered,
      warning: warning || undefined,
      expiresInMinutes: this.cfg.codeTtlMinutes,
      resendAfterSeconds: this.cfg.codeResendSeconds,
      // 仅开发模式回显，方便没配 SMTP 时也能跑通注册
      devCode: (this.devShowCode || !delivered) && this.devShowCode ? code : undefined,
      mailConfigured: !!this.mailer,
    };
  }

  /**
   * 校验验证码（成功后立即标记已消费）。
   * @returns {string} 规范化后的邮箱
   */
  consumeCode(rawEmail, code, purpose = 'register') {
    const email = normalizeEmail(rawEmail);
    const row = this.db.prepare(
      'SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1',
    ).get(email, purpose);
    if (!row) throw new HttpError(400, '请先获取验证码');
    if (new Date(row.expires_at).getTime() < Date.now()) throw new HttpError(400, '验证码已过期，请重新获取');
    if (row.attempts >= this.cfg.codeMaxAttempts) throw new HttpError(429, '尝试次数过多，请重新获取验证码');

    if (String(row.code) !== String(code || '').trim()) {
      this.db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      const left = Math.max(0, this.cfg.codeMaxAttempts - row.attempts - 1);
      throw new HttpError(400, `验证码不正确${left > 0 ? `，还可以试 ${left} 次` : '，请重新获取'}`);
    }
    this.db.prepare('UPDATE email_codes SET consumed_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    return email;
  }

  /* ---------------- 账号 ---------------- */

  findAccountByEmail(rawEmail) {
    const email = normalizeEmail(rawEmail);
    if (!email) return null;
    return rowToAccount(this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(email));
  }

  getAccount(id) {
    return rowToAccount(this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id)));
  }

  createAccount({ email, displayName, password, emoji = '🙂', color = '#6C8CFF', emailVerified = true }) {
    const e = normalizeEmail(email);
    const nameErr = checkDisplayName(displayName);
    if (nameErr) throw new HttpError(400, nameErr);
    const pwdErr = checkPasswordStrength(password);
    if (pwdErr) throw new HttpError(400, pwdErr);
    if (this.findAccountByEmail(e)) throw new HttpError(409, '这个邮箱已经注册过了');

    const { hash, salt } = hashPassword(password);
    const info = this.db.prepare(
      `INSERT INTO accounts (email, display_name, emoji, color, password_hash, password_salt, email_verified, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(e, String(displayName).trim(), emoji, color, hash, salt, emailVerified ? 1 : 0, new Date().toISOString());
    return this.getAccount(Number(info.lastInsertRowid));
  }

  /** 邮箱验证码注册：先把所有校验做完，最后才消费验证码（否则密码不合规就白白浪费一个码） */
  async register({ email, code, displayName, password }) {
    const e = normalizeEmail(email);
    const nameErr = checkDisplayName(displayName);
    if (nameErr) throw new HttpError(400, nameErr);
    const pwdErr = checkPasswordStrength(password);
    if (pwdErr) throw new HttpError(400, pwdErr);
    if (this.findAccountByEmail(e)) throw new HttpError(409, '这个邮箱已经注册过了');
    const verifiedEmail = this.consumeCode(e, code, 'register');
    const account = this.createAccount({ email: verifiedEmail, displayName, password });
    const token = this.createSession(account.id, 'register');
    return { account, token };
  }

  login(rawEmail, password) {
    const account = this.findAccountByEmail(rawEmail);
    if (!account) throw new HttpError(401, '邮箱或密码不正确');
    const row = this.db.prepare('SELECT password_hash, password_salt, status FROM accounts WHERE id = ?').get(account.id);
    if (row.status !== 'active') throw new HttpError(403, '账号已被停用，请联系管理员');
    if (!verifyPassword(password, row.password_hash, row.password_salt)) {
      throw new HttpError(401, '邮箱或密码不正确');
    }
    this.db.prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), account.id);
    const token = this.createSession(account.id, 'login');
    return { account: this.getAccount(account.id), token };
  }

  /** 已登录状态下改密码 */
  changePassword(accountId, oldPassword, newPassword) {
    const row = this.db.prepare('SELECT password_hash, password_salt FROM accounts WHERE id = ?').get(Number(accountId));
    if (!row) throw new HttpError(404, '账号不存在');
    if (!verifyPassword(oldPassword, row.password_hash, row.password_salt)) throw new HttpError(401, '原密码不正确');
    const err = checkPasswordStrength(newPassword);
    if (err) throw new HttpError(400, err);
    const { hash, salt } = hashPassword(newPassword);
    this.db.prepare('UPDATE accounts SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, Number(accountId));
    // 改密码后让其它设备下线，保留当前会话由调用方决定
    return true;
  }

  updateProfile(accountId, { displayName, emoji, color }) {
    const acc = this.getAccount(accountId);
    if (!acc) throw new HttpError(404, '账号不存在');
    if (displayName !== undefined) {
      const err = checkDisplayName(displayName);
      if (err) throw new HttpError(400, err);
    }
    this.db.prepare('UPDATE accounts SET display_name = ?, emoji = ?, color = ? WHERE id = ?').run(
      displayName !== undefined ? String(displayName).trim() : acc.displayName,
      emoji ?? acc.emoji,
      color ?? acc.color,
      Number(accountId),
    );
    return this.getAccount(accountId);
  }

  /* ---------------- 会话 ---------------- */

  createSession(accountId, device = '') {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO sessions (token, account_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?,?,?,?,?,?)',
    ).run(
      token,
      Number(accountId),
      new Date(now).toISOString(),
      new Date(now + this.cfg.sessionDays * 86400 * 1000).toISOString(),
      new Date(now).toISOString(),
      String(device || '').slice(0, 200),
    );
    return token;
  }

  /** 用 token 换账号；过期/失效返回 null */
  resolveSession(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(String(token));
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(row.token);
      return null;
    }
    const account = this.getAccount(row.account_id);
    if (!account || account.status !== 'active') return null;
    // 轻量刷新 last_seen（每分钟最多写一次，避免频繁写库）
    const seen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    if (Date.now() - seen > 60000) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(new Date().toISOString(), row.token);
    }
    return { account, session: row };
  }

  logout(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
  }

  logoutAll(accountId) {
    this.db.prepare('DELETE FROM sessions WHERE account_id = ?').run(Number(accountId));
  }

  /** 清理过期会话与验证码（启动时调用一次即可） */
  cleanup() {
    const now = new Date().toISOString();
    const a = this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now).changes;
    const b = this.db.prepare('DELETE FROM email_codes WHERE expires_at < ? AND created_at < ?')
      .run(now, new Date(Date.now() - 7 * 86400 * 1000).toISOString()).changes;
    return { sessions: Number(a || 0), codes: Number(b || 0) };
  }
}
