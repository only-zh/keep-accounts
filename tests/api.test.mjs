/**
 * 服务端集成测试（商业版）：账号体系 / 配额 / 邀请码 / 角色权限 / 数据隔离 / 记账与统计。
 * 自己拉起一个临时端口的服务 + 临时数据库，跑完自动清理。
 *
 * 用法：node tests/api.test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = mkdtempSync(join(tmpdir(), 'keep-accounts-api-'));

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

async function api(path, { method = 'GET', body = null, token = null } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : null });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 静态资源不是 JSON */ }
  return {
    status: res.status,
    json,
    text,
    data: json ? json.data : null,
    error: json ? json.error : null,
    code: json ? json.code : null,
  };
}

async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await api('/api/health');
      if (r.status === 200) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** 注册一个账号（测试用开发模式，验证码由接口直接返回） */
async function registerUser(name, email) {
  const codeRes = await api('/api/auth/code', { method: 'POST', body: { email, purpose: 'register' } });
  const code = codeRes.data && codeRes.data.devCode;
  const res = await api('/api/auth/register', {
    method: 'POST',
    body: { email, code, displayName: name, password: 'Passw0rd123' },
  });
  return { res, codeRes, token: res.data ? res.data.token : null, account: res.data ? res.data.account : null };
}

const server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DB_PATH: join(tmpDir, 'test.db'),
    LLM_PROVIDER: 'mock',
    ASR_PROVIDER: 'none',
    MAIL_PROVIDER: 'none', // 测试不发真邮件：走开发模式，验证码由接口返回
    DEV_SHOW_CODE: 'true',
    CODE_RESEND_SECONDS: '0',
    MAX_BOOKS_PER_ACCOUNT: '10',
    MAX_MEMBERS_PER_BOOK: '5',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

try {
  if (!await waitReady()) throw new Error(`服务未能启动：\n${serverLog}`);
  const stamp = Date.now();

  /* ============ A. 公开配置与鉴权 ============ */
  {
    const r = await api('/api/config');
    eq(r.status, 200, 'GET /api/config 200');
    eq(r.data.quotas.maxBooksPerAccount, 10, '配置：每人最多 10 个账本');
    eq(r.data.quotas.maxMembersPerBook, 5, '配置：每账本最多 5 人');
    ok(r.data.mail && typeof r.data.mail.label === 'string', '配置：返回邮件服务状态');
  }
  {
    const r = await api('/api/bootstrap');
    eq(r.status, 401, '未登录访问 /api/bootstrap → 401');
  }

  /* ============ B. 注册流程 ============ */
  const ownerEmail = `owner_${stamp}@test.com`;
  let codeForOwner = null;
  {
    const codeRes = await api('/api/auth/code', { method: 'POST', body: { email: ownerEmail } });
    eq(codeRes.status, 200, '申请注册验证码 200');
    ok(/^\d{6}$/.test(codeRes.data.devCode || ''), '开发模式返回 6 位验证码');
    codeForOwner = codeRes.data.devCode;

    const wrong = await api('/api/auth/register', {
      method: 'POST',
      body: { email: ownerEmail, code: '000000', displayName: '老板', password: 'Passw0rd123' },
    });
    ok(wrong.status === 400, '验证码错误 → 400');

    const weak = await api('/api/auth/register', {
      method: 'POST',
      body: { email: ownerEmail, code: codeForOwner, displayName: '老板', password: '123' },
    });
    ok(weak.status === 400 && /密码/.test(weak.error), '弱密码被拒绝且提示中文');

    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { email: ownerEmail, code: codeForOwner, displayName: '老板', password: 'Passw0rd123' },
    });
    eq(res.status, 200, '正确验证码注册成功');
    ok(!!res.data.token, '注册返回会话 token');
    eq(res.data.account.email, ownerEmail, '注册返回邮箱');
    eq(res.data.account.emailVerified, true, '邮箱已验证');

    // 同一邮箱再注册：邮箱已存在 → 409（不是「验证码无效」，语义更准确）
    const reuse = await api('/api/auth/register', {
      method: 'POST',
      body: { email: ownerEmail, code: codeForOwner, displayName: '老板', password: 'Passw0rd123' },
    });
    eq(reuse.status, 409, '同一邮箱再注册 → 409 已注册');

    // 验证码与邮箱绑定：拿 A 的验证码去注册 B 必须失败
    const otherEmail = `other_${stamp}@test.com`;
    const crossUse = await api('/api/auth/register', {
      method: 'POST',
      body: { email: otherEmail, code: codeForOwner, displayName: '别人', password: 'Passw0rd123' },
    });
    ok(crossUse.status === 400, '验证码不能跨邮箱使用');
  }

  let owner = null;
  {
    const login = await api('/api/auth/login', { method: 'POST', body: { email: ownerEmail, password: 'Passw0rd123' } });
    eq(login.status, 200, '登录成功');
    owner = { token: login.data.token, account: login.data.account };

    const bad = await api('/api/auth/login', { method: 'POST', body: { email: ownerEmail, password: 'wrong-pass' } });
    eq(bad.status, 401, '密码错误 → 401');

    const me = await api('/api/auth/me', { token: owner.token });
    eq(me.status, 200, 'GET /api/auth/me 200');
    eq(me.data.account.id, owner.account.id, 'me 返回本人');
    eq(me.data.stats.booksCreated, 0, '新账号已创建 0 个账本');
    eq(me.data.stats.canCreateBook, true, '可以创建账本');
  }
  {
    const dup = await api('/api/auth/code', { method: 'POST', body: { email: ownerEmail } });
    eq(dup.status, 409, '同一邮箱重复注册被拒');
  }

  /* ============ C. 账本与配额 ============ */
  let bookId = null;
  let inviteCode = null;
  {
    const r = await api('/api/books', { method: 'POST', body: { name: '家庭账本', emoji: '📒' }, token: owner.token });
    eq(r.status, 200, '创建账本成功');
    bookId = r.data.book.id;
    eq(r.data.book.role, 'owner', '创建者角色是 owner');
    eq(r.data.stats.booksCreated, 1, '已创建账本数 +1');
    inviteCode = r.data.book.inviteCode;
    ok(/^[A-Z0-9]{8}$/.test(inviteCode || ''), '返回 8 位邀请码');
  }
  {
    for (let i = 2; i <= 10; i += 1) {
      const r = await api('/api/books', { method: 'POST', body: { name: `账本${i}` }, token: owner.token });
      if (r.status !== 200) { fail += 1; failures.push(`创建第 ${i} 个账本应成功，实际 ${r.status} ${r.error}`); }
    }
    const over = await api('/api/books', { method: 'POST', body: { name: '第11个' }, token: owner.token });
    eq(over.status, 409, '超过 10 个账本 → 409');
    eq(over.code, 'BOOK_QUOTA', '配额错误码 BOOK_QUOTA');
    const list = await api('/api/books', { token: owner.token });
    eq(list.data.books.length, 10, '账本列表共 10 个');
    eq(list.data.stats.canCreateBook, false, '已达上限：canCreateBook=false');
  }

  /* ============ D. 邀请码加入与人数上限 ============ */
  const members = [];
  {
    const u = await registerUser('老婆', `wife_${stamp}@test.com`);
    eq(u.res.status, 200, '注册第二个账号成功');
    members.push(u);

    const join = await api('/api/books/join', { method: 'POST', body: { code: inviteCode }, token: u.token });
    eq(join.status, 200, '用邀请码加入成功');
    eq(join.data.book.role, 'member', '加入者角色是 member');
    eq(join.data.book.memberCount, 2, '账本人数 2');

    const again = await api('/api/books/join', { method: 'POST', body: { code: inviteCode }, token: u.token });
    eq(again.data.alreadyMember, true, '重复加入幂等');

    const bad = await api('/api/books/join', { method: 'POST', body: { code: 'ZZZZZZZZ' }, token: u.token });
    eq(bad.status, 404, '无效邀请码 → 404');
  }
  {
    for (let i = 3; i <= 5; i += 1) {
      const u = await registerUser(`成员${i}`, `m${i}_${stamp}@test.com`);
      const join = await api('/api/books/join', { method: 'POST', body: { code: inviteCode }, token: u.token });
      if (join.status !== 200) { fail += 1; failures.push(`第 ${i} 人加入失败：${join.error}`); }
      members.push(u);
    }
    const oneMore = await registerUser('第六人', `m6_${stamp}@test.com`);
    const full = await api('/api/books/join', { method: 'POST', body: { code: inviteCode }, token: oneMore.token });
    eq(full.status, 409, '超过 5 人 → 409');
    eq(full.code, 'BOOK_FULL', '满员错误码 BOOK_FULL');
  }

  /* ============ E. 记账与数据隔离 ============ */
  const wife = members[0];
  let ownerRecordId = null;
  {
    const r = await api('/api/messages', { method: 'POST', body: { text: '昨天午饭35', bookId }, token: owner.token });
    eq(r.status, 200, '创建者记账成功');
    const rec = r.data.reply.records[0];
    ownerRecordId = rec.id;
    eq(rec.amountCents, 3500, '金额 35 元');
    eq(rec.authorAccountId, owner.account.id, 'author 是发送者');
    eq(rec.payerAccountId, owner.account.id, '默认付款人是自己');
  }
  {
    const r = await api('/api/messages', { method: 'POST', body: { text: '打车 28', bookId }, token: wife.token });
    eq(r.status, 200, '普通成员也能记账');
    eq(r.data.reply.records[0].authorAccountId, wife.account.id, 'author 是成员自己');
  }
  {
    const stranger = await registerUser('路人', `stranger_${stamp}@test.com`);
    const read = await api(`/api/records?bookId=${bookId}`, { token: stranger.token });
    eq(read.status, 404, '非成员读取账本记录 → 404（数据隔离）');
    const write = await api('/api/messages', { method: 'POST', body: { text: '偷记一笔 1', bookId }, token: stranger.token });
    eq(write.status, 404, '非成员往别人账本记账 → 404');
    const noToken = await api(`/api/records?bookId=${bookId}`);
    eq(noToken.status, 401, '无 token → 401');
  }

  /* ============ F. 角色权限：改/删别人的卡片 ============ */
  {
    const r = await api(`/api/records/${ownerRecordId}`, {
      method: 'PATCH', body: { patch: { amountCents: 9900 } }, token: wife.token,
    });
    eq(r.status, 403, '普通成员修改别人的记录 → 403');
    eq(r.code, 'NOT_AUTHOR', '权限错误码 NOT_AUTHOR');

    const d = await api(`/api/records/${ownerRecordId}`, { method: 'DELETE', token: wife.token });
    eq(d.status, 403, '普通成员删除别人的记录 → 403');

    const mine = (await api(`/api/records?bookId=${bookId}`, { token: wife.token })).data
      .find((x) => x.authorAccountId === wife.account.id);
    ok(!!mine, '找到成员自己发的记录');

    const ok1 = await api(`/api/records/${mine.id}`, {
      method: 'PATCH', body: { patch: { amountCents: 2800, category: '交通' } }, token: owner.token,
    });
    eq(ok1.status, 200, '创建者可以修改任何人发送的记录');
    eq(ok1.data.record.amountCents, 2800, '创建者修改生效');

    const ok2 = await api(`/api/records/${mine.id}`, {
      method: 'PATCH', body: { patch: { amountCents: 2900 } }, token: wife.token,
    });
    eq(ok2.status, 200, '成员可以修改自己的记录');
  }
  {
    const setAdmin = await api(`/api/books/${bookId}/members/${wife.account.id}/role`, {
      method: 'POST', body: { role: 'admin' }, token: owner.token,
    });
    eq(setAdmin.status, 200, '创建者可以把成员设为管理员');
    eq(setAdmin.data.members.find((m) => m.accountId === wife.account.id).role, 'admin', '角色已变为 admin');

    const r = await api(`/api/records/${ownerRecordId}`, {
      method: 'PATCH', body: { patch: { amountCents: 3600 } }, token: wife.token,
    });
    eq(r.status, 200, '管理员可以修改任何人的记录');
    eq(r.data.record.amountCents, 3600, '管理员修改生效');

    const forbid = await api(`/api/books/${bookId}/members/${members[1].account.id}/role`, {
      method: 'POST', body: { role: 'admin' }, token: wife.token,
    });
    eq(forbid.status, 403, '管理员不能分配管理员（只有创建者可以）');
    eq(forbid.code, 'NOT_OWNER', '错误码 NOT_OWNER');

    // 管理员也可以移出普通成员（需求：管理员可以删除人员）
    const kick = await api(`/api/books/${bookId}/members/${members[1].account.id}`, { method: 'DELETE', token: wife.token });
    eq(kick.status, 200, '管理员可以移出普通成员');
    eq(kick.data.members.length, 4, '移除后剩 4 人');

    const kicked = await api(`/api/books/${bookId}/members/${members[1].account.id}`, { method: 'DELETE', token: owner.token });
    eq(kicked.status, 404, '重复移出返回 404');
  }

  /* ============ G. @ 记账权限 ============ */
  {
    const plain = members[2];
    const r = await api('/api/messages', { method: 'POST', body: { text: '@老板 买菜 30', bookId }, token: plain.token });
    eq(r.status, 200, '普通成员用 @ 发送也能成功（降级为自己记账）');
    const rec = r.data.reply.records[0];
    eq(rec.payerAccountId, plain.account.id, '普通成员的 @ 被忽略，付款人=自己');
    ok((r.data.reply.warnings || []).some((w) => /只有账本管理员/.test(w)), '给出「只有管理员可用 @」的提示');

    const r2 = await api('/api/messages', { method: 'POST', body: { text: '@老婆 买水果 40', bookId }, token: owner.token });
    const rec2 = r2.data.reply.records[0];
    eq(rec2.payerAccountId, wife.account.id, '管理员的 @ 生效，付款人=被 @ 的成员');
    eq(rec2.authorAccountId, owner.account.id, 'author 仍是发送者（决定谁能改）');
  }

  /* ============ H. 聊天查询与统计 ============ */
  {
    const r = await api('/api/messages', { method: 'POST', body: { text: '这个月花了多少', bookId }, token: owner.token });
    eq(r.data.reply.intent, 'query', '查询意图识别');
    ok(!!r.data.reply.summary, '返回统计汇总');
  }
  {
    const r = await api(`/api/stats?bookId=${bookId}&preset=month`, { token: owner.token });
    eq(r.status, 200, 'GET /api/stats 200');
    ok(r.data.expenseCents > 0, '统计有支出');
    ok(r.data.byUser.every((u) => typeof u.accountId === 'number'), '按人统计使用 accountId');
  }
  {
    const msgs = await api(`/api/messages?bookId=${bookId}`, { token: wife.token });
    eq(msgs.status, 200, '成员可以读取聊天流（群里能看到别人的卡片）');
    ok(msgs.data.some((m) => m.role === 'assistant' && (m.payload?.recordIds || []).length), '聊天流里带着别人的记账卡片');
  }

  /* ============ I. 幂等与账号设置 ============ */
  {
    const body = { text: '买水果 20', bookId, clientMsgId: `idem-${stamp}` };
    const a = await api('/api/messages', { method: 'POST', body, token: owner.token });
    const b = await api('/api/messages', { method: 'POST', body, token: owner.token });
    eq(b.data.duplicated, true, '同一个 clientMsgId 不重复记账');
    eq(b.data.userMessage.id, a.data.userMessage.id, '重试返回同一条消息');
  }
  {
    const r = await api('/api/auth/profile', { method: 'PATCH', body: { displayName: '大老板', emoji: '🦁' }, token: owner.token });
    eq(r.status, 200, '修改昵称成功');
    eq(r.data.account.displayName, '大老板', '昵称已更新');

    const r2 = await api('/api/auth/password', {
      method: 'POST', body: { oldPassword: 'Passw0rd123', newPassword: 'NewPassw0rd1' }, token: owner.token,
    });
    eq(r2.status, 200, '修改密码成功');

    const oldLogin = await api('/api/auth/login', { method: 'POST', body: { email: ownerEmail, password: 'Passw0rd123' } });
    eq(oldLogin.status, 401, '旧密码失效');
    const newLogin = await api('/api/auth/login', { method: 'POST', body: { email: ownerEmail, password: 'NewPassw0rd1' } });
    eq(newLogin.status, 200, '新密码可登录');
    owner.token = newLogin.data.token;
  }
  {
    const r = await api('/api/auth/logout', { method: 'POST', token: owner.token });
    eq(r.status, 200, '登出成功');
    const after = await api('/api/auth/me', { token: owner.token });
    eq(after.status, 401, '登出后 token 失效');
  }

  /* ============ I2. 搜索（账本 + 记录，且只搜我参与的账本） ============ */
  {
    // 上一步测了登出，这里先重新登录（密码已在 I 段改过）
    const relogin = await api('/api/auth/login', {
      method: 'POST', body: { email: ownerEmail, password: 'NewPassw0rd1' },
    });
    eq(relogin.status, 200, '登出后可用新密码重新登录');
    owner.token = relogin.data.token;

    const r = await api(`/api/search?q=${encodeURIComponent('午饭')}`, { token: owner.token });
    eq(r.status, 200, '搜索接口 200');
    ok(r.data.records.length >= 1, '搜索命中记录');
    ok(r.data.records.every((x) => x.bookName), '搜索结果带账本名');

    const byBook = await api(`/api/search?q=${encodeURIComponent('家庭账本')}`, { token: owner.token });
    ok(byBook.data.books.some((b) => b.id === bookId), '搜索可以命中账本');

    const byAmount = await api('/api/search?q=35', { token: owner.token });
    ok(byAmount.data.records.length >= 1, '搜索可以按金额命中');

    const stranger = await registerUser('搜索路人', `srch_${stamp}@test.com`);
    const scoped = await api(`/api/search?q=${encodeURIComponent('午饭')}`, { token: stranger.token });
    eq(scoped.data.records.length, 0, '搜索只返回我参与的账本里的记录');
    eq(scoped.data.books.length, 0, '搜索不会返回别人的账本');
  }

  /* ============ I3. 账本列表带「最后一条消息」（会话列表预览） ============ */
  {
    const r = await api('/api/books', { token: owner.token });
    const b = r.data.books.find((x) => x.id === bookId);
    ok(!!b.lastMessage && typeof b.lastMessage.content === 'string', '账本返回最后一条消息');
    ok(!!b.lastMessage.at, '最后一条消息带时间');
  }

  /* ============ I4. 管理员可以移出成员，且记录保留 ============ */
  {
    // owner 把「老婆」设为管理员，再用管理员身份移出第 3 位成员
    await api(`/api/books/${bookId}/members/${wife.account.id}/role`, {
      method: 'POST', body: { role: 'admin' }, token: owner.token,
    });
    const victim = members[2];
    const victimRecords = (await api(`/api/records?bookId=${bookId}`, { token: owner.token })).data
      .filter((x) => x.authorAccountId === victim.account.id);
    ok(victimRecords.length >= 1, '被移出者移出前有记录');

    const removed = await api(`/api/books/${bookId}/members/${victim.account.id}`, {
      method: 'DELETE', token: wife.token,
    });
    eq(removed.status, 200, '管理员可以移出普通成员');
    ok(!removed.data.members.some((m) => m.accountId === victim.account.id), '成员列表里已没有该成员');

    // 记录仍在，且能解析出作者名（authors）
    const after = await api(`/api/records?bookId=${bookId}`, { token: owner.token });
    const still = after.data.filter((x) => x.authorAccountId === victim.account.id);
    eq(still.length, victimRecords.length, '被移出成员的记账记录仍然保留');

    const boot = await api(`/api/bootstrap?bookId=${bookId}`, { token: owner.token });
    ok((boot.data.authors || []).some((a) => a.accountId === victim.account.id),
      '接口返回「记录里出现过但已不在成员里」的账号，用于显示作者名');

    // 被移出者无法再访问该账本
    const denied = await api(`/api/records?bookId=${bookId}`, { token: victim.token });
    eq(denied.status, 404, '被移出后无法再读取该账本');

    // 管理员不能移出创建者，也不能移出另一个管理员
    const kickOwner = await api(`/api/books/${bookId}/members/${owner.account.id}`, { method: 'DELETE', token: wife.token });
    ok(kickOwner.status === 400 || kickOwner.status === 403, '管理员不能移出创建者');
    const other = members[3];
    await api(`/api/books/${bookId}/members/${other.account.id}/role`, {
      method: 'POST', body: { role: 'admin' }, token: owner.token,
    });
    const kickAdmin = await api(`/api/books/${bookId}/members/${other.account.id}`, { method: 'DELETE', token: wife.token });
    eq(kickAdmin.status, 403, '管理员不能移出另一个管理员');
  }

  /* ============ I5. @ 帮别人记账：被@者可改 + @我 未读提醒 ============ */
  {
    // 上一步把「老婆」设成了 admin，这里让管理员用 @ 帮第 3 位成员记账
    const target = members[2 - 1];   // members[1] 已被移出，用 members[0]=wife 之外的在册成员
    const helper = members[0];       // wife（admin）
    const before = await api(`/api/bootstrap?bookId=${bookId}`, { token: helper.token });
    const victim = (before.data.members || []).find((m) => m.accountId !== helper.account.id
      && m.accountId !== owner.account.id && !m.left);

    const res = await api('/api/messages', {
      method: 'POST',
      token: helper.token,
      body: { text: `@${victim.displayName} 买菜 30`, bookId },
    });
    eq(res.status, 200, '@ 帮别人记账成功');
    const rec = res.data.reply.records[0];
    eq(rec.payerAccountId, victim.accountId, '付款人记在被@的人名下');
    eq(rec.authorAccountId, helper.account.id, '作者是帮忙记账的管理员');

    // 被 @ 的人自己可以改这条（即使不是作者、也不是管理员）
    const targetToken = (await api('/api/auth/login', {
      method: 'POST', body: { email: victim.email, password: 'Passw0rd123' },
    })).data.token;
    const patched = await api(`/api/records/${rec.id}`, {
      method: 'PATCH', token: targetToken, body: { patch: { amountCents: 3300 }, version: rec.version },
    });
    eq(patched.status, 200, '被@的人可以修改别人帮自己记的账');

    // 但不是「被@」也不是作者的普通成员仍然不能改
    const other = (before.data.members || []).find((m) => m.role === 'member'
      && m.accountId !== victim.accountId && m.accountId !== owner.account.id);
    if (other) {
      const otherToken = (await api('/api/auth/login', {
        method: 'POST', body: { email: other.email, password: 'Passw0rd123' },
      })).data.token;
      const denied = await api(`/api/records/${rec.id}`, {
        method: 'PATCH', token: otherToken, body: { patch: { amountCents: 1 }, version: patched.data.record.version },
      });
      eq(denied.status, 403, '无关成员仍然不能改别人的记录');
    }

    // @我 未读提醒
    const books = await api('/api/books', { token: targetToken });
    const b = books.data.books.find((x) => x.id === bookId);
    ok(b.unreadMentions >= 1, '被@的人在账本列表看到未读 @ 提醒');

    const read = await api(`/api/books/${bookId}/read`, { method: 'POST', token: targetToken });
    eq(read.status, 200, '标记已读成功');
    const again = await api('/api/books', { token: targetToken });
    eq(again.data.books.find((x) => x.id === bookId).unreadMentions, 0, '已读后未读 @ 清零');
  }

  /* ============ J. 验证码限流 ============ */
  {
    const email = `limit_${stamp}@test.com`;
    const first = await api('/api/auth/code', { method: 'POST', body: { email } });
    eq(first.status, 200, '新邮箱可以申请验证码');
    const second = await api('/api/auth/code', { method: 'POST', body: { email } });
    ok(second.status === 200 || second.status === 429, '重复申请被合理处理（限流或放行）');
    const badEmail = await api('/api/auth/code', { method: 'POST', body: { email: 'not-an-email' } });
    eq(badEmail.status, 400, '非法邮箱格式 → 400');
  }

  /* ============ K. 静态资源 ============ */
  for (const path of ['/', '/terms.html', '/privacy.html', '/config.js', '/qr-selftest.html', '/js/app.js', '/js/store.js', '/js/stats-page.js', '/shared/chat.js', '/shared/qr.js', '/css/styles.css', '/css/stats.css']) {
    const r = await fetch(`${BASE}${path}`);
    eq(r.status, 200, `静态资源 ${path} 200`);
  }
} catch (err) {
  fail += 1;
  failures.push(`测试执行异常：${err.message}\n${serverLog.slice(-1500)}`);
} finally {
  server.kill('SIGTERM');
  setTimeout(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }, 400);
}

console.log(`\nAPI 集成测试（商业版）：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
} else {
  console.log('全部通过 ✅');
}
