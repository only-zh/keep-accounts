/**
 * App 主逻辑（会话式界面）。
 *
 * 页面结构：
 *   账本列表（首页，底部 tab：账本 / 设置）
 *     └─ 点击账本 → 群聊页（返回 / 明细 / 成员）
 *          ├─ 明细页 → 统计页
 *          └─ 成员面板（邀请码 + 二维码 + 管理成员）
 *   首页右上角：搜索（账本 + 记录）、创建/加入账本（邀请码或扫一扫）
 *   设置页：头像（预设）、昵称、密码、服务器、退出登录
 */

import { createStore, LS } from './store.js';
import { prefs } from './db.js';
import { createRecorder, recorderSupported } from './recorder.js';
import { CATEGORY_TREE, iconOf } from '../../shared/categories.js';
import { formatMoney } from './charts.js';
import { qrSvg, extractInviteCode } from '../../shared/qr.js';

const $ = (sel) => document.querySelector(sel);

const store = createStore();

/** 账本图标（预设，不允许自定义） */
const BOOK_ICONS = ['📒', '📗', '📘', '📙', '🏠', '🚗', '🍚', '🛍️', '✈️', '🎮', '💊', '📚', '🎁', '🐱', '💼', '🔨', '🧾', '🎓'];
/** 头像（预设，不允许自定义） */
const AVATAR_ICONS = ['🙂', '😀', '😄', '😎', '🤓', '🐯', '🐱', '🐶', '🐼', '🦁', '🐷', '🐰'];

let recorder = null;
let recState = 'idle';
let pendingItems = [];
let statsPage = null;
let statsPromise = null;
let toastTimer = null;
let codeTimer = null;
let searchTimer = null;
let chatPollTimer = null;
let syncing = false;
let searchResults = null;
let scanner = null;

/* ==================================================================== *
 * 通用工具
 * ==================================================================== */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // 仅用于写死的静态内容
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
const haptic = (ms = 12) => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };
const pad2 = (n) => String(n).padStart(2, '0');

let toastHideTimer = null;

function toast(message, action = null, duration = 3600) {
  const box = $('#toast');
  clear(box);
  box.append(el('span', { text: message }));
  if (action) {
    box.append(el('button', { type: 'button', text: action.label, onclick: () => { hideToast(); action.onClick(); } }));
  }
  if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null; }
  box.classList.remove('hidden', 'is-hiding');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  const box = $('#toast');
  if (!box || box.classList.contains('hidden')) return;
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (toastHideTimer) clearTimeout(toastHideTimer);
  box.classList.add('is-hiding');
  toastHideTimer = setTimeout(() => {
    box.classList.add('hidden');
    box.classList.remove('is-hiding');
    toastHideTimer = null;
  }, reduceMotion() ? 0 : 200);
}

const roleLabel = (role) => ({ owner: '创建者', admin: '管理员', member: '成员' }[role] || '成员');

/** 布布助手头像（所有 assistant 消息共用） */
const bubuAvatar = () => el('div', { class: 'avatar' }, [
  el('img', { src: './img/bubu.svg', alt: '' }),
]);

/** 金额从 0 滚到目标值，让数字也有“呼吸感” */
function animateCount(node, cents, duration = 640) {
  if (!node) return;
  if (reduceMotion()) { node.textContent = formatMoney(cents); return; }
  const target = Number(cents) || 0;
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = formatMoney(Math.round(target * eased));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function fmtClock(iso) {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 会话列表里的时间：今天 HH:MM / 昨天 / 周X / MM-DD */
function fmtListTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date(`${store.today}T00:00:00`);
  const thatDay = new Date(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T00:00:00`);
  const diff = Math.round((today - thatDay) / 86400000);
  if (diff <= 0) return fmtClock(iso);
  if (diff === 1) return '昨天';
  if (diff < 7) return `周${'日一二三四五六'[d.getDay()]}`;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtDayLabel(date) {
  const today = store.today;
  if (date === today) return '今天';
  const y = new Date(`${today}T00:00:00`);
  y.setDate(y.getDate() - 1);
  const ymd = `${y.getFullYear()}-${pad2(y.getMonth() + 1)}-${pad2(y.getDate())}`;
  return date === ymd ? '昨天' : date;
}

/** 把技术性错误翻译成用户能理解的一句话 */
function friendlyReason(err) {
  if (!err) return '发送失败';
  if (err.code === 'OFFLINE' || err.status === 0 || !err.status) return '网络不可用';
  if (err.status === 401) return '登录已过期，请重新登录';
  if (err.status === 403) return '没有权限';
  if (err.status === 409) return '这条已经发送过了';
  if (err.status === 429) return '操作太频繁，稍后再试';
  if (err.status >= 500) return '服务暂时不可用';
  return '发送失败';
}

function amountText(rec) {
  const sign = rec.type === 'income' || rec.type === 'refund' ? '+' : '-';
  return `${sign}${formatMoney(rec.amountCents)}`;
}

/* ==================================================================== *
 * 页面导航（带历史栈，安卓返回键也能用）
 * ==================================================================== */

const PAGE_IDS = {
  books: 'pageBooks',
  settings: 'pageSettings',
  chat: 'pageChat',
  detail: 'pageDetail',
  stats: 'pageStats',
  search: 'pageSearch',
};
const ROOT_PAGES = ['books', 'settings'];

let pageStack = ['books'];
const currentPage = () => pageStack[pageStack.length - 1] || 'books';

/** 是否开启了「减少动态效果」 */
function reduceMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

let pageTransition = 'tab';
let paintedPage = null;

/** 聊天页每 5 秒增量同步一次，别人发的新消息不用退出重进就能看到 */
function startChatPolling() {
  stopChatPolling();
  chatPollTimer = setInterval(async () => {
    if (document.hidden || syncing || !store.online) return;
    syncing = true;
    try {
      await store.sync();
      const b = store.books.find((x) => store.book && String(x.id) === String(store.book.id));
      if (b && b.unreadMentions) await store.markRead();
    } catch { /* 网络抖动忽略，下一轮再试 */ } finally { syncing = false; }
  }, 5000);
}

function stopChatPolling() {
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
}

function paintPage(name) {
  if (name !== 'chat') stopChatPolling();
  const entering = paintedPage !== name;
  const animate = entering && !reduceMotion();
  for (const [key, id] of Object.entries(PAGE_IDS)) {
    const node = $(`#${id}`);
    node.classList.remove('is-entering-forward', 'is-entering-back', 'is-entering-tab');
    node.classList.toggle('hidden', key !== name);
    if (key === name && animate) {
      void node.offsetWidth; // 强制重排，确保动画从下一帧开始
      node.classList.add(`is-entering-${pageTransition}`);
    }
  }
  paintedPage = name;
  const root = ROOT_PAGES.includes(name);
  $('#tabbar').classList.toggle('hidden', !root);
  $('#tabBooks').classList.toggle('active', name === 'books');
  $('#tabSettings').classList.toggle('active', name === 'settings');
  if (name === 'books') renderBooks();
  if (name === 'settings') renderSettings();
  if (name === 'chat') { renderChat(); startChatPolling(); }
  if (name === 'detail') renderDetail();
  if (name === 'stats') {
    if (entering) $('#statsMount').scrollTop = 0;
    mountStats();
  }
  if (name === 'search') setTimeout(() => $('#searchInput').focus(), 30);
}

/** 进入子页面（可返回） */
function navigate(name) {
  if (currentPage() === name) { paintPage(name); return; }
  pageTransition = 'forward';
  pageStack.push(name);
  try { history.pushState({ page: name }, ''); } catch { /* ignore */ }
  paintPage(name);
}

/** 返回上一页（没有上一页则回首页） */
function goBack() {
  if (pageStack.length > 1) {
    try { history.back(); return; } catch { /* ignore */ }
  }
  switchTab('books');
}

/** 底部 tab 切换（回到根页面） */
function switchTab(name) {
  pageTransition = 'tab';
  pageStack = [name];
  try { history.replaceState({ page: name }, ''); } catch { /* ignore */ }
  paintPage(name);
}

window.addEventListener('popstate', () => {
  // 扫码浮层打开时，返回键先关浮层
  if (scanner) { scanner(); return; }
  pageTransition = 'back';
  if (pageStack.length > 1) {
    pageStack.pop();
    paintPage(currentPage());
  } else {
    paintPage('books');
  }
});

/* ==================================================================== *
 * 认证页
 * ==================================================================== */

function showAuthError(id, message) {
  const box = $(id);
  if (!message) { box.classList.add('hidden'); box.textContent = ''; return; }
  box.textContent = message;
  box.classList.remove('hidden');
}

function bindAuth() {
  const paintTabs = (register) => {
    $('#authTabLogin').classList.toggle('active', !register);
    $('#authTabRegister').classList.toggle('active', register);
    $('#loginForm').classList.toggle('hidden', register);
    $('#registerForm').classList.toggle('hidden', !register);
    $('#authTabs').classList.toggle('is-register', register);
    $('#authTabLogin').setAttribute('aria-selected', String(!register));
    $('#authTabRegister').setAttribute('aria-selected', String(register));
    showAuthError('#loginError', '');
    showAuthError('#registerError', '');
  };
  const toLogin = () => paintTabs(false);
  const toRegister = () => paintTabs(true);
  $('#authTabLogin').addEventListener('click', toLogin);
  $('#authTabRegister').addEventListener('click', toRegister);

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthError('#loginError', '');
    const btn = $('#loginSubmit');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      await store.login($('#loginEmail').value.trim(), $('#loginPassword').value);
      enterApp();
    } catch (err) {
      showAuthError('#loginError', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });

  $('#sendCodeBtn').addEventListener('click', async () => {
    const email = $('#regEmail').value.trim();
    showAuthError('#registerError', '');
    const hint = $('#codeHint');
    hint.classList.add('hidden');
    if (!email) { showAuthError('#registerError', '请先填写邮箱'); return; }
    const btn = $('#sendCodeBtn');
    btn.disabled = true;
    btn.textContent = '发送中…';
    try {
      const data = await store.requestCode(email, 'register');
      if (data.devCode) {
        hint.textContent = `（开发环境）验证码：${data.devCode}`;
        $('#regCode').value = data.devCode;
      } else if (data.delivered) {
        hint.textContent = `验证码已发送到 ${data.maskedEmail}，${data.expiresInMinutes} 分钟内有效`;
      } else {
        hint.textContent = data.warning || '邮件发送失败，请稍后重试';
      }
      hint.classList.remove('hidden');
      let left = data.resendAfterSeconds || 60;
      const tick = () => {
        if (left <= 0) { clearInterval(codeTimer); btn.disabled = false; btn.textContent = '重新获取'; return; }
        btn.textContent = `${left}s 后可重发`;
        left -= 1;
      };
      tick();
      clearInterval(codeTimer);
      codeTimer = setInterval(tick, 1000);
    } catch (err) {
      showAuthError('#registerError', err.message);
      btn.disabled = false;
      btn.textContent = '获取验证码';
    }
  });

  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthError('#registerError', '');
    const btn = $('#registerSubmit');
    btn.disabled = true;
    btn.textContent = '注册中…';
    try {
      await store.register({
        email: $('#regEmail').value.trim(),
        code: $('#regCode').value.trim(),
        displayName: $('#regName').value.trim(),
        password: $('#regPassword').value,
      });
      enterApp();
    } catch (err) {
      showAuthError('#registerError', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '注册并进入';
    }
  });
}

function showAuth() {
  $('#app').classList.add('hidden');
  $('#authView').classList.remove('hidden');
}

function enterApp() {
  $('#authView').classList.add('hidden');
  $('#app').classList.remove('hidden');
  switchTab('books');
  if (!store.books.length) openAddSheet({ firstRun: true });
}

/* ==================================================================== *
 * 首页：账本列表
 * ==================================================================== */

function roleDot(role) {
  if (role === 'owner') return el('span', { class: 'role-dot', text: '主' });
  if (role === 'admin') return el('span', { class: 'role-dot admin', text: '管' });
  return null;
}

function previewOf(book) {
  const last = book.lastMessage;
  if (!last || !last.content) return '还没有记账记录';
  const text = String(last.content)
    .replace(/^已记账：/, '')
    .replace(/（\d{4}-\d{2}-\d{2}）\s*$/, '')   // 会话列表里已经有时间了，不必再带日期
    .replace(/\s+/g, ' ')
    .trim();
  return last.author ? `${last.author}：${text}` : text;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return '夜深啦';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function renderBooks() {
  const box = $('#bookList');
  clear(box);
  renderOffline();

  const acc = store.account || {};
  const recordTotal = store.books.reduce((sum, b) => sum + (Number(b.recordCount) || 0), 0);

  box.append(el('div', { class: 'home-hero' }, [
    el('div', { class: 'hero-copy' }, [
      el('div', { class: 'hero-hi', text: `${greeting()}，${acc.displayName || '朋友'} ♡` }),
      el('div', {
        class: 'hero-title',
        text: store.books.length ? '今天想记点什么？' : '先建一个小账本吧',
      }),
      el('div', { class: 'hero-meta' }, [
        el('span', { class: 'hero-pill hero-pill--pink', text: `${store.books.length} 个账本` }),
        el('span', { class: 'hero-pill', text: `累计 ${recordTotal} 笔` }),
      ]),
    ]),
    el('img', { class: 'hero-mascot', src: './img/pair.svg', alt: '' }),
  ]));

  if (!store.books.length) {
    box.append(el('div', { class: 'empty-page', style: 'padding-top:22px' }, [
      el('div', { text: '还没有账本' }),
      el('div', { class: 'empty-sub', text: '创建一个家庭账本，或者用邀请码加入家人的账本' }),
      el('button', { type: 'button', text: '创建 / 加入账本', onclick: () => openAddSheet() }),
    ]));
    return;
  }

  box.append(el('div', { class: 'home-section-head' }, [
    el('div', { class: 'home-section-title', text: '我的账本' }),
    el('div', { class: 'home-section-count', text: `${store.books.length} 个` }),
  ]));

  store.books.forEach((book, index) => {
    const row = el('div', {
      class: `book-row tone-${index % 3}`,
      onclick: () => openBook(book.id),
      role: 'button',
      tabindex: '0',
      onkeydown: (e) => { if (e.key === 'Enter') openBook(book.id); },
    }, [
      el('div', { class: 'book-avatar' }, [
        document.createTextNode(book.emoji || '📒'),
        roleDot(book.role),
      ]),
      el('div', { class: 'book-main' }, [
        el('div', { class: 'book-name-row' }, [
          el('div', { class: 'book-name', text: book.name }),
          el('span', {
            class: `role-badge${book.role === 'owner' ? ' owner' : book.role === 'admin' ? ' admin' : ''}`,
            text: roleLabel(book.role),
          }),
        ]),
        el('div', { class: 'book-preview', text: previewOf(book) }),
      ]),
      el('div', { class: 'book-side' }, [
        el('div', { class: 'book-time', text: book.lastMessage ? fmtListTime(book.lastMessage.at) : '' }),
        book.unreadMentions
          ? el('div', { class: 'book-mention', text: `＠${book.unreadMentions}` })
          : null,
        el('div', {
          class: 'book-time',
          text: `${book.memberCount}/${store.maxMembers} 人 · ${book.recordCount} 笔`,
        }),
      ]),
    ]);
    row.style.setProperty('--i', String(Math.min(index, 8)));
    box.append(row);
  });

  box.append(el('div', {
    class: 'add-book-card',
    role: 'button',
    tabindex: '0',
    onclick: () => openAddSheet(),
    onkeydown: (e) => { if (e.key === 'Enter') openAddSheet(); },
  }, [
    el('span', { class: 'add-book-plus', text: '＋' }),
    el('div', {}, [
      el('div', { class: 'add-book-title', text: '新建 / 加入账本' }),
      el('div', { class: 'add-book-sub', text: '和家人一起记，每笔都算得清' }),
    ]),
  ]));
}

function renderOffline() {
  $('#offlineBar').classList.toggle('hidden', store.online);
}

async function openBook(bookId) {
  try {
    await store.selectBook(bookId);
  } catch (err) {
    toast(err.message);
    return;
  }
  pendingItems = [];
  chatRenderedBookId = null; // 重新进入账本时，让最近几条消息再做一次入场动画
  navigate('chat');
  scrollToBottom(true);
  // 头像 / 插画加载后高度会变，再补一次滚动
  setTimeout(() => scrollToBottom(true), 160);
  // 进入账本即视为已读，清掉首页的「有人@我」徽标
  await store.markRead();
  renderBooks();
}

/* ==================================================================== *
 * 设置页
 * ==================================================================== */

function renderSettings() {
  const box = $('#settingsBody');
  clear(box);
  const acc = store.account || {};
  const stats = store.stats || {};

  box.append(el('div', { class: 'profile-card' }, [
    el('div', { class: 'profile-avatar', text: acc.emoji || '🙂' }),
    el('div', { class: 'profile-main' }, [
      el('div', { class: 'profile-name', text: acc.displayName || '' }),
      el('div', { class: 'profile-email', text: acc.email || '' }),
    ]),
  ]));

  const item = (label, value, onClick, extraClass = '') => el('div', {
    class: `settings-item${extraClass ? ` ${extraClass}` : ''}`,
    role: 'button',
    tabindex: '0',
    onclick: onClick,
    onkeydown: (e) => { if (e.key === 'Enter') onClick(); },
  }, [
    el('div', { class: 'si-main' }, [
      el('div', { text: label }),
      value ? el('div', { class: 'si-value', text: value }) : null,
    ]),
    el('span', { class: 'chev', text: '›' }),
  ]);

  box.append(el('div', { class: 'settings-group' }, [
    el('h4', { text: '个人信息' }),
    item('头像', `${acc.emoji || '🙂'} 修改`, () => openAvatarSheet()),
    item('昵称', acc.displayName || '', () => openNicknameSheet()),
    item('修改密码', '', () => openPasswordSheet()),
  ]));

  box.append(el('div', { class: 'settings-group' }, [
    el('h4', { text: '账本' }),
    item('我的账本', `${store.books.length} 个（已创建 ${stats.booksCreated ?? 0}/${store.maxBooks}）`, () => switchTab('books')),
  ]));

  box.append(el('div', { class: 'settings-group' }, [
    el('h4', { text: '关于' }),
    versionItem(),
    item('用户协议', '', () => { location.href = './terms.html'; }),
    item('隐私政策', '', () => { location.href = './privacy.html'; }),
    item('退出登录', '', async () => {
      await store.logout();
      showAuth();
    }, 'danger'),
  ]));
}

/** 版本行：点击看版本；长按 800ms 进入内部调试（接口地址覆盖），普通用户不会触发 */
function versionItem() {
  const row = el('div', { class: 'settings-item', role: 'button', tabindex: '0' }, [
    el('div', { class: 'si-main' }, [
      el('div', { text: '版本' }),
      el('div', { class: 'si-value', text: '2.0.0' }),
    ]),
    el('span', { class: 'chev', text: '›' }),
  ]);
  let timer = null;
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  row.addEventListener('pointerdown', () => {
    clearTimer();
    timer = setTimeout(() => { toast('已进入内部调试'); openServerSheet(); }, 800);
  });
  row.addEventListener('pointerup', clearTimer);
  row.addEventListener('pointerleave', clearTimer);
  row.addEventListener('pointercancel', clearTimer);
  row.addEventListener('click', () => { if (!timer) toast('记账本 2.0.0'); });
  return row;
}

function openAvatarSheet() {
  openSheet((body, close) => {
    body.append(el('h3', { text: '选择头像' }));
    body.append(el('p', { class: 'quota-line', text: '头像只能从预设里选' }));
    let picked = store.account ? store.account.emoji || '🙂' : '🙂';
    const grid = el('div', { class: 'icon-grid' });
    const paint = () => {
      clear(grid);
      for (const icon of AVATAR_ICONS) {
        grid.append(el('button', {
          class: icon === picked ? 'active' : '',
          type: 'button',
          text: icon,
          onclick: () => { picked = icon; paint(); },
        }));
      }
    };
    paint();
    body.append(grid);
    body.append(el('div', { class: 'sheet-actions' }, [
      el('button', {
        class: 'primary',
        type: 'button',
        text: '保存',
        onclick: async () => {
          try {
            await store.updateProfile({ displayName: store.account.displayName, emoji: picked });
            close();
            renderSettings();
            toast('头像已更新');
          } catch (err) { toast(err.message); }
        },
      }),
    ]));
  });
}

function openNicknameSheet() {
  openSheet((body, close) => {
    body.append(el('h3', { text: '修改昵称' }));
    const input = el('input', { type: 'text', maxlength: '20', value: store.account ? store.account.displayName : '' });
    body.append(el('div', { class: 'field' }, [el('label', { text: '昵称' }), input]));
    body.append(el('div', { class: 'sheet-actions' }, [
      el('button', {
        class: 'primary',
        type: 'button',
        text: '保存',
        onclick: async () => {
          try {
            await store.updateProfile({ displayName: input.value.trim(), emoji: store.account.emoji });
            close();
            renderSettings();
            toast('昵称已更新');
          } catch (err) { toast(err.message); }
        },
      }),
    ]));
  });
}

function openPasswordSheet() {
  openSheet((body, close) => {
    body.append(el('h3', { text: '修改密码' }));
    const oldPwd = el('input', { type: 'password', placeholder: '当前密码' });
    const newPwd = el('input', { type: 'password', placeholder: '新密码（≥8 位含字母数字）' });
    body.append(el('div', { class: 'field' }, [el('label', { text: '当前密码' }), oldPwd]));
    body.append(el('div', { class: 'field' }, [el('label', { text: '新密码' }), newPwd]));
    body.append(el('div', { class: 'sheet-actions' }, [
      el('button', {
        class: 'primary',
        type: 'button',
        text: '确认修改',
        onclick: async () => {
          try {
            await store.changePassword(oldPwd.value, newPwd.value);
            close();
            toast('密码已修改，其它设备已下线');
          } catch (err) { toast(err.message); }
        },
      }),
    ]));
  });
}

function openServerSheet() {
  openSheet((body, close) => {
    body.append(el('h3', { text: '内部调试' }));
    body.append(el('p', {
      class: 'quota-line',
      text: '这里是开发/运维用的信息，普通用户不需要关心。正式安装包在构建时已写好接口地址。',
    }));

    const caps = store.config || {};
    const infoRow = (label, value) => el('div', { class: 'settings-item' }, [
      el('div', { class: 'si-main' }, [
        el('div', { text: label }),
        el('div', { class: 'si-value', text: value || '—' }),
      ]),
    ]);
    const source = prefs.get(LS.serverUrl, '')
      ? '调试覆盖'
      : ((window.__KA_CONFIG__ && window.__KA_CONFIG__.apiBase) ? '构建期注入' : '同源');
    body.append(el('div', { class: 'settings-group' }, [
      el('h4', { text: '运行信息' }),
      infoRow('接口地址', `${store.serverUrl || '未配置'}（${source}）`),
      infoRow('解析引擎', caps.llm ? caps.llm.label : '—'),
      infoRow('邮件服务', caps.mail ? caps.mail.label : '—'),
      infoRow('语音识别', caps.asr ? caps.asr.label : '—'),
      infoRow('版本 / 结构', `${caps.version || '—'} / schema v${caps.schemaVersion || '—'}`),
      infoRow('时区 / 配额', `${caps.tz || '—'} · ${store.maxBooks} 本 / ${store.maxMembers} 人`),
      infoRow('账号 ID', store.account ? `#${store.account.id} ${store.account.email}` : '未登录'),
    ]));

    body.append(el('h4', { text: '覆盖接口地址（仅联调用）' }));
    const input = el('input', { type: 'url', placeholder: '留空 = 使用默认（构建期或同源）', value: prefs.get(LS.serverUrl, '') });
    body.append(el('div', { class: 'field' }, [el('label', { text: '接口地址' }), input]));
    body.append(el('div', { class: 'sheet-actions' }, [
      el('button', {
        class: 'primary',
        type: 'button',
        text: '保存并重连',
        onclick: async () => {
          prefs.set(LS.serverUrl, input.value.trim().replace(/\/+$/, ''));
          try {
            await store.init();
            close();
            if (store.loggedIn) enterApp(); else showAuth();
            toast('已保存');
          } catch (err) { toast(`连接失败：${err.message}`); }
        },
      }),
    ]));
  });
}

/* ==================================================================== *
 * 群聊页
 * ==================================================================== */

function renderChat() {
  const book = store.book;
  $('#chatTitle').textContent = book ? book.name : '账本';
  const total = book ? store.statsFor({ preset: 'month' }).expenseCents : 0;
  $('#chatSub').textContent = book ? `${store.members.length} 人 · 本月 ${formatMoney(total)}` : '';
  renderMessages();
}

function messageNode(msg) {
  if (msg.role === 'user') {
    const author = store.memberOf(msg.authorAccountId);
    const isMine = store.account && Number(msg.authorAccountId) === Number(store.account.id);
    return el('div', { class: `msg user${isMine ? '' : ' other'}` }, [
      el('div', { class: 'msg-stack' }, [
        !isMine && author ? el('div', { class: 'msg-author', text: `${author.emoji || '🙂'} ${author.displayName}` }) : null,
        el('div', { class: 'bubble' }, [document.createTextNode(msg.content || '')]),
      ]),
      el('div', { class: 'avatar', text: author ? author.emoji || '🙂' : '🙂', title: author ? author.displayName : '' }),
    ]);
  }

  const stack = [];
  const hasCards = (msg.payload?.recordIds || []).length > 0;
  const showBubble = !!msg.content && !(hasCards && msg.payload?.action === 'created');
  if (showBubble) stack.push(el('div', { class: 'bubble', text: msg.content }));

  for (const id of msg.payload?.recordIds || []) {
    const rec = store.records.find((r) => String(r.id) === String(id));
    if (rec) stack.push(recordCard(rec));
  }
  if (msg.payload?.clarification) stack.push(clarifyCard(msg.payload.clarification));
  if (msg.payload?.summary) stack.push(summaryCard(msg.payload.summary, msg.payload.query));

  const warns = msg.payload?.warnings || [];
  if (warns.length) stack.push(el('div', { class: 'warn-list' }, warns.map((w) => el('div', { class: 'warn-item', text: w }))));

  return el('div', { class: 'msg assistant' }, [
    bubuAvatar(),
    el('div', { class: 'msg-stack' }, stack),
  ]);
}

function failedNode(item) {
  return el('div', { class: 'msg user failed' }, [
    el('div', { class: 'msg-stack' }, [
      el('div', { class: 'bubble' }, [document.createTextNode(item.text)]),
      el('div', { class: 'failed-note' }, [
        el('span', { text: `未发送 · ${item.reason || '发送失败'}` }),
        el('button', {
          type: 'button',
          text: '重试',
          onclick: async () => {
            try {
              await store.sync().catch(() => {});
              await store.sendMessage(item.text, { source: item.source });
              await store.forgetFailed(item.id);
              renderMessages();
              toast('已重新发送');
            } catch (err) {
              toast(`仍然失败：${err.message}`);
              renderMessages();
            }
          },
        }),
        el('button', { type: 'button', text: '丢弃', onclick: async () => { await store.forgetFailed(item.id); renderMessages(); } }),
      ]),
    ]),
    el('div', { class: 'avatar', text: store.account ? store.account.emoji || '🙂' : '🙂' }),
  ]);
}

function recordCard(rec) {
  const income = rec.type === 'income' || rec.type === 'refund';
  const deleted = !!rec.deletedAt;
  const editor = store.canEdit(rec);
  const author = store.memberOf(rec.authorAccountId);
  const payer = store.memberOf(rec.payerAccountId);
  const participants = (rec.participants || []).filter((p) => p.shareCents > 0);
  const isMine = store.account && Number(rec.authorAccountId) === Number(store.account.id);

  const mentionedMe = store.account
    && Number(rec.payerAccountId) === Number(store.account.id)
    && Number(rec.authorAccountId) !== Number(store.account.id);

  const meta = [
    el('span', { class: 'tag', text: `${fmtDayLabel(rec.occurredDate)}${rec.occurredTime ? ` ${rec.occurredTime}` : ''}` }),
    payer ? el('span', { class: 'tag', text: `💳 ${payer.displayName}${payer.left ? '（已移出）' : ''}` }) : null,
    author ? el('span', { class: `tag${isMine ? ' brand' : ''}`, text: isMine ? '我发的' : `✍️ ${author.displayName}${author.left ? '（已移出）' : ''}` }) : null,
  ];
  if (participants.length > 1) {
    meta.push(el('span', {
      class: 'tag brand',
      text: `AA ${participants.map((p) => `${p.name} ${formatMoney(p.shareCents)}`).join(' / ')}`,
    }));
  }
  if (!income && rec.amountCents >= Number(prefs.get(LS.largeThresholdCents, store.config.largeThresholdCents || 5000))) {
    meta.push(el('span', { class: 'tag warn', text: '大额' }));
  }
  if (deleted) meta.push(el('span', { class: 'tag warn', text: '已删除' }));
  if (mentionedMe) meta.push(el('span', { class: 'tag mention', text: '＠我' }));

  return el('div', {
    class: `card record-card${income ? ' income' : ''}${deleted ? '' : ' tappable'}`,
    role: deleted ? null : 'button',
    tabindex: deleted ? null : '0',
    onclick: deleted ? null : () => openRecordSheet(rec),
    onkeydown: deleted ? null : (e) => { if (e.key === 'Enter' || e.key === ' ') openRecordSheet(rec); },
  }, [
    el('div', { class: 'rc-top' }, [
      el('div', { class: 'rc-icon', text: iconOf(rec.category) }),
      el('div', { class: 'rc-main' }, [
        el('div', { class: 'rc-cat' }, [
          document.createTextNode(rec.category || '其他'),
          rec.subcategory ? el('span', { class: 'tag', text: rec.subcategory }) : null,
        ]),
        el('div', { class: 'rc-sub', text: rec.merchant || ' ' }),
      ]),
      el('div', { class: `rc-amount ${income ? 'income' : 'expense'}`, text: amountText(rec) }),
    ]),
    el('div', { class: 'rc-meta' }, meta.filter(Boolean)),
    rec.note ? el('div', { class: 'rc-note', text: rec.note }) : null,
    el('div', { class: 'rc-foot' }, [
      el('span', { text: deleted ? '已删除' : (editor ? '点击卡片可修改' : '仅可查看（别人发送的）') }),
      deleted
        ? (editor ? el('span', {
          class: 'tap-hint',
          text: '恢复',
          style: { cursor: 'pointer' },
          onclick: async (e) => { e.stopPropagation(); await store.restoreRecord(rec.id); renderMessages(); toast('已恢复'); },
        }) : null)
        : el('span', { class: 'tap-hint', text: editor ? '编辑 ›' : '详情 ›' }),
    ]),
  ]);
}

function clarifyCard(clarification) {
  const options = el('div', { class: 'clarify-options' });
  for (const opt of clarification.options || []) {
    options.append(el('button', { class: 'opt-chip', type: 'button', text: opt, onclick: () => send(opt) }));
  }
  const input = el('input', { type: 'text', placeholder: '直接补充，例如「35块」' });
  const submit = () => { const v = input.value.trim(); if (v) send(v); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return el('div', { class: 'card clarify-card' }, [
    el('div', { class: 'q', text: clarification.question || '再补充一点信息？' }),
    (clarification.options || []).length ? options : null,
    el('div', { class: 'clarify-row' }, [input, el('button', { class: 'send-btn', type: 'button', text: '回答', onclick: submit })]),
  ]);
}

function summaryCard(summary, query) {
  const top = (summary.byCategory || []).slice(0, 4);
  const max = top.length ? top[0].cents : 1;
  return el('div', { class: 'card summary-card' }, [
    el('div', { class: 'sc-title', text: `${summary.range.from} ~ ${summary.range.to}${query?.filters?.category ? ` · ${query.filters.category}` : ''}` }),
    el('div', { class: 'sc-total', text: formatMoney(summary.expenseCents) }),
    el('div', { class: 'sc-sub', text: `${summary.count} 笔 · 日均 ${formatMoney(summary.avgPerDayCents)}` }),
    el('div', { class: 'sc-grid' }, [
      el('div', { class: 'sc-cell' }, [el('div', { class: 'k', text: '餐食' }), el('div', { class: 'v', text: formatMoney(summary.meal.cents) })]),
      el('div', { class: 'sc-cell' }, [el('div', { class: 'k', text: '餐食占比' }), el('div', { class: 'v', text: `${(summary.meal.share * 100).toFixed(1)}%` })]),
      el('div', { class: 'sc-cell' }, [el('div', { class: 'k', text: '单笔均值' }), el('div', { class: 'v', text: formatMoney(summary.avgPerRecordCents) })]),
    ]),
    top.length ? el('div', { class: 'sc-bars' }, top.map((c) => el('div', { class: 'sc-bar-row' }, [
      el('span', { class: 'name', text: `${iconOf(c.category)} ${c.category}` }),
      el('span', { class: 'track' }, [el('span', { class: 'fill', style: { width: `${Math.round((c.cents / max) * 100)}%` } })]),
      el('span', { class: 'val', text: formatMoney(c.cents) }),
    ]))) : null,
    el('button', { class: 'mini-btn', type: 'button', text: '看完整统计 ›', style: { marginTop: '12px' }, onclick: () => navigate('stats') }),
  ]);
}

function parsingCard(label = '解析中') {
  return el('div', { class: 'msg assistant' }, [
    bubuAvatar(),
    el('div', { class: 'msg-stack' }, [
      el('div', { class: 'card parsing-card' }, [
        el('div', { class: 'skeleton w40 h20' }),
        el('div', { class: 'skeleton w70' }),
        el('div', { class: 'parsing-label' }, [
          el('span', { class: 'dots' }, [el('span'), el('span'), el('span')]),
          el('span', { text: label }),
        ]),
      ]),
    ]),
  ]);
}

let seenMessageIds = new Set();
let chatRenderedBookId = null;

let lastMessagesSig = '';

/** 消息区内容指纹：轮询命中但没有变化时就不重建 DOM，避免每 5 秒闪一下 */
function messagesSignature(bid) {
  const list = store.messages.filter((m) => String(m.bookId) === String(bid));
  const recs = store.activeRecords();
  let h = 0;
  for (const r of recs) h = (h * 31 + Number(r.id) * 7 + Number(r.version || 1)) | 0;
  const last = list.length ? list[list.length - 1] : null;
  return [bid, list.length, last ? last.id : 0, recs.length, h,
    store.failed.length, pendingItems.length, store.members.length].join('|');
}

function renderMessages(force = false) {
  const box = $('#messages');
  if (!box) return;
  const bid = store.book ? store.book.id : null;
  const sig = messagesSignature(bid);
  if (!force && sig === lastMessagesSig) return;
  lastMessagesSig = sig;
  clear(box);
  const list = store.messages.filter((m) => String(m.bookId) === String(bid));
  const failed = store.failed.filter((f) => String(f.bookId) === String(bid));

  const bookKey = String(bid);
  const firstPaint = chatRenderedBookId !== bookKey;
  if (firstPaint) {
    seenMessageIds = new Set();
    chatRenderedBookId = bookKey;
  }

  const animateOrder = new Map();
  if (firstPaint) {
    list.slice(-6).forEach((m, i) => animateOrder.set(m.id, i));
  } else {
    list.forEach((m) => { if (!seenMessageIds.has(m.id)) animateOrder.set(m.id, 0); });
  }

  if (!list.length && !pendingItems.length && !failed.length) {
    box.append(el('div', { class: 'empty-hint' }, [
      el('img', { class: 'mascot-pair', src: './img/pair.svg', alt: '' }),
      el('div', { text: '按住下面的按钮说一句，比如「昨天午饭 35」' }),
      el('div', {
        class: 'empty-sub',
        text: store.isManager ? '你是管理员，可以用「@昵称 买菜 30」帮家人记账' : '账本里所有人的记录都会出现在这里',
      }),
    ]));
  }

  for (const m of list) {
    const node = messageNode(m);
    if (animateOrder.has(m.id)) {
      node.classList.add('msg-in');
      node.style.setProperty('--d', `${animateOrder.get(m.id) * 45}ms`);
    }
    seenMessageIds.add(m.id);
    box.append(node);
  }

  for (const p of pendingItems) {
    const node = parsingCard(p.label);
    node.classList.add('msg-in');
    box.append(node);
  }

  for (const f of failed) {
    const node = failedNode(f);
    node.classList.add('msg-in');
    box.append(node);
  }

  scrollToBottom();
}

let scrollRaf = null;

/** 平滑滚到底部：缓出曲线，避免生硬跳变 */
function scrollToBottom(force = false) {
  const viewEl = $('#messages');
  if (!viewEl) return;
  const nearBottom = viewEl.scrollHeight - viewEl.scrollTop - viewEl.clientHeight < 240;
  if (!force && !nearBottom) return;

  const target = Math.max(0, viewEl.scrollHeight - viewEl.clientHeight);
  const start = viewEl.scrollTop;
  const distance = target - start;

  if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
  if (reduceMotion() || distance < 2) {
    viewEl.scrollTop = target;
    return;
  }

  const duration = Math.min(560, 200 + Math.abs(distance) * 0.5);
  const t0 = performance.now();
  const easeOut = (t) => 1 - Math.pow(1 - t, 4);

  const step = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    viewEl.scrollTop = start + distance * easeOut(p);
    if (p < 1) scrollRaf = requestAnimationFrame(step);
    else scrollRaf = null;
  };
  scrollRaf = requestAnimationFrame(step);
}

/* ==================================================================== *
 * 发送
 * ==================================================================== */

function addPending(label) {
  const id = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  pendingItems.push({ id, label });
  renderMessages();
  return id;
}

const removePending = (id) => { pendingItems = pendingItems.filter((p) => p.id !== id); };

async function send(text, { source = 'text' } = {}) {
  const content = String(text || '').trim();
  if (!content) return;
  if (!store.book) { toast('请先创建或加入一个账本'); return; }
  if (!store.online) {
    await store.rememberFailed(content, { source, reason: '网络不可用' });
    renderMessages();
    toast('当前离线，这条已标红，联网后点「重试」再发送');
    return;
  }
  const pendingId = addPending('布布正在记…');
  scrollToBottom(true);
  try {
    const { reply } = await store.sendMessage(content, { source });
    removePending(pendingId);
    renderMessages();
    if (reply.action === 'created' && reply.records.length) {
      const rec = reply.records[0];
      toast(`已记账 ${formatMoney(rec.amountCents)}`, {
        label: '撤销',
        onClick: async () => {
          try { await store.deleteRecord(rec.id); renderMessages(); toast('已撤销'); } catch (err) { toast(err.message); }
        },
      }, 4500);
    }
  } catch (err) {
    removePending(pendingId);
    const reason = friendlyReason(err);
    await store.rememberFailed(content, { source, reason });
    renderMessages();
    toast(err.code === 'OFFLINE' ? '网络不可用，这条已标红，联网后点「重试」' : `发送失败（${reason}）`);
  }
}

/* ==================================================================== *
 * 语音
 * ==================================================================== */

function updateRecWave(level) {
  const wave = $('#recWave');
  if (!wave) return;
  if (wave.childElementCount !== 24) {
    clear(wave);
    for (let i = 0; i < 24; i += 1) wave.append(el('i'));
  }
  const children = wave.children;
  const t = Date.now() / 110;
  for (let i = 0; i < children.length; i += 1) {
    const wobble = 0.5 + 0.5 * Math.sin(t + i * 0.55);
    children[i].style.height = `${Math.max(5, Math.min(42, 6 + level * 34 * (0.45 + wobble * 0.8)))}px`;
  }
}

function showRecOverlay() {
  $('#recOverlay').classList.remove('hidden');
  $('#recOverlay').setAttribute('aria-hidden', 'false');
  updateRecWave(0);
}

function hideRecOverlay() {
  $('#recOverlay').classList.add('hidden');
  $('#recOverlay').setAttribute('aria-hidden', 'true');
  $('#recOverlay').classList.remove('cancelling');
  $('#voiceBtn').classList.remove('recording');
  $('#recState').textContent = '正在聆听…';
  $('#recHint').textContent = '松开发送 · 上滑取消';
}

let startY = 0;
let cancelArmed = false;

async function beginRecording(e) {
  if (recState !== 'idle') return;
  if (!recorderSupported()) {
    toast('当前环境不支持录音，请切换到文字输入');
    switchInputMode('text');
    return;
  }
  recState = 'starting';
  startY = e.clientY != null ? e.clientY : 0;
  cancelArmed = false;
  try {
    await recorder.start();
  } catch (err) {
    recState = 'idle';
    toast(`无法使用麦克风：${err.message || '请检查权限'}`);
    return;
  }
  recState = 'recording';
  $('#voiceBtn').classList.add('recording');
  showRecOverlay();
  haptic(16);
}

async function finishRecording(cancel = false) {
  if (recState !== 'recording' && recState !== 'starting') return;
  const wasStarting = recState === 'starting';
  recState = 'stopping';
  const elapsed = recorder ? recorder.elapsed() : 0;
  let result = null;
  try {
    result = await recorder.stop(cancel || wasStarting);
  } catch {
    result = null;
  } finally {
    // 关键：浮层与状态必须在 finally 里复位，否则任何异常都会让界面卡住
    hideRecOverlay();
    recState = 'idle';
    cancelArmed = false;
  }
  if (cancel) return;
  if (!result) {
    toast(elapsed < 500 ? '按久一点再说，说完再松手' : '没有录到声音，再试一次');
    return;
  }
  const pendingId = addPending('语音识别中');
  scrollToBottom(true);
  try {
    const text = await store.transcribe(result.blob, result.mime);
    removePending(pendingId);
    await send(text, { source: 'voice' });
  } catch (err) {
    removePending(pendingId);
    const box = $('#messages');
    box.append(el('div', { class: 'msg assistant' }, [
      el('div', { class: 'avatar', text: '🎙' }),
      el('div', { class: 'msg-stack' }, [
        el('div', { class: 'card clarify-card' }, [
          el('div', { class: 'q', text: err.code === 'ASR_NOT_CONFIGURED'
            ? '当前没有开启语音识别，可以先改用文字输入'
            : '这段语音没能识别出来，可以再说一次，或改用文字输入' }),
          el('div', { class: 'clarify-row' }, [
            el('button', { class: 'mini-btn primary', type: 'button', text: '改用文字输入', onclick: () => switchInputMode('text') }),
          ]),
        ]),
      ]),
    ]));
    scrollToBottom(true);
  }
}

function bindVoiceButton() {
  const btn = $('#voiceBtn');

  // 手指按下：开始
  btn.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    startY = e.clientY != null ? e.clientY : 0;
    cancelArmed = false;
    try { btn.setPointerCapture?.(e.pointerId); } catch { /* 某些 WebView 不支持 */ }
    beginRecording(e);
  });

  // 上滑取消：按钮上收到就处理；收不到（手指移出）时由下面的全局监听兜底
  const trackMove = (e) => {
    if (recState !== 'recording') return;
    const y = e.clientY != null ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : startY);
    const armed = startY - y > 60;
    if (armed !== cancelArmed) {
      cancelArmed = armed;
      $('#recOverlay').classList.toggle('cancelling', armed);
      $('#recState').textContent = armed ? '松开取消' : '正在聆听…';
      $('#recHint').textContent = armed ? '松开手指即取消' : '松开发送 · 上滑取消';
    }
  };
  btn.addEventListener('pointermove', trackMove);
  document.addEventListener('pointermove', trackMove, { passive: true });
  document.addEventListener('touchmove', trackMove, { passive: true });

  // 松手/被打断：全部走同一条收尾逻辑（finishRecording 自身幂等）
  const end = (e) => {
    if (recState !== 'recording' && recState !== 'starting') return;
    if (e && e.type !== 'pointerup') cancelArmed = true;   // pointercancel / 触摸中断 = 取消
    finishRecording(cancelArmed);
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  document.addEventListener('pointerup', end, true);
  document.addEventListener('mouseup', end, true);
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
  // 切后台 / 失焦：别让它一直挂着
  document.addEventListener('visibilitychange', () => { if (document.hidden) end({ type: 'pointercancel' }); });
  window.addEventListener('blur', () => end({ type: 'pointercancel' }));

  // 浮层上的"取消"按钮（即使收不到 pointerup 也能退出）
  $('#recCancel')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cancelArmed = true;
    finishRecording(true);
  });

  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

function switchInputMode(mode) {
  closeMentionList();
  const isVoice = mode === 'voice';
  $('#voiceRow').classList.toggle('hidden', !isVoice);
  $('#textRow').classList.toggle('hidden', isVoice);
  if (!isVoice) {
    const input = $('#textInput');
    input.placeholder = store.isManager ? '例如：昨天午饭35；@老婆 买菜 30' : '例如：昨天午饭35';
    setTimeout(() => input.focus(), 30);
  }
}

/* ------------------------- @ 成员补全 ------------------------- */

let mention = { open: false, items: [], index: 0, start: 0, end: 0 };

function closeMentionList() {
  mention = { ...mention, open: false, items: [], index: 0 };
  document.getElementById('mentionList')?.remove();
}

function renderMentionList() {
  let box = document.getElementById('mentionList');
  if (!box) {
    box = el('div', { id: 'mentionList', class: 'mention-list' });
    $('#composer').append(box);
  }
  clear(box);
  if (!mention.items.length) { box.remove(); return; }
  mention.items.forEach((m, i) => {
    box.append(el('button', {
      type: 'button',
      class: `mention-item${i === mention.index ? ' active' : ''}`,
      onmousedown: (e) => { e.preventDefault(); pickMention(m); },
      onclick: (e) => { e.preventDefault(); pickMention(m); },
    }, [
      el('span', { class: 'mi-emoji', text: m.emoji || '🙂' }),
      el('span', { class: 'mi-name', text: m.displayName }),
      el('span', { class: 'mi-role', text: roleLabel(m.role) }),
    ]));
  });
}

function updateMentionList() {
  if (!store.isManager) { closeMentionList(); return; }
  const input = $('#textInput');
  const value = input.value;
  const caret = input.selectionStart != null ? input.selectionStart : value.length;
  const before = value.slice(0, caret);
  // 光标前最后一个 @ 之后没有空格 → 认为正在输入提及对象
  const m = before.match(/@([^\s@]{0,20})$/);
  if (!m) { closeMentionList(); return; }
  const q = m[1].toLowerCase();
  const items = store.members
    .filter((x) => !store.account || Number(x.accountId) !== Number(store.account.id))
    .filter((x) => {
      const name = String(x.displayName || '').toLowerCase();
      return !q || name.includes(q);           // 模糊匹配（子串）
    })
    .slice(0, 6);
  if (!items.length) { closeMentionList(); return; }
  mention = {
    open: true,
    items,
    index: Math.min(mention.index, items.length - 1),
    start: caret - m[0].length,
    end: caret,
  };
  renderMentionList();
}

function pickMention(member) {
  const input = $('#textInput');
  const value = input.value;
  const next = value.slice(0, mention.start) + `@${member.displayName} ` + value.slice(mention.end);
  input.value = next;
  const caret = mention.start + String(member.displayName).length + 2;
  closeMentionList();
  input.focus();
  try { input.setSelectionRange(caret, caret); } catch { /* ignore */ }
  input.style.height = 'auto';
  input.style.height = `${Math.min(108, input.scrollHeight)}px`;
}

function bindComposer() {
  $('#keyboardBtn').addEventListener('click', () => switchInputMode('text'));
  $('#micBtn').addEventListener('click', () => switchInputMode('voice'));
  const input = $('#textInput');
  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(108, input.scrollHeight)}px`;
  };
  input.addEventListener('input', () => { autoGrow(); updateMentionList(); });
  input.addEventListener('click', updateMentionList);
  input.addEventListener('blur', () => setTimeout(closeMentionList, 150));
  $('#micBtn').addEventListener('click', () => closeMentionList());
  input.addEventListener('keydown', (e) => {
    if (mention.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mention.index = (mention.index + 1) % mention.items.length;
        renderMentionList();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mention.index = (mention.index - 1 + mention.items.length) % mention.items.length;
        renderMentionList();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); closeMentionList(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(mention.items[mention.index]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const v = input.value;
      input.value = '';
      autoGrow();
      send(v, { source: 'text' });
    }
  });
  $('#sendBtn').addEventListener('click', () => {
    closeMentionList();
    const v = input.value;
    input.value = '';
    autoGrow();
    send(v, { source: 'text' });
  });
}

/* ==================================================================== *
 * 明细页
 * ==================================================================== */

function renderDetail() {
  const box = $('#detailBody');
  clear(box);
  const stats = store.statsFor({ preset: 'month' });
  const records = store.activeRecords().slice()
    .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));

  const summary = el('div', { class: 'detail-summary' }, [
    el('div', { class: 'detail-summary__main' }, [
      el('div', { class: 'k', text: `本月支出 · ${stats.range.from} ~ ${stats.range.to}` }),
      el('div', { class: 'v', text: formatMoney(stats.expenseCents) }),
      el('div', { class: 'k', text: `${stats.count} 笔 · 餐食 ${formatMoney(stats.meal.cents)}（${(stats.meal.share * 100).toFixed(1)}%）` }),
    ]),
    el('img', { class: 'detail-mascot', src: './img/yier.svg', alt: '' }),
  ]);
  box.append(summary);
  animateCount(summary.querySelector('.v'), stats.expenseCents);

  if (!records.length) {
    box.append(el('div', { class: 'empty-page' }, [
      el('div', { class: 'big', text: '🧾' }),
      el('div', { text: '还没有记账记录' }),
    ]));
    return;
  }

  let lastDate = null;
  for (const rec of records) {
    if (rec.occurredDate !== lastDate) {
      lastDate = rec.occurredDate;
      const dayTotal = records
        .filter((r) => r.occurredDate === lastDate && r.type === 'expense')
        .reduce((a, r) => a + r.amountCents, 0);
      box.append(el('div', { class: 'day-head' }, [
        el('span', { text: fmtDayLabel(rec.occurredDate) }),
        el('span', { text: `支出 ${formatMoney(dayTotal)}` }),
      ]));
    }
    const payer = store.memberOf(rec.payerAccountId);
    const author = store.memberOf(rec.authorAccountId);
    const income = rec.type === 'income' || rec.type === 'refund';
    box.append(el('div', {
      class: 'rec-row',
      role: 'button',
      tabindex: '0',
      onclick: () => openRecordSheet(rec),
      onkeydown: (e) => { if (e.key === 'Enter') openRecordSheet(rec); },
    }, [
      el('div', { class: 'rec-icon', text: iconOf(rec.category) }),
      el('div', { class: 'rec-main' }, [
        el('div', { class: 'rec-cat', text: `${rec.category}${rec.subcategory ? ` · ${rec.subcategory}` : ''}` }),
        el('div', {
          class: 'rec-sub',
          text: [rec.note, payer ? `付款 ${payer.displayName}` : '', author && Number(author.accountId) !== Number(store.account.id) ? `记 ${author.displayName}` : '']
            .filter(Boolean).join(' · ') || (rec.occurredTime || ''),
        }),
      ]),
      el('div', { class: `rec-amount${income ? ' income' : ''}`, text: amountText(rec) }),
    ]));
  }
}

/* ==================================================================== *
 * 统计页
 * ==================================================================== */

async function mountStats() {
  if (!statsPromise) {
    statsPromise = import('./stats-page.js').then((mod) => {
      statsPage = mod.createStatsPage({
        mount: $('#statsMount'),
        getState: () => ({
          records: store.activeRecords(),
          users: store.members.map((m) => ({ id: m.accountId, name: m.displayName, emoji: m.emoji, color: m.color })),
          books: store.books,
          activeBookId: store.book ? store.book.id : null,
          config: { largeThresholdCents: Number(prefs.get(LS.largeThresholdCents, store.config.largeThresholdCents || 5000)) },
          today: store.today,
        }),
        onOpenRecord: (id) => {
          const rec = store.records.find((r) => String(r.id) === String(id));
          if (rec) openRecordSheet(rec);
        },
      });
      return statsPage;
    });
  }
  try {
    const page = await statsPromise;
    page.render();
  } catch (err) {
    toast(`统计页加载失败：${err.message}`);
  }
}

/* ==================================================================== *
 * 搜索页
 * ==================================================================== */

function renderSearch() {
  const box = $('#searchBody');
  clear(box);
  if (!searchResults) {
    box.append(el('div', { class: 'empty-page' }, [
      el('img', { class: 'mascot-pair', src: './img/pair.svg', alt: '' }),
      el('div', { text: '输入账本名、备注、类别或金额' }),
    ]));
    return;
  }
  const { books, records } = searchResults;
  if (!books.length && !records.length) {
    box.append(el('div', { class: 'empty-page' }, [el('div', { text: '没有找到匹配的内容' })]));
    return;
  }

  if (books.length) {
    box.append(el('div', { class: 'search-section' }, [
      el('div', { class: 'search-title', text: `账本（${books.length}）` }),
      ...books.map((b) => el('div', {
        class: 'book-row',
        onclick: () => { openBook(b.id); },
      }, [
        el('div', { class: 'book-avatar', text: b.emoji || '📒' }),
        el('div', { class: 'book-main' }, [
          el('div', { class: 'book-name', text: b.name }),
          el('div', { class: 'book-preview', text: `${b.memberCount} 人 · ${b.recordCount} 笔` }),
        ]),
        el('span', { class: 'tag', text: roleLabel(b.role) }),
      ])),
    ]));
  }

  if (records.length) {
    box.append(el('div', { class: 'search-section' }, [
      el('div', { class: 'search-title', text: `记录（${records.length}）` }),
      ...records.map((rec) => el('div', {
        class: 'rec-row',
        onclick: async () => {
          if (String(store.book ? store.book.id : null) !== String(rec.bookId)) {
            await openBook(rec.bookId);
          }
          navigate('chat');
          openRecordSheet(rec);
        },
      }, [
        el('div', { class: 'rec-icon', text: iconOf(rec.category) }),
        el('div', { class: 'rec-main' }, [
          el('div', { class: 'rec-cat', text: `${rec.category}${rec.subcategory ? ` · ${rec.subcategory}` : ''}` }),
          el('div', { class: 'rec-sub', text: `${rec.bookEmoji || '📒'} ${rec.bookName} · ${rec.occurredDate}${rec.note ? ` · ${rec.note}` : ''}` }),
        ]),
        el('div', { class: 'rec-amount', text: amountText(rec) }),
      ])),
    ]));
  }
}

async function runSearch(q) {
  const keyword = String(q || '').trim();
  if (!keyword) { searchResults = null; renderSearch(); return; }
  try {
    searchResults = await store.search(keyword);
    renderSearch();
  } catch (err) {
    if (err.code === 'OFFLINE') toast('离线状态下不能搜索');
    else toast(err.message);
  }
}

/* ==================================================================== *
 * 弹层：创建 / 加入 / 扫码 / 成员 / 记录编辑
 * ==================================================================== */

let sheetTimer = null;

function openSheet(build) {
  const body = $('#sheetBody');
  const sheet = $('#sheet');
  const mask = $('#sheetMask');
  if (sheetTimer) { clearTimeout(sheetTimer); sheetTimer = null; }
  clear(body);
  body.scrollTop = 0;
  build(body, closeSheet);
  sheet.classList.remove('hidden', 'is-closing');
  mask.classList.remove('hidden', 'is-closing');
}

function closeSheet() {
  const sheet = $('#sheet');
  const mask = $('#sheetMask');
  if (sheet.classList.contains('hidden') || sheet.classList.contains('is-closing')) return;
  sheet.classList.add('is-closing');
  mask.classList.add('is-closing');
  if (sheetTimer) clearTimeout(sheetTimer);
  sheetTimer = setTimeout(() => {
    sheet.classList.add('hidden');
    mask.classList.add('hidden');
    sheet.classList.remove('is-closing');
    mask.classList.remove('is-closing');
    sheetTimer = null;
  }, reduceMotion() ? 0 : 250);
}

const field = (labelText, control) => el('div', { class: 'field' }, [el('label', { text: labelText }), control]);

function openAddSheet({ firstRun = false } = {}) {
  openSheet((body, close) => {
    if (firstRun) body.append(el('img', { class: 'sheet-mascot', src: './img/pair.svg', alt: '' }));
    body.append(el('h3', { text: firstRun ? '先建一个账本' : '加入账本' }));
    body.append(el('p', {
      class: 'quota-line',
      text: `你已创建 ${(store.stats && store.stats.booksCreated) || 0}/${store.maxBooks} 个账本（加入别人的不占额度）`,
    }));

    body.append(el('div', { class: 'list-item', onclick: () => { close(); openCreateBookSheet(); } }, [
      el('div', { class: 'li-emoji', text: '📒' }),
      el('div', { class: 'li-main' }, [
        el('div', { class: 'li-title', text: '创建账本' }),
        el('div', { class: 'li-sub', text: '起个名字、选一个图标，立刻开始记账' }),
      ]),
      el('span', { class: 'chev', text: '›' }),
    ]));

    body.append(el('div', { class: 'list-item', onclick: () => { close(); openJoinSheet(); } }, [
      el('div', { class: 'li-emoji', text: '🔗' }),
      el('div', { class: 'li-main' }, [
        el('div', { class: 'li-title', text: '加入账本' }),
        el('div', { class: 'li-sub', text: '输入邀请码，或者扫一扫家人的二维码' }),
      ]),
      el('span', { class: 'chev', text: '›' }),
    ]));
  });
}

function openCreateBookSheet() {
  openSheet((body, close) => {
    body.append(el('h3', { text: '创建账本' }));
    let icon = BOOK_ICONS[0];
    const nameInput = el('input', { type: 'text', maxlength: '24', placeholder: '例如：家庭账本' });
    body.append(field('账本名称', nameInput));

    const grid = el('div', { class: 'icon-grid' });
    const paint = () => {
      clear(grid);
      for (const item of BOOK_ICONS) {
        grid.append(el('button', {
          class: item === icon ? 'active' : '',
          type: 'button',
          text: item,
          onclick: () => { icon = item; paint(); },
        }));
      }
    };
    paint();
    body.append(field('账本图标（预设）', grid));

    body.append(el('div', { class: 'sheet-actions' }, [
      el('button', {
        class: 'primary',
        type: 'button',
        text: '创建',
        onclick: async () => {
          try {
            await store.createBook({ name: nameInput.value.trim(), emoji: icon });
            close();
            switchTab('books');
            toast('账本已创建');
          } catch (err) { toast(err.message); }
        },
      }),
    ]));
  });
}

function openJoinSheet() {
  openSheet((body, close) => {
    body.append(el('h3', { text: '加入账本' }));
    const codeInput = el('input', {
      type: 'text',
      maxlength: '8',
      placeholder: '8 位邀请码',
      style: { textTransform: 'uppercase', letterSpacing: '2px' },
    });
    body.append(field('邀请码', codeInput));

    const doJoin = async (code) => {
      const value = String(code || '').trim().toUpperCase();
      if (!value) { toast('请输入邀请码'); return; }
      try {
        const r = await store.joinBook(value);
        close();
        switchTab('books');
        toast(r.alreadyMember ? '你已经在这个账本里了' : `已加入「${r.book.name}」`);
      } catch (err) { toast(err.message); }
    };

    body.append(el('div', { class: 'sheet-actions' }, [
      el('button', { class: '', type: 'button', text: '扫一扫', onclick: () => { close(); openScanner(doJoin); } }),
      el('button', { class: 'primary', type: 'button', text: '加入', onclick: () => doJoin(codeInput.value) }),
    ]));
    body.append(el('div', { class: 'rc-note', style: { marginTop: '14px' }, text:
      '邀请码在账本「成员」面板里，管理员可以查看、复制或重置。' }));
  });
}

/** 扫一扫：用原生 BarcodeDetector 解码，失败时提示手动输入 */
async function openScanner(onCode) {
  if (typeof window.BarcodeDetector === 'undefined') {
    toast('当前设备不支持扫一扫，请手动输入邀请码');
    openJoinSheet();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('无法访问摄像头，请手动输入邀请码');
    openJoinSheet();
    return;
  }

  const video = el('video', { playsinline: true, muted: true });
  const closeBtn = el('button', { type: 'button', text: '✕', onclick: () => stop() });
  const overlay = el('div', { class: 'scan-overlay' }, [
    video,
    el('div', { class: 'scan-frame' }),
    el('div', { class: 'scan-top' }, [closeBtn, el('span', { text: '扫一扫邀请码' })]),
    el('div', { class: 'scan-tip', text: '把家人账本里的二维码放进框内' }),
  ]);
  document.body.append(overlay);
  try { history.pushState({ scanner: true }, ''); } catch { /* ignore */ }

  let stopped = false;
  let stream = null;
  let timer = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (stream) { for (const track of stream.getTracks()) { try { track.stop(); } catch { /* ignore */ } } }
    overlay.remove();
    if (scanner === stop) scanner = null;
  };
  scanner = stop;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    stop();
    toast(`无法打开摄像头：${err.message || '请检查权限'}`);
    openJoinSheet();
    return;
  }

  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  const loop = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(video);
      for (const c of codes) {
        const code = extractInviteCode(c.rawValue);
        if (code) { stop(); onCode(code); return; }
      }
    } catch { /* 单帧失败忽略 */ }
    timer = setTimeout(loop, 350);
  };
  loop();
}

function openMembersSheet() {
  if (!store.book) { toast('请先进入一个账本'); return; }
  openSheet((body, close) => {
    body.append(el('h3', { text: '成员' }));
    body.append(el('p', {
      class: 'quota-line',
      text: `${store.members.length}/${store.maxMembers} 人 · 你是${roleLabel(store.role)}`,
    }));

    if (store.isManager && store.book.inviteCode) {
      body.append(el('div', { class: 'qr-box' }, [
        el('div', { html: qrSvg(store.book.inviteCode, { scale: 6, quiet: 3 }) }),
        el('div', { class: 'qr-hint', text: '让对方用「加入账本 → 扫一扫」扫这个码' }),
      ]));
      body.append(el('div', { class: 'invite-box' }, [
        el('div', { class: 'invite-code', text: store.book.inviteCode }),
        el('button', {
          class: 'mini-btn',
          type: 'button',
          text: '复制',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(store.book.inviteCode);
              toast('邀请码已复制');
            } catch { toast('复制失败，请手动记录'); }
          },
        }),
        el('button', {
          class: 'mini-btn',
          type: 'button',
          text: '重置',
          onclick: async () => {
            try {
              await store.resetInviteCode();
              close();
              openMembersSheet();
              toast('邀请码已重置，旧码立即失效');
            } catch (err) { toast(err.message); }
          },
        }),
      ]));
    }

    for (const m of store.members) {
      const isMe = store.account && Number(m.accountId) === Number(store.account.id);
      const canRemove = store.isManager && !isMe && m.role !== 'owner'
        && !(store.role === 'admin' && m.role === 'admin');
      body.append(el('div', { class: 'member-row' }, [
        el('div', { class: 'm-emoji', text: m.emoji || '🙂' }),
        el('div', { class: 'm-main' }, [
          el('div', { class: 'm-name' }, [
            document.createTextNode(m.displayName),
            el('span', {
              class: `role-badge${m.role === 'owner' ? ' owner' : m.role === 'admin' ? ' admin' : ''}`,
              text: roleLabel(m.role),
            }),
            isMe ? el('span', { class: 'tag brand', text: '我' }) : null,
          ]),
          el('div', {
            class: 'm-sub',
            text: isMe ? (m.email || '') : (m.joinedAt ? `加入于 ${String(m.joinedAt).slice(5, 10)}` : ''),
          }),
        ]),
        canRemove ? el('div', { class: 'm-actions' }, [
          el('button', {
            class: 'danger',
            type: 'button',
            text: '移出',
            onclick: async () => {
              try {
                await store.removeMember(m.accountId);
                close();
                openMembersSheet();
                toast(`已把「${m.displayName}」移出，TA 的记录会保留`);
              } catch (err) { toast(err.message); }
            },
          }),
        ]) : null,
      ]));
    }

    // 一条必要的说明：只讲"移出后记录会怎样"，不讲操作方法
    if (store.isManager) {
      body.append(el('div', { class: 'rc-note', style: { marginTop: '14px' }, text: '移出成员后，TA 的记账记录会保留。' }));
    }

    if (store.isOwner) {
      const normal = store.members.filter((m) => m.role === 'member' && Number(m.accountId) !== Number(store.account.id));
      if (normal.length) {
        body.append(el('div', { class: 'section-title', text: '设为管理员' }));
        for (const m of normal) {
          body.append(el('div', { class: 'member-row' }, [
            el('div', { class: 'm-emoji', text: m.emoji || '🙂' }),
            el('div', { class: 'm-main' }, [el('div', { class: 'm-name', text: m.displayName })]),
            el('div', { class: 'm-actions' }, [
              el('button', {
                type: 'button',
                text: '设为管理员',
                onclick: async () => {
                  try {
                    await store.setMemberRole(m.accountId, 'admin');
                    close();
                    openMembersSheet();
                    toast(`已把「${m.displayName}」设为管理员`);
                  } catch (err) { toast(err.message); }
                },
              }),
            ]),
          ]));
        }
      }
      const admins = store.members.filter((m) => m.role === 'admin');
      if (admins.length) {
        body.append(el('div', { class: 'section-title', text: '取消管理员' }));
        for (const m of admins) {
          body.append(el('div', { class: 'member-row' }, [
            el('div', { class: 'm-emoji', text: m.emoji || '🙂' }),
            el('div', { class: 'm-main' }, [el('div', { class: 'm-name', text: m.displayName })]),
            el('div', { class: 'm-actions' }, [
              el('button', {
                type: 'button',
                text: '取消管理员',
                onclick: async () => {
                  try {
                    await store.setMemberRole(m.accountId, 'member');
                    close();
                    openMembersSheet();
                    toast(`已取消「${m.displayName}」的管理员`);
                  } catch (err) { toast(err.message); }
                },
              }),
            ]),
          ]));
        }
      }
    }
  });
}

/* ---------------------------- 记录编辑 ---------------------------- */

function openRecordSheet(rec) {
  const editable = store.canEdit(rec);
  const members = store.members;
  const draft = {
    type: rec.type,
    amount: (rec.amountCents / 100).toFixed(2),
    category: rec.category,
    subcategory: rec.subcategory || '',
    occurredDate: rec.occurredDate,
    occurredTime: rec.occurredTime || '',
    payerAccountId: rec.payerAccountId,
    note: rec.note || '',
    participants: (rec.participants || []).map((p) => p.accountId),
  };

  openSheet((body, close) => {
    body.append(el('h3', { text: editable ? '修改这笔账' : '账目详情' }));
    if (!editable) {
      const author = store.memberOf(rec.authorAccountId);
      body.append(el('div', { class: 'rc-note', text: `这条是「${author ? author.displayName : '别人'}」发送的，只有本人或账本管理员可以修改。` }));
    }

    const typeSwitch = el('div', { class: 'type-switch' });
    const types = [['expense', '支出'], ['income', '收入'], ['refund', '退款'], ['transfer', '转账']];
    const paintTypes = () => {
      clear(typeSwitch);
      for (const [value, label] of types) {
        typeSwitch.append(el('button', {
          class: draft.type === value ? 'active' : '',
          type: 'button',
          text: label,
          disabled: !editable,
          onclick: () => { draft.type = value; paintTypes(); },
        }));
      }
    };
    paintTypes();
    body.append(field('类型', typeSwitch));

    const amountInput = el('input', { type: 'number', inputmode: 'decimal', step: '0.01', value: draft.amount, disabled: !editable });
    amountInput.addEventListener('input', () => { draft.amount = amountInput.value; });
    body.append(field('金额（元）', el('div', { class: 'amount-input' }, [el('span', { class: 'cur', text: '¥' }), amountInput])));

    const catGrid = el('div', { class: 'chip-grid' });
    const subGrid = el('div', { class: 'chip-grid', style: { marginTop: '8px' } });
    const paintSubs = () => {
      clear(subGrid);
      const def = CATEGORY_TREE.find((c) => c.name === draft.category);
      if (!def) return;
      subGrid.append(el('button', {
        class: `chip sub${draft.subcategory ? '' : ' active'}`,
        type: 'button',
        text: '不指定',
        disabled: !editable,
        onclick: () => { draft.subcategory = ''; paintSubs(); },
      }));
      for (const s of def.subs) {
        if (s === '无类别') continue;
        subGrid.append(el('button', {
          class: `chip sub${draft.subcategory === s ? ' active' : ''}`,
          type: 'button',
          text: s,
          disabled: !editable,
          onclick: () => { draft.subcategory = s; paintSubs(); },
        }));
      }
    };
    const paintCats = () => {
      clear(catGrid);
      for (const name of CATEGORY_TREE.map((c) => c.name)) {
        catGrid.append(el('button', {
          class: `chip${draft.category === name ? ' active' : ''}`,
          type: 'button',
          text: `${iconOf(name)} ${name}`,
          disabled: !editable,
          onclick: () => { draft.category = name; paintCats(); paintSubs(); },
        }));
      }
    };
    paintCats();
    paintSubs();
    body.append(field('类别', el('div', {}, [catGrid, subGrid])));

    const dateInput = el('input', { type: 'date', value: draft.occurredDate, disabled: !editable });
    dateInput.addEventListener('change', () => { draft.occurredDate = dateInput.value; });
    const timeInput = el('input', { type: 'time', value: draft.occurredTime || '', disabled: !editable });
    timeInput.addEventListener('change', () => { draft.occurredTime = timeInput.value; });
    body.append(el('div', { class: 'field-row' }, [field('日期', dateInput), field('时间（可空）', timeInput)]));

    const payerSelect = el('select', { disabled: !editable });
    for (const m of members) {
      payerSelect.append(el('option', {
        value: String(m.accountId),
        text: `${m.emoji || '🙂'} ${m.displayName}`,
        selected: String(m.accountId) === String(draft.payerAccountId),
      }));
    }
    payerSelect.addEventListener('change', () => { draft.payerAccountId = Number(payerSelect.value); });
    body.append(field('这笔钱是谁花的', payerSelect));

    if (members.length > 1) {
      const partGrid = el('div', { class: 'chip-grid' });
      const paintParts = () => {
        const chips = partGrid.children;
        members.forEach((m, i) => chips[i].classList.toggle('active', draft.participants.includes(m.accountId)));
      };
      for (const m of members) {
        partGrid.append(el('button', {
          class: `chip${draft.participants.includes(m.accountId) ? ' active' : ''}`,
          type: 'button',
          text: `${m.emoji || '🙂'} ${m.displayName}`,
          disabled: !editable,
          onclick: () => {
            draft.participants = draft.participants.includes(m.accountId)
              ? draft.participants.filter((x) => x !== m.accountId)
              : [...draft.participants, m.accountId];
            paintParts();
          },
        }));
      }
      body.append(field('一起消费的人（AA 分摊）', partGrid));
    }

    const noteInput = el('textarea', { rows: 2, placeholder: '备注', disabled: !editable });
    noteInput.value = draft.note;
    noteInput.addEventListener('input', () => { draft.note = noteInput.value; });
    body.append(field('备注', noteInput));

    if (!editable) {
      body.append(el('div', { class: 'sheet-actions' }, [
        el('button', { class: 'primary', type: 'button', text: '知道了', onclick: close }),
      ]));
      return;
    }

    body.append(el('div', { class: 'sheet-actions' }, [
      el('button', {
        class: 'danger',
        type: 'button',
        text: '删除',
        onclick: async () => {
          try {
            await store.deleteRecord(rec.id);
            close();
            refreshCurrent();
            toast('已删除', { label: '撤销', onClick: async () => { await store.restoreRecord(rec.id); refreshCurrent(); } }, 4500);
          } catch (err) { toast(err.message); }
        },
      }),
      el('button', {
        class: 'primary',
        type: 'button',
        text: '保存',
        onclick: async () => {
          const amountCents = Math.round(Number(draft.amount) * 100);
          if (!Number.isFinite(amountCents) || amountCents <= 0) { toast('金额要大于 0'); return; }
          const chosen = members.filter((m) => draft.participants.includes(m.accountId));
          const parts = chosen.map((m) => ({
            accountId: m.accountId,
            name: m.displayName,
            shareCents: Math.floor(amountCents / chosen.length),
          }));
          if (parts.length > 1) parts[0].shareCents += amountCents - parts.reduce((a, p) => a + p.shareCents, 0);
          try {
            await store.updateRecord(rec.id, {
              type: draft.type,
              amountCents,
              category: draft.category,
              subcategory: draft.subcategory,
              occurredDate: draft.occurredDate,
              occurredTime: draft.occurredTime || null,
              payerAccountId: draft.payerAccountId,
              note: draft.note,
              participants: parts,
            }, rec.version);
            close();
            refreshCurrent();
            toast('已保存');
          } catch (err) {
            toast(`保存失败：${err.message}`);
          }
        },
      }),
    ]));
  });
}

/* ==================================================================== *
 * 绑定与启动
 * ==================================================================== */

function refreshCurrent() {
  paintPage(currentPage());
}

function bindShell() {
  $('#tabBooks').addEventListener('click', () => switchTab('books'));
  $('#tabSettings').addEventListener('click', () => switchTab('settings'));
  $('#chatBack').addEventListener('click', goBack);
  $('#detailBack').addEventListener('click', goBack);
  $('#statsBack').addEventListener('click', goBack);
  $('#searchBack').addEventListener('click', goBack);
  $('#detailBtn').addEventListener('click', () => navigate('detail'));
  $('#detailStats').addEventListener('click', () => navigate('stats'));
  $('#membersBtn').addEventListener('click', openMembersSheet);
  $('#addBtn').addEventListener('click', () => openAddSheet());
  $('#searchBtn').addEventListener('click', () => {
    searchResults = null;
    $('#searchInput').value = '';
    navigate('search');
    renderSearch();
  });
  $('#searchInput').addEventListener('input', (e) => {
    const value = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(value), 260);
  });
  $('#sheetMask').addEventListener('click', closeSheet);
  $('#retryOnlineBtn').addEventListener('click', async () => {
    try {
      await store.sync();
      renderBooks();
      toast(store.online ? '已恢复连接' : '还是连不上，请检查网络后重试');
    } catch (err) { toast(err.message); }
  });
}

async function boot() {
  bindShell();
  bindAuth();
  bindComposer();
  bindVoiceButton();

  recorder = createRecorder({
    maxMs: 60000,
    onTick: (ms) => {
      const s = Math.floor(ms / 1000);
      const timer = $('#recTimer');
      if (timer) timer.textContent = `${Math.floor(s / 60)}:${pad2(s % 60)}`;
    },
    onLevel: updateRecWave,
    onAutoStop: () => finishRecording(false),
    onError: (msg) => toast(msg),
  });

  try {
    const sp = new URLSearchParams(location.search).get('server');
    if (sp) prefs.set(LS.serverUrl, sp.replace(/\/+$/, ''));
  } catch { /* ignore */ }

  try {
    await store.init();
  } catch (err) {
    showAuth();
    showAuthError('#loginError', `初始化失败：${err.message}`);
    return;
  }

  if (!store.loggedIn) {
    showAuth();
    if (!store.serverUrl) {
      showAuthError('#loginError', '安装包配置有误，请联系提供者获取正式版本。');
    } else if (!store.online) {
      showAuthError('#loginError', '连不上服务器，请检查网络后重试。');
    }
    return;
  }

  enterApp();
  try { history.replaceState({ page: 'books' }, ''); } catch { /* ignore */ }
  if (new URLSearchParams(location.search).get('view') === 'detail') navigate('detail');

  store.onChange(() => {
    if (currentPage() === 'chat') renderChat();
    else if (currentPage() === 'detail') renderDetail();
    else if (currentPage() === 'books') renderBooks();
    else if (currentPage() === 'settings') renderSettings();
  });

  window.addEventListener('online', () => { store.sync().catch(() => {}); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) store.sync().catch(() => {});
  });
}

boot();
