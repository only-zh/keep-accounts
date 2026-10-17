/**
 * 示例数据生成器（商业版）：注册两个演示账号、建一个账本、邀请第二人加入、灌一批中文记账语句。
 *
 * 用法：
 *   node tools/seed-demo.mjs                       # 连 http://127.0.0.1:8787
 *   node tools/seed-demo.mjs http://127.0.0.1:8788
 *
 * 前置条件：服务端必须处于「开发模式」（未配置 SMTP 或 DEV_SHOW_CODE=true），
 * 这样验证码会随接口返回；生产环境请勿运行。
 */

const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || 'http://127.0.0.1:8787').replace(/\/+$/, '');

const OWNER = {
  email: process.env.SEED_EMAIL || 'demo@example.com',
  name: '我',
  emoji: '🙂',
  password: process.env.SEED_PASSWORD || 'Demo123456',
};
const WIFE = { email: 'wife@demo.local', name: '老婆', emoji: '👩', password: 'Demo123456' };

const MESSAGES = [
  '10月1号早饭12', '10月1号打车35', '10月2号午饭28', '10月2号买菜86', '10月3号奶茶18',
  '10月3号电影票90', '10月4号房租3500', '10月5号加油280', '10月5号午饭32', '10月6号超市购物156',
  '10月7号晚饭聚餐268', '10月8号地铁6', '10月8号咖啡25', '10月9号话费100', '10月10号买衣服399',
  '10月10号午饭26', '10月11号理发45', '10月11号水果32', '10月12号早饭9', '10月12号打车22',
  '10月12号晚饭68', '10月13号午饭36', '10月13号药费78', '10月13号买书59', '10月13号 牛奶 45',
];

const WIFE_MESSAGES = ['10月4号 护肤品 520', '10月11号 水果 46', '10月13号 看电影 96'];

async function call(path, { method = 'GET', body = null, token = null } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : null });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || (json && json.ok === false)) {
    throw new Error(`${path} → HTTP ${res.status} ${json ? json.error : text.slice(0, 120)}`);
  }
  return json ? json.data : null;
}

async function login(user) {
  try {
    const data = await call('/api/auth/login', { method: 'POST', body: { email: user.email, password: user.password } });
    return { token: data.token, account: data.account };
  } catch {
    return null;
  }
}

async function ensureAccount(user) {
  const existing = await login(user);
  if (existing) return existing;
  const codeRes = await call('/api/auth/code', { method: 'POST', body: { email: user.email } });
  if (!codeRes.devCode) {
    throw new Error('服务端不是开发模式，拿不到验证码；请用 MAIL_PROVIDER=none DEV_SHOW_CODE=true 启动后再灌数据');
  }
  const data = await call('/api/auth/register', {
    method: 'POST',
    body: { email: user.email, code: codeRes.devCode, displayName: user.name, password: user.password },
  });
  return { token: data.token, account: data.account };
}

async function main() {
  const health = await call('/api/health').catch(() => null);
  if (!health) throw new Error(`服务不可用：${BASE}（先运行 node server/index.js）`);
  const cfg = await call('/api/config');
  if (!cfg.devShowCode) throw new Error('服务端不是开发模式（DEV_SHOW_CODE=false），本脚本无法自动注册演示账号');

  const owner = await ensureAccount(OWNER);
  const wife = await ensureAccount(WIFE);
  console.log(`账号就绪：${OWNER.name}（${OWNER.email}）、${WIFE.name}（${WIFE.email}）`);

  const list = await call('/api/books', { token: owner.token });
  let book = list.books.find((b) => b.name === '家庭账本');
  if (!book) {
    const created = await call('/api/books', { method: 'POST', body: { name: '家庭账本', emoji: '📒' }, token: owner.token });
    book = created.book;
  }
  console.log(`账本：${book.name}（id=${book.id}，邀请码 ${book.inviteCode}）`);

  const members = await call(`/api/books/${book.id}/members`, { token: owner.token });
  if (!members.members.some((m) => m.accountId === wife.account.id)) {
    await call('/api/books/join', { method: 'POST', body: { code: book.inviteCode }, token: wife.token });
    console.log('老婆已用邀请码加入账本');
  }

  const existing = await call(`/api/records?bookId=${book.id}`, { token: owner.token });
  if (existing.length > 0) {
    console.log(`账本已有 ${existing.length} 条记录，跳过灌数据`);
  } else {
    for (const text of MESSAGES) {
      await call('/api/messages', { method: 'POST', body: { text, bookId: book.id }, token: owner.token });
    }
    for (const text of WIFE_MESSAGES) {
      await call('/api/messages', { method: 'POST', body: { text, bookId: book.id }, token: wife.token });
    }
    console.log(`已灌入 ${MESSAGES.length + WIFE_MESSAGES.length} 条记录`);
  }

  const stats = await call(`/api/stats?bookId=${book.id}&preset=month`, { token: owner.token });
  console.log(`\n本月支出 ¥${(stats.expenseCents / 100).toFixed(2)}｜笔数 ${stats.count}｜餐食占比 ${(stats.meal.share * 100).toFixed(1)}%｜大额 ${stats.large.count} 笔`);
  console.log(`\n登录账号：${OWNER.email} / ${OWNER.password}`);
  console.log(`第二个账号：${WIFE.email} / ${WIFE.password}（普通成员，可用来验证权限）`);
  console.log(`邀请码：${book.inviteCode}`);
}

main().catch((err) => {
  console.error(`示例数据生成失败：${err.message}`);
  process.exit(1);
});
