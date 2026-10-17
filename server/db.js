/**
 * 数据库：Node 22 内置 node:sqlite（零依赖）。
 *
 * 商业版结构（schema v2）：
 *   accounts       账号（邮箱 + scrypt 加盐密码）
 *   sessions       登录会话（Bearer token）
 *   email_codes    邮箱验证码
 *   books          账本（owner_account_id / invite_code）
 *   book_members   账本成员与角色（owner | admin | member）
 *   records        账目（author_account_id 谁发的 / payer_account_id 谁花的钱）
 *   messages       聊天流
 *   ai_audit       解析审计
 *
 * v1 是「本地多用户档案」结构，没有邮箱与密码，无法安全映射成账号，
 * 因此升级到 v2 时会把旧表重命名为 legacy_* 备份，业务表按新结构重建。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- ---------------- 账号与会话 ----------------
CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  emoji          TEXT DEFAULT '🙂',
  color          TEXT DEFAULT '#6C8CFF',
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  email_verified INTEGER DEFAULT 0,
  status         TEXT DEFAULT 'active',
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  account_id   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);

CREATE TABLE IF NOT EXISTS email_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL,
  code        TEXT NOT NULL,
  purpose     TEXT DEFAULT 'register',
  attempts    INTEGER DEFAULT 0,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes (email, created_at);

-- ---------------- 账本与成员 ----------------
CREATE TABLE IF NOT EXISTS books (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  emoji            TEXT DEFAULT '📒',
  owner_account_id INTEGER NOT NULL,
  invite_code      TEXT UNIQUE,
  currency         TEXT DEFAULT 'CNY',
  is_archived      INTEGER DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_books_owner ON books (owner_account_id);

CREATE TABLE IF NOT EXISTS book_members (
  book_id     INTEGER NOT NULL,
  account_id  INTEGER NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  invited_by  INTEGER,
  joined_at   TEXT NOT NULL,
  PRIMARY KEY (book_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_members_account ON book_members (account_id);

-- ---------------- 账目与消息 ----------------
CREATE TABLE IF NOT EXISTS records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id             INTEGER NOT NULL,
  author_account_id   INTEGER,
  payer_account_id    INTEGER,
  type                TEXT NOT NULL DEFAULT 'expense',
  amount_cents        INTEGER NOT NULL,
  currency            TEXT DEFAULT 'CNY',
  category            TEXT DEFAULT '其他',
  subcategory         TEXT DEFAULT '',
  merchant            TEXT DEFAULT '',
  note                TEXT DEFAULT '',
  occurred_at         TEXT NOT NULL,
  occurred_date       TEXT NOT NULL,
  occurred_time       TEXT,
  occurred_text       TEXT DEFAULT '',
  source              TEXT DEFAULT 'text',
  raw_text            TEXT DEFAULT '',
  confidence          REAL DEFAULT 1,
  status              TEXT DEFAULT 'confirmed',
  group_id            TEXT,
  client_msg_id       TEXT UNIQUE,
  version             INTEGER DEFAULT 1,
  participants_json   TEXT DEFAULT '[]',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_book_date ON records (book_id, occurred_date);
CREATE INDEX IF NOT EXISTS idx_records_payer ON records (payer_account_id);
CREATE INDEX IF NOT EXISTS idx_records_updated ON records (updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id           INTEGER,
  author_account_id INTEGER,
  role              TEXT NOT NULL,
  kind              TEXT DEFAULT 'text',
  content           TEXT,
  payload_json      TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_book ON messages (book_id, id);

CREATE TABLE IF NOT EXISTS ai_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT,
  provider      TEXT,
  model         TEXT,
  account_id    INTEGER,
  input_text    TEXT,
  output_text   TEXT,
  latency_ms    INTEGER,
  ok            INTEGER,
  error         TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export const SCHEMA_VERSION = 2;

/**
 * 打开（或创建）数据库，并做结构迁移。
 * @param {string} dbPath
 */
export function openDb(dbPath) {
  const abs = resolve(dbPath);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new DatabaseSync(abs);
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

/**
 * 结构迁移。
 * @returns {{from:number,to:number,migrated:boolean,backedUp?:boolean}}
 */
export function migrate(db) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  if (version >= SCHEMA_VERSION) return { from: version, to: version, migrated: false };

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const looksLegacy = tables.includes('records') && !tables.includes('accounts');
  if (!looksLegacy) return { from: version, to: SCHEMA_VERSION, migrated: false };

  const stamp = Date.now();
  for (const name of ['users', 'books', 'book_members', 'records', 'messages', 'ai_audit', 'settings']) {
    if (!tables.includes(name)) continue;
    try {
      db.exec(`ALTER TABLE ${name} RENAME TO legacy_${name}_${stamp}`);
    } catch { /* 忽略重命名失败 */ }
  }
  console.warn(
    `\n[数据库迁移] 检测到 v${version} 的旧结构（本地多用户档案）。\n`
    + '  旧表已重命名为 legacy_*_<时间戳> 备份，业务表按账号体系重建。\n'
    + '  旧数据不会出现在新版本里——这是刻意的：旧结构没有邮箱与密码，无法安全映射成账号。\n',
  );
  return { from: version, to: SCHEMA_VERSION, migrated: true, backedUp: true };
}

/* ------------------------------------------------------------------ *
 * 行 → API 对象
 * ------------------------------------------------------------------ */

export function rowToAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    emoji: row.emoji || '🙂',
    color: row.color || '#6C8CFF',
    emailVerified: !!row.email_verified,
    status: row.status || 'active',
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null,
  };
}

export function rowToBook(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji || '📒',
    ownerAccountId: row.owner_account_id,
    currency: row.currency || 'CNY',
    isArchived: !!row.is_archived,
    createdAt: row.created_at,
    ...extra,
  };
}

export function rowToRecord(row) {
  if (!row) return null;
  let participants = [];
  try {
    participants = JSON.parse(row.participants_json || '[]');
  } catch {
    participants = [];
  }
  return {
    id: row.id,
    bookId: row.book_id,
    authorAccountId: row.author_account_id,
    payerAccountId: row.payer_account_id,
    type: row.type,
    amountCents: row.amount_cents,
    currency: row.currency,
    category: row.category,
    subcategory: row.subcategory || '',
    merchant: row.merchant || '',
    note: row.note || '',
    occurredAt: row.occurred_at,
    occurredDate: row.occurred_date,
    occurredTime: row.occurred_time || null,
    occurredText: row.occurred_text || '',
    source: row.source,
    rawText: row.raw_text || '',
    confidence: row.confidence,
    status: row.status,
    groupId: row.group_id || null,
    clientMsgId: row.client_msg_id || null,
    version: row.version,
    participants,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

export function rowToMessage(row) {
  if (!row) return null;
  let payload = null;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    payload = null;
  }
  return {
    id: row.id,
    bookId: row.book_id,
    authorAccountId: row.author_account_id,
    role: row.role,
    kind: row.kind || 'text',
    content: row.content || '',
    payload,
    createdAt: row.created_at,
  };
}

export function rowToMember(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    bookId: row.book_id,
    role: row.role,
    displayName: row.display_name,
    email: row.email,
    emoji: row.emoji || '🙂',
    color: row.color || '#6C8CFF',
    joinedAt: row.joined_at,
  };
}
