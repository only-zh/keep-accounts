/**
 * 配置：读取 .env（手写解析，零依赖）+ 环境变量覆盖。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 解析 .env 文件内容 */
export function parseEnvFile(content) {
  const out = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadConfig(envPath = resolve(ROOT, '.env')) {
  const fileEnv = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  const get = (key, fallback = '') => (process.env[key] !== undefined && process.env[key] !== ''
    ? String(process.env[key])
    : (fileEnv[key] !== undefined && fileEnv[key] !== '' ? String(fileEnv[key]) : fallback));

  const num = (key, fallback) => {
    const raw = get(key, '');
    if (raw === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };

  return {
    root: ROOT,
    envPath,
    port: num('PORT', 8787),
    host: get('HOST', '0.0.0.0'),
    dbPath: get('DB_PATH', './data/ledger.db'),
    tz: get('TZ', 'Asia/Shanghai'),
    authToken: get('AUTH_TOKEN', ''),

    llmProvider: get('LLM_PROVIDER', 'auto').toLowerCase(),
    deepseekApiKey: get('DEEPSEEK_API_KEY', ''),
    deepseekBaseUrl: get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    deepseekModel: get('DEEPSEEK_MODEL', 'deepseek-chat'),
    llmTimeoutMs: num('LLM_TIMEOUT_MS', 45000),

    asrProvider: get('ASR_PROVIDER', 'none').toLowerCase(),
    asrBaseUrl: get('ASR_BASE_URL', ''),
    asrApiKey: get('ASR_API_KEY', ''),
    asrModel: get('ASR_MODEL', 'whisper-1'),
    asrLanguage: get('ASR_LANGUAGE', 'zh'),
    asrTimeoutMs: num('ASR_TIMEOUT_MS', 60000),

    // ---- 邮件（注册验证码）----
    mailProvider: get('MAIL_PROVIDER', 'auto').toLowerCase(),
    smtpHost: get('SMTP_HOST', ''),
    smtpPort: num('SMTP_PORT', 465),
    smtpSecure: get('SMTP_SECURE', 'ssl').toLowerCase(),
    smtpUser: get('SMTP_USER', ''),
    smtpPass: get('SMTP_PASS', ''),
    smtpFrom: get('SMTP_FROM', ''),
    smtpFromName: get('SMTP_FROM_NAME', '记账本'),
    smtpTimeoutMs: num('SMTP_TIMEOUT_MS', 15000),
    smtpRejectUnauthorized: get('SMTP_REJECT_UNAUTHORIZED', 'true') !== 'false',

    // ---- 账号与配额 ----
    maxBooksPerAccount: num('MAX_BOOKS_PER_ACCOUNT', 10),
    maxMembersPerBook: num('MAX_MEMBERS_PER_BOOK', 5),
    sessionDays: num('SESSION_DAYS', 30),
    codeTtlMinutes: num('CODE_TTL_MINUTES', 10),
    codeResendSeconds: num('CODE_RESEND_SECONDS', 60),
    codeMaxPerHour: num('CODE_MAX_PER_HOUR', 6),
    codeMaxAttempts: num('CODE_MAX_ATTEMPTS', 5),
    devShowCode: get('DEV_SHOW_CODE', 'auto').toLowerCase(),

    largeThresholdCents: num('LARGE_THRESHOLD_CENTS', 5000),
    defaultUserName: get('DEFAULT_USER_NAME', '我'),
    defaultBookName: get('DEFAULT_BOOK_NAME', '家庭账本'),
  };
}
