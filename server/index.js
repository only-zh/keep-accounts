/**
 * 服务端入口：零依赖 Node HTTP 服务（商业版）。
 *
 * 鉴权：Authorization: Bearer <会话 token>（注册/登录后由 /api/auth/* 下发）
 * 数据分发：所有数据接口都要求调用方是该账本成员；角色决定能否改别人的卡片、能否用 @ 记账
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

import { loadConfig, ROOT } from './config.js';
import { openDb, SCHEMA_VERSION } from './db.js';
import { Store, HttpError, nowIso } from './store.js';
import { Auth } from './auth.js';
import { createLLM, llmCapabilities } from './adapters/llm.js';
import { createASR, asrCapabilities } from './adapters/asr.js';
import { createMailer, mailCapabilities } from './mailer.js';

import { handleChat } from '../shared/chat.js';
import { computeStats, presetRange } from '../shared/stats.js';
import { tzNow } from '../shared/date.js';

const cfg = loadConfig();
const db = openDb(resolve(ROOT, cfg.dbPath));
const store = new Store(db, cfg);
const mailer = createMailer(cfg);
const auth = new Auth(db, cfg, mailer);
const llm = createLLM(cfg);
const asr = createASR(cfg);
const cleaned = auth.cleanup();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function send(res, status, data, extraHeaders = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token, X-Client',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

const ok = (res, data) => send(res, 200, { ok: true, data });
const fail = (res, status, message, code = null) => send(res, status, { ok: false, error: message, code });

async function readBody(req, limitBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limitBytes = 512 * 1024) {
  const buf = await readBody(req, limitBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function bearerToken(req) {
  const h = String(req.headers.authorization || '');
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  if (req.headers['x-session']) return String(req.headers['x-session']).trim();
  return '';
}

/** 必须登录 */
function requireAuth(req) {
  const resolved = auth.resolveSession(bearerToken(req));
  if (!resolved || !resolved.account) throw new HttpError(401, '请先登录', 'UNAUTHORIZED');
  return resolved;
}

/** 取出并校验账本（默认取该账号最近加入的账本） */
function resolveBook(account, rawBookId) {
  const books = store.listBooksForAccount(account.id, { exposeInvite: true });
  if (!books.length) {
    if (rawBookId) throw new HttpError(404, '账本不存在或你不是成员', 'NOT_MEMBER');
    return { book: null, books, role: null };
  }
  let book = null;
  if (rawBookId) {
    book = books.find((b) => String(b.id) === String(rawBookId)) || null;
    if (!book) throw new HttpError(404, '账本不存在或你不是成员', 'NOT_MEMBER');
  } else {
    book = books[0];
  }
  return { book, books, role: book.role };
}

function configPayload() {
  return {
    version: '2.0.0',
    schemaVersion: SCHEMA_VERSION,
    tz: cfg.tz,
    serverTime: nowIso(),
    largeThresholdCents: store.largeThresholdCents,
    quotas: store.quotas,
    llm: llmCapabilities(cfg),
    asr: asrCapabilities(cfg),
    mail: mailCapabilities(cfg),
    devShowCode: auth.devShowCode,
    authRequired: true,
  };
}

/* ------------------------------------------------------------------ *
 * 路由：认证
 * ------------------------------------------------------------------ */

async function handleAuthRoutes(req, res, url, method) {
  const p = url.pathname;

  if (p === '/api/auth/code' && method === 'POST') {
    const body = await readJson(req);
    const purpose = body.purpose === 'reset' ? 'reset' : 'register';
    return ok(res, await auth.requestCode(body.email, purpose));
  }

  if (p === '/api/auth/register' && method === 'POST') {
    const body = await readJson(req);
    const { account, token } = await auth.register({
      email: body.email,
      code: body.code,
      displayName: body.displayName,
      password: body.password,
    });
    return ok(res, { token, account, stats: store.accountStats(account.id), books: store.listBooksForAccount(account.id) });
  }

  if (p === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    const { account, token } = auth.login(body.email, body.password);
    return ok(res, { token, account, stats: store.accountStats(account.id), books: store.listBooksForAccount(account.id) });
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    auth.logout(bearerToken(req));
    return ok(res, { loggedOut: true });
  }

  if (p === '/api/auth/me' && method === 'GET') {
    const { account } = requireAuth(req);
    return ok(res, {
      account,
      stats: store.accountStats(account.id),
      books: store.listBooksForAccount(account.id, { exposeInvite: true }),
    });
  }

  if (p === '/api/auth/profile' && method === 'PATCH') {
    const { account } = requireAuth(req);
    const body = await readJson(req);
    return ok(res, {
      account: auth.updateProfile(account.id, { displayName: body.displayName, emoji: body.emoji, color: body.color }),
    });
  }

  if (p === '/api/auth/password' && method === 'POST') {
    const { account } = requireAuth(req);
    const body = await readJson(req);
    auth.changePassword(account.id, body.oldPassword, body.newPassword);
    auth.logoutAll(account.id); // 其它设备下线
    const token = auth.createSession(account.id, 'change-password');
    return ok(res, { changed: true, token });
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 路由：账本与成员
 * ------------------------------------------------------------------ */

async function handleBookRoutes(req, res, url, method) {
  const p = url.pathname;

  if (p === '/api/books' && method === 'GET') {
    const { account } = requireAuth(req);
    return ok(res, {
      books: store.listBooksForAccount(account.id, { exposeInvite: true }),
      stats: store.accountStats(account.id),
      quotas: store.quotas,
    });
  }

  if (p === '/api/books' && method === 'POST') {
    const { account } = requireAuth(req);
    const body = await readJson(req);
    const book = store.createBook(account.id, { name: body.name, emoji: body.emoji });
    return ok(res, { book, stats: store.accountStats(account.id) });
  }

  if (p === '/api/books/join' && method === 'POST') {
    const { account } = requireAuth(req);
    const body = await readJson(req);
    const result = store.joinByInviteCode(account.id, body.code);
    return ok(res, { ...result, stats: store.accountStats(account.id) });
  }

  let m = p.match(/^\/api\/books\/(\d+)$/);
  if (m && method === 'PATCH') {
    const { account } = requireAuth(req);
    const body = await readJson(req);
    return ok(res, { book: store.updateBook(m[1], account.id, body) });
  }

  m = p.match(/^\/api\/books\/(\d+)\/members$/);
  if (m && method === 'GET') {
    const { account } = requireAuth(req);
    const membership = store.assertMember(m[1], account.id);
    return ok(res, { members: store.listMembers(m[1]), quotas: store.quotas, myRole: membership.role });
  }

  m = p.match(/^\/api\/books\/(\d+)\/members\/(\d+)\/role$/);
  if (m && method === 'POST') {
    const { account } = requireAuth(req);
    const body = await readJson(req);
    return ok(res, { members: store.setMemberRole(m[1], account.id, m[2], body.role) });
  }

  m = p.match(/^\/api\/books\/(\d+)\/members\/(\d+)$/);
  if (m && method === 'DELETE') {
    const { account } = requireAuth(req);
    return ok(res, { members: store.removeMember(m[1], account.id, m[2]) });
  }

  m = p.match(/^\/api\/books\/(\d+)\/invite-code$/);
  if (m && method === 'POST') {
    const { account } = requireAuth(req);
    return ok(res, { inviteCode: store.resetInviteCode(m[1], account.id) });
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 路由：数据（账本内）
 * ------------------------------------------------------------------ */

async function handleDataRoutes(req, res, url, method) {
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams.entries());

  if (p === '/api/bootstrap' && method === 'GET') {
    const { account } = requireAuth(req);
    const { book, books, role } = resolveBook(account, q.bookId);
    if (!book) {
      return ok(res, {
        config: configPayload(),
        account,
        stats: store.accountStats(account.id),
        books: [],
        book: null,
        role: null,
        members: [],
        records: [],
        messages: [],
      });
    }
    return ok(res, {
      config: configPayload(),
      account,
      stats: store.accountStats(account.id),
      books,
      book,
      role,
      members: store.listMembers(book.id),
      authors: store.listRecordAuthors(book.id),
      records: store.listRecords({ bookId: book.id, limit: 5000 }),
      messages: store.listMessages({ bookId: book.id, limit: 200 }),
      serverTime: nowIso(),
    });
  }

  if (p === '/api/sync' && method === 'GET') {
    const { account } = requireAuth(req);
    const { book, role } = resolveBook(account, q.bookId);
    if (!book) return ok(res, { records: [], messages: [], serverTime: nowIso(), book: null, role: null });
    const records = store.listRecords({ bookId: book.id, since: q.since || null, limit: 20000, includeDeleted: true });
    const allMessages = store.listMessages({ bookId: book.id, limit: 200 });
    const messages = q.since ? allMessages.filter((msg) => String(msg.createdAt) > String(q.since)) : allMessages;
    return ok(res, {
      serverTime: nowIso(),
      since: q.since || null,
      book,
      role,
      members: store.listMembers(book.id),
      authors: store.listRecordAuthors(book.id),
      records,
      messages,
      deletedIds: records.filter((r) => r.deletedAt).map((r) => r.id),
    });
  }

  if (p === '/api/messages' && method === 'GET') {
    const { account } = requireAuth(req);
    const { book } = resolveBook(account, q.bookId);
    if (!book) return ok(res, []);
    return ok(res, store.listMessages({ bookId: book.id, before: q.before || null, limit: q.limit || 200 }));
  }

  if (p === '/api/messages' && method === 'POST') {
    const { account } = requireAuth(req);
    const body = await readJson(req);
    const { book, role } = resolveBook(account, body.bookId);
    if (!book) throw new HttpError(400, '你还没有加入任何账本，请先创建一个或输入邀请码加入', 'NO_BOOK');
    const text = String(body.text || '').trim();
    if (!text) throw new HttpError(400, '内容不能为空');
    if (text.length > 500) throw new HttpError(400, '单条内容不能超过 500 字');

    const clientMsgId = body.clientMsgId || null;

    // 幂等：网络重试时同一条输入不会重复记账
    if (clientMsgId) {
      const messages = store.listMessages({ bookId: book.id, limit: 200 });
      const dup = messages.find((msg) => msg.role === 'user' && msg.payload && msg.payload.clientMsgId === clientMsgId);
      if (dup) {
        const next = messages.find((msg) => msg.id > dup.id && msg.role === 'assistant');
        return ok(res, { userMessage: dup, assistantMessage: next || null, duplicated: true });
      }
    }

    const userMessage = store.insertMessage({
      bookId: book.id, authorAccountId: account.id, role: 'user', kind: 'text',
      content: text, payload: { source: body.source || 'text', clientMsgId },
    });

    const reply = await handleChat({
      text,
      book,
      account,
      role,
      source: body.source || 'text',
      clientMsgId,
      store,
      llm,
      cfg: { tz: cfg.tz, model: cfg.deepseekModel, largeThresholdCents: store.largeThresholdCents },
    });

    const assistantMessage = store.insertMessage({
      bookId: book.id, authorAccountId: null, role: 'assistant',
      kind: reply.action === 'created' ? 'record' : reply.action,
      content: reply.text || '',
      payload: {
        engine: reply.engine,
        warnings: reply.warnings,
        intent: reply.intent,
        action: reply.action,
        recordIds: (reply.records || []).map((r) => r.id),
        clarification: reply.clarification,
        query: reply.query,
        summary: reply.summary,
      },
    });

    return ok(res, { userMessage, assistantMessage, reply, engine: reply.engine, warnings: reply.warnings });
  }

  if (p === '/api/records' && method === 'GET') {
    const { account } = requireAuth(req);
    const { book } = resolveBook(account, q.bookId);
    if (!book) return ok(res, []);
    return ok(res, store.listRecords({
      bookId: book.id,
      from: q.from, to: q.to, since: q.since,
      payerAccountId: q.payerAccountId || q.userId,
      authorAccountId: q.authorAccountId,
      category: q.category, type: q.type, q: q.q,
      limit: q.limit, offset: q.offset,
      includeDeleted: q.includeDeleted === '1',
    }));
  }

  let m = p.match(/^\/api\/records\/(\d+)$/);
  if (m && method === 'GET') {
    const { account } = requireAuth(req);
    const rec = store.getRecord(m[1]);
    if (!rec) throw new HttpError(404, '记录不存在');
    store.assertMember(rec.bookId, account.id);
    return ok(res, { record: rec, canEdit: store.canEditRecord(rec, account.id) });
  }

  if (m && method === 'PATCH') {
    const { account } = requireAuth(req);
    const body = await readJson(req);
    const rec = store.updateRecord(m[1], body.patch || body, body.version, account.id);
    return ok(res, { record: rec, canEdit: store.canEditRecord(rec, account.id) });
  }

  if (m && method === 'DELETE') {
    const { account } = requireAuth(req);
    return ok(res, { record: store.softDeleteRecord(m[1], account.id) });
  }

  m = p.match(/^\/api\/records\/(\d+)\/restore$/);
  if (m && method === 'POST') {
    const { account } = requireAuth(req);
    return ok(res, { record: store.restoreRecord(m[1], account.id) });
  }

  if (p === '/api/search' && method === 'GET') {
    const { account } = requireAuth(req);
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return ok(res, { books: [], records: [] });
    if (q.length > 50) throw new HttpError(400, '搜索词太长');
    return ok(res, store.search(account.id, q));
  }

  if (p === '/api/stats' && method === 'GET') {
    const { account } = requireAuth(req);
    const { book } = resolveBook(account, q.bookId);
    if (!book) return ok(res, null);
    const now = tzNow(cfg.tz);
    const preset = q.preset ? presetRange(q.preset, now.ymd) : null;
    const range = {
      from: q.from || preset?.from || '1970-01-01',
      to: q.to || preset?.to || now.ymd,
    };
    const all = store.listRecords({ bookId: book.id, limit: 20000 });
    return ok(res, computeStats(all, {
      from: range.from,
      to: range.to,
      users: store.listMembers(book.id).map((mm) => ({ id: mm.accountId, name: mm.displayName, emoji: mm.emoji })),
      largeThresholdCents: store.largeThresholdCents,
      filters: {
        bookId: book.id,
        categories: q.category ? [q.category] : undefined,
        accountIds: q.accountId ? [Number(q.accountId)] : undefined,
        types: q.type ? [q.type] : undefined,
        keyword: q.q || undefined,
        minCents: q.min != null && q.min !== '' ? Math.round(Number(q.min) * 100) : undefined,
        maxCents: q.max != null && q.max !== '' ? Math.round(Number(q.max) * 100) : undefined,
        largeOnly: q.large === '1',
      },
    }));
  }

  if (p === '/api/asr' && method === 'POST') {
    requireAuth(req);
    if (!asr) {
      return fail(res, 501, '服务端还没有配置语音识别。可以在 .env 里设置 ASR_PROVIDER=openai-compatible，或改用文字输入。', 'ASR_NOT_CONFIGURED');
    }
    const buf = await readBody(req, 25 * 1024 * 1024);
    if (!buf.length) throw new HttpError(400, '没有收到音频数据');
    const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
    const started = Date.now();
    try {
      const text = await asr.transcribe(buf, mime, { durationMs: Number(req.headers['x-audio-duration'] || 0) });
      store.audit({
        kind: 'asr', provider: asr.provider, model: asr.model,
        inputText: `${buf.length}B ${mime}`, outputText: text, latencyMs: Date.now() - started, ok: true,
      });
      return ok(res, { text, provider: asr.provider, model: asr.model, latencyMs: Date.now() - started });
    } catch (err) {
      store.audit({
        kind: 'asr', provider: asr.provider, model: asr.model,
        inputText: `${buf.length}B ${mime}`, outputText: '', latencyMs: Date.now() - started, ok: false, error: err.message,
      });
      return fail(res, 502, `语音识别失败：${err.message}`, 'ASR_FAILED');
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * API 总入口
 * ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const p = url.pathname;

  if (p === '/api/health') return ok(res, { status: 'ok', serverTime: nowIso(), schemaVersion: SCHEMA_VERSION });
  if (p === '/api/config') return ok(res, configPayload());

  // 可选的额外接口口令（私有部署用，和账号体系叠加）
  if (cfg.authToken && req.headers['x-auth-token'] !== cfg.authToken) {
    return fail(res, 401, '访问口令不正确', 'AUTH');
  }

  if (p.startsWith('/api/auth/')) {
    const handled = await handleAuthRoutes(req, res, url, method);
    if (handled !== null) return handled;
  } else if (p.startsWith('/api/books')) {
    const handled = await handleBookRoutes(req, res, url, method);
    if (handled !== null) return handled;
  } else if (p.startsWith('/api/')) {
    const handled = await handleDataRoutes(req, res, url, method);
    if (handled !== null) return handled;
  }

  return fail(res, 404, `接口不存在：${method} ${p}`);
}

/* ------------------------------------------------------------------ *
 * 静态资源
 * ------------------------------------------------------------------ */

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const isShared = rel.startsWith('/shared/');
  const allowed = resolve(isShared ? join(ROOT, 'shared') : join(ROOT, 'public'));
  const sub = isShared ? rel.slice('/shared/'.length) : rel.replace(/^\/+/, '');
  const target = resolve(join(allowed, sub));
  if (target !== allowed && !target.startsWith(allowed + sep)) {
    return send(res, 403, { ok: false, error: '禁止访问' });
  }
  try {
    const st = await stat(target);
    if (!st.isFile()) throw new Error('not a file');
    const buf = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    return res.end(buf);
  } catch {
    return send(res, 404, { ok: false, error: '资源不存在' });
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token, X-Client',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[error]', req.method, url.pathname, err);
    return fail(res, status, err.message || '服务器内部错误', err.code || null);
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log('┌───────────────────────────────────────────────');
  console.log('│ 记账服务已启动（商业版 · 账号 + 多账本）');
  console.log(`│ 本机访问:   http://127.0.0.1:${cfg.port}`);
  console.log(`│ 数据库:     ${resolve(ROOT, cfg.dbPath)}`);
  console.log(`│ 大模型:     ${llmCapabilities(cfg).label}`);
  console.log(`│ 邮件:       ${mailCapabilities(cfg).label}`);
  console.log(`│ 语音识别:   ${asrCapabilities(cfg).label}`);
  console.log(`│ 配额:       每人最多 ${cfg.maxBooksPerAccount} 个账本 / 每账本最多 ${cfg.maxMembersPerBook} 人`);
  if (cleaned.sessions || cleaned.codes) {
    console.log(`│ 已清理:     ${cleaned.sessions} 个过期会话 / ${cleaned.codes} 条过期验证码`);
  }
  console.log('└───────────────────────────────────────────────');
});

process.on('SIGINT', () => {
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
});

export { server, store, auth };
