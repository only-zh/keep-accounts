/**
 * 前端数据层（商业版）。
 *
 * 与旧版的区别：
 *   - 没有「本地模式」：必须登录并连上服务器（按需求：不允许断网使用）
 *   - 断网时只读缓存：可以看历史记录，但发送会失败并标红，不入库
 *   - 身份 = 登录账号；账本由服务端下发，带我的角色（owner/admin/member）
 *   - 前端权限判断只用于界面显示，真正的拦截在服务端
 */

import { LocalDb, prefs } from './db.js';
import { httpJson, httpRequest, nativeServerUrl } from './native.js';
import { transcribe } from './llm.js';
import { computeStats, presetRange } from '../../shared/stats.js';
import { tzNow } from '../../shared/date.js';
import { iconOf } from '../../shared/categories.js';

export const LS = {
  serverUrl: 'serverUrl',
  token: 'token',
  activeBookId: 'activeBookId',
  lastSync: 'lastSync',
  largeThresholdCents: 'largeThresholdCents',
};

export const MANAGER_ROLES = ['owner', 'admin'];

export class Store {
  constructor() {
    this.db = new LocalDb();
    this.config = {
      tz: 'Asia/Shanghai',
      largeThresholdCents: 5000,
      quotas: { maxBooksPerAccount: 10, maxMembersPerBook: 5 },
    };
    this.account = null;
    this.stats = null;
    this.books = [];
    this.book = null;
    this.role = null;
    this.members = [];
    this.authors = [];   // 记录里出现过的账号（含已移出的成员）
    this.records = [];
    this.messages = [];
    this.failed = [];
    this.online = true;
    this.lastError = '';
    this.lastSync = prefs.get(LS.lastSync, null);
    this.activeBookId = prefs.get(LS.activeBookId, null);
    this.token = prefs.get(LS.token, '') || '';
    this.listeners = new Set();
  }

  /* ============================ 基础 ============================ */

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) { try { fn(this); } catch { /* ignore */ } } }

  get loggedIn() { return !!this.token && !!this.account; }
  get isManager() { return MANAGER_ROLES.includes(String(this.role || '')); }
  get isOwner() { return this.role === 'owner'; }
  get today() { return tzNow(this.config.tz || 'Asia/Shanghai').ymd; }
  get maxMembers() { return this.config.quotas?.maxMembersPerBook ?? 5; }
  get maxBooks() { return this.config.quotas?.maxBooksPerAccount ?? 10; }

  /**
   * 接口根地址。优先级：
   *   1. 调试覆盖（localStorage / 原生 Setting，仅用于联调，界面不暴露）
   *   2. 构建期注入的 apiBase（APK 由 build.sh 写死，浏览器留空）
   *   3. 同源（浏览器直接访问服务时）
   */
  get serverUrl() {
    const debug = prefs.get(LS.serverUrl, '') || nativeServerUrl() || '';
    const injected = (typeof window !== 'undefined' && window.__KA_CONFIG__ && window.__KA_CONFIG__.apiBase) || '';
    const sameOrigin = (typeof location !== 'undefined' && location.protocol.startsWith('http'))
      ? location.origin
      : '';
    return String(debug || injected || sameOrigin).replace(/\/+$/, '');
  }

  /* ============================ 启动 ============================ */

  async init() {
    try { await this.db.open(); } catch { /* LocalDb 内部已降级为内存存储 */ }
    if (!this.token) { this.emit(); return this; }
    try {
      await this.loadBootstrap();
      this.online = true;
    } catch (err) {
      this.lastError = err.message || '';
      if (err.status === 401 || err.code === 'UNAUTHORIZED') {
        this.token = '';
        this.account = null;
        prefs.remove(LS.token);
      } else {
        this.online = false;
        await this.loadCache();
      }
    }
    this.emit();
    return this;
  }

  async loadCache() {
    const [books, members, records, messages, failed] = await Promise.all([
      this.db.all('books'), this.db.all('members'), this.db.all('records'),
      this.db.all('messages'), this.db.all('queue'),
    ]);
    this.books = books.sort((a, b) => Number(b.id) - Number(a.id));
    this.members = members;
    this.records = records;
    this.messages = messages.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    this.failed = failed;
    const b = this.books.find((x) => String(x.id) === String(this.activeBookId)) || this.books[0] || null;
    this.book = b;
    this.role = b ? b.role : null;
  }

  /** 缓存用的成员行：IndexedDB 的主键是 id，而接口返回的是 accountId */
  memberRows(list = this.members) {
    return (list || []).map((m) => ({ ...m, id: `${m.bookId}_${m.accountId}` }));
  }

  /* ============================ HTTP ============================ */

  async apiRaw(path, opts = {}) {
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (opts.body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await httpRequest({
        method: opts.method || 'GET',
        url: `${this.serverUrl}${path}`,
        headers,
        body: opts.body ? JSON.stringify(opts.body) : null,
      });
    } catch (err) {
      this.online = false;
      const offline = new Error('网络不可用，请检查网络或服务器地址');
      offline.code = 'OFFLINE';
      offline.status = 0;
      throw offline;
    }
    let json = null;
    try { json = res.text ? JSON.parse(res.text) : null; } catch { json = null; }
    if (res.status < 200 || res.status >= 300) {
      if (res.status >= 500) this.online = false;
      const e = new Error((json && json.error) || `请求失败（HTTP ${res.status}）`);
      e.status = res.status;
      e.code = json && json.code;
      throw e;
    }
    this.online = true;
    return json ? json.data : null;
  }

  /* ============================ 账号 ============================ */

  async requestCode(email, purpose = 'register') {
    return this.apiRaw('/api/auth/code', { method: 'POST', body: { email, purpose } });
  }

  async register({ email, code, displayName, password }) {
    const data = await this.apiRaw('/api/auth/register', {
      method: 'POST', body: { email, code, displayName, password },
    });
    this.applySession(data);
    await this.loadBootstrap();
    return data;
  }

  async login(email, password) {
    const data = await this.apiRaw('/api/auth/login', { method: 'POST', body: { email, password } });
    this.applySession(data);
    await this.loadBootstrap();
    return data;
  }

  applySession(data) {
    this.token = data.token;
    this.account = data.account;
    // 换账号时必须丢掉上一个账号的"当前账本"，否则会请求到不属于自己的账本
    this.activeBookId = null;
    this.lastSync = null;
    prefs.remove(LS.activeBookId);
    prefs.remove(LS.lastSync);
    prefs.set(LS.token, data.token);
  }

  async logout() {
    try { await this.apiRaw('/api/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
    this.token = '';
    this.account = null;
    this.book = null;
    this.books = [];
    this.members = [];
    this.authors = [];   // 记录里出现过的账号（含已移出的成员）
    this.records = [];
    this.messages = [];
    this.failed = [];
    this.role = null;
    prefs.remove(LS.token);
    prefs.remove(LS.lastSync);
    await Promise.all([
      this.db.clear('records'), this.db.clear('messages'), this.db.clear('books'),
      this.db.clear('members'), this.db.clear('queue'),
    ]);
    this.emit();
  }

  async updateProfile({ displayName, emoji }) {
    const data = await this.apiRaw('/api/auth/profile', { method: 'PATCH', body: { displayName, emoji } });
    this.account = data.account;
    this.emit();
    return this.account;
  }

  async changePassword(oldPassword, newPassword) {
    const data = await this.apiRaw('/api/auth/password', { method: 'POST', body: { oldPassword, newPassword } });
    if (data && data.token) {
      this.token = data.token;
      prefs.set(LS.token, data.token);
    }
    return true;
  }

  /* ============================ 账本 / 成员 ============================ */

  async loadBootstrap(bookId = null) {
    const bid = bookId || this.activeBookId;
    let data;
    try {
      data = await this.apiRaw(`/api/bootstrap${bid ? `?bookId=${bid}` : ''}`);
    } catch (err) {
      // 缓存的 bookId 不属于当前账号（换过账号/被移出账本）→ 丢掉它再取一次
      if (bid && (err.status === 404 || err.code === 'NOT_MEMBER')) {
        this.activeBookId = null;
        prefs.remove(LS.activeBookId);
        this.lastSync = null;
        prefs.remove(LS.lastSync);
        data = await this.apiRaw('/api/bootstrap');
      } else {
        throw err;
      }
    }
    this.config = { ...this.config, ...(data.config || {}) };
    this.account = data.account;
    this.stats = data.stats;
    this.books = data.books || [];
    this.book = data.book || null;
    this.role = data.role || null;
    this.members = data.members || [];
    this.authors = data.authors || [];
    this.records = data.records || [];
    this.messages = data.messages || [];
    this.lastSync = data.serverTime || null;
    if (this.book) {
      this.activeBookId = this.book.id;
      prefs.set(LS.activeBookId, this.book.id);
      prefs.set(LS.lastSync, this.lastSync);
      await Promise.all([
        this.db.replaceAll('books', this.books),
        this.db.replaceAll('members', this.memberRows()),
        this.db.replaceAll('records', this.records),
        this.db.replaceAll('messages', this.messages),
      ]);
    } else {
      this.activeBookId = null;
      prefs.remove(LS.activeBookId);
      await this.db.replaceAll('books', this.books);
    }
    this.failed = await this.db.all('queue');
    this.emit();
    return data;
  }

  /** 打开 App / 回到前台时增量拉取（服务器是权威数据源） */
  async sync() {
    if (!this.loggedIn || !this.book) return;
    try {
      const q = new URLSearchParams();
      q.set('bookId', String(this.book.id));
      if (this.lastSync) q.set('since', this.lastSync);
      const data = await this.apiRaw(`/api/sync?${q.toString()}`);
      const map = new Map(this.records.map((r) => [String(r.id), r]));
      for (const rec of data.records || []) map.set(String(rec.id), rec);
      this.records = [...map.values()];
      this.members = data.members || this.members;
      this.authors = data.authors || this.authors;
      if (data.book) { this.book = data.book; this.role = data.role; }
      this.lastSync = data.serverTime;
      prefs.set(LS.lastSync, this.lastSync);
      if (data.messages && data.messages.length) {
        const seen = new Set(this.messages.map((m) => String(m.id)));
        for (const msg of data.messages) if (!seen.has(String(msg.id))) this.messages.push(msg);
        this.messages.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      }
      await Promise.all([
        this.db.replaceAll('records', this.records),
        this.db.replaceAll('messages', this.messages),
        this.db.replaceAll('members', this.memberRows()),
      ]);
      this.online = true;
      this.emit();
    } catch (err) {
      if (err.code === 'OFFLINE' || err.status === 0) { this.online = false; this.emit(); return; }
      throw err;
    }
  }

  async selectBook(bookId) {
    this.activeBookId = bookId;
    prefs.set(LS.activeBookId, bookId);
    prefs.remove(LS.lastSync);
    this.lastSync = null;
    await this.loadBootstrap(bookId);
    return this.book;
  }

  async refreshBooks() {
    const data = await this.apiRaw('/api/books');
    this.books = data.books || [];
    this.stats = data.stats;
    this.emit();
    return this.books;
  }

  async createBook({ name, emoji }) {
    const data = await this.apiRaw('/api/books', { method: 'POST', body: { name, emoji } });
    this.stats = data.stats;
    await this.loadBootstrap(data.book.id);
    return data.book;
  }

  async joinBook(code) {
    const data = await this.apiRaw('/api/books/join', { method: 'POST', body: { code } });
    this.stats = data.stats;
    await this.loadBootstrap(data.book.id);
    return data;
  }

  async loadMembers() {
    if (!this.book) return [];
    const data = await this.apiRaw(`/api/books/${this.book.id}/members`);
    this.members = data.members || [];
    await this.db.replaceAll('members', this.memberRows());
    this.emit();
    return this.members;
  }

  async setMemberRole(accountId, role) {
    const data = await this.apiRaw(`/api/books/${this.book.id}/members/${accountId}/role`, {
      method: 'POST', body: { role },
    });
    this.members = data.members || this.members;
    await this.db.replaceAll('members', this.memberRows());
    this.emit();
    return this.members;
  }

  async removeMember(accountId) {
    const data = await this.apiRaw(`/api/books/${this.book.id}/members/${accountId}`, { method: 'DELETE' });
    this.members = data.members || this.members;
    await this.db.replaceAll('members', this.memberRows());
    this.emit();
    return this.members;
  }

  async resetInviteCode() {
    const data = await this.apiRaw(`/api/books/${this.book.id}/invite-code`, { method: 'POST' });
    if (this.book) this.book.inviteCode = data.inviteCode;
    const idx = this.books.findIndex((b) => String(b.id) === String(this.book.id));
    if (idx >= 0) this.books[idx].inviteCode = data.inviteCode;
    this.emit();
    return data.inviteCode;
  }

  /* ============================ 发送 ============================ */

  /**
   * 发送一条输入。断网/失败时不入账，抛错给界面标红并提供重试。
   */
  async sendMessage(text, { source = 'text', clientMsgId = null } = {}) {
    if (!this.loggedIn) { const e = new Error('请先登录'); e.code = 'UNAUTHORIZED'; throw e; }
    if (!this.book) { const e = new Error('请先创建或加入一个账本'); e.code = 'NO_BOOK'; throw e; }
    // 已知离线时直接失败，不浪费时间等超时；界面会标红并提供重试
    if (!this.online) {
      const e = new Error('网络不可用，请检查网络或服务器地址');
      e.code = 'OFFLINE';
      e.status = 0;
      throw e;
    }
    const cmid = clientMsgId || `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const data = await this.apiRaw('/api/messages', {
      method: 'POST',
      body: { text, source, clientMsgId: cmid, bookId: this.book.id },
    });
    if (data.duplicated) {
      await this.loadBootstrap(this.book.id);
      return data;
    }
    const { userMessage, assistantMessage, reply } = data;
    this.messages.push(userMessage, assistantMessage);
    await this.db.put('messages', userMessage);
    await this.db.put('messages', assistantMessage);
    for (const rec of reply.records || []) {
      const idx = this.records.findIndex((r) => String(r.id) === String(rec.id));
      if (idx >= 0) this.records[idx] = rec; else this.records.push(rec);
      await this.db.put('records', rec);
    }
    this.online = true;
    this.emit();
    return { userMessage, assistantMessage, reply };
  }

  /** 发送失败的消息：本地留痕 + 标红 + 可重试（不入库） */
  async rememberFailed(text, { source = 'text', reason = '' } = {}) {
    const item = {
      id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      text,
      source,
      bookId: this.book ? this.book.id : null,
      createdAt: new Date().toISOString(),
      reason: reason || (this.online ? '发送失败' : '网络不可用'),
    };
    this.failed.push(item);
    await this.db.put('queue', item);
    this.emit();
    return item;
  }

  async forgetFailed(id) {
    this.failed = this.failed.filter((f) => f.id !== id);
    await this.db.remove('queue', id);
    this.emit();
  }

  /* ============================ 记录增删改 ============================ */

  /** 界面用的权限判断；服务端会再校验一次 */
  canEdit(record) {
    if (!record || !this.account) return false;
    const me = Number(this.account.id);
    if (Number(record.authorAccountId) === me) return true;   // 自己发的
    if (Number(record.payerAccountId) === me) return true;    // 别人帮我记的（@我）
    return this.isManager;
  }

  /** 标记本账本已读（清掉「有人@我」） */
  async markRead() {
    if (!this.book) return;
    try {
      await this.apiRaw(`/api/books/${this.book.id}/read`, { method: 'POST' });
      const b = this.books.find((x) => String(x.id) === String(this.book.id));
      if (b) b.unreadMentions = 0;
    } catch { /* 已读失败不影响使用 */ }
  }

  async updateRecord(id, patch, version = null) {
    const data = await this.apiRaw(`/api/records/${id}`, { method: 'PATCH', body: { patch, version } });
    const rec = data.record;
    const idx = this.records.findIndex((r) => String(r.id) === String(id));
    if (idx >= 0) this.records[idx] = rec; else this.records.push(rec);
    await this.db.put('records', rec);
    this.emit();
    return rec;
  }

  async deleteRecord(id) {
    const data = await this.apiRaw(`/api/records/${id}`, { method: 'DELETE' });
    const rec = data.record;
    const idx = this.records.findIndex((r) => String(r.id) === String(id));
    if (idx >= 0) this.records[idx] = rec;
    await this.db.put('records', rec);
    this.emit();
    return rec;
  }

  async restoreRecord(id) {
    const data = await this.apiRaw(`/api/records/${id}/restore`, { method: 'POST' });
    const rec = data.record;
    const idx = this.records.findIndex((r) => String(r.id) === String(id));
    if (idx >= 0) this.records[idx] = rec;
    await this.db.put('records', rec);
    this.emit();
    return rec;
  }

  /* ============================ 语音 ============================ */

  async transcribe(blob, mime) {
    return transcribe(blob, mime, { mode: 'remote', serverUrl: this.serverUrl, token: this.token });
  }

  /* ============================ 统计 / 展示 ============================ */

  activeRecords() {
    const bid = this.book ? this.book.id : null;
    return this.records.filter((r) => String(r.bookId) === String(bid) && !r.deletedAt);
  }

  statsFor({ preset = 'month', from = null, to = null, filters = {} } = {}) {
    const range = from || to
      ? { from: from || '1970-01-01', to: to || this.today }
      : presetRange(preset, this.today);
    return computeStats(this.activeRecords(), {
      from: range.from,
      to: range.to,
      users: this.members.map((m) => ({ id: m.accountId, name: m.displayName, emoji: m.emoji })),
      largeThresholdCents: Number(prefs.get(LS.largeThresholdCents, this.config.largeThresholdCents || 5000)),
      filters: { ...filters, bookId: this.book ? this.book.id : null },
      compare: false,
    });
  }

  /** 账号信息：先查成员，再查"记录里出现过的账号"（被移出的成员仍能显示名字） */
  memberOf(accountId) {
    const id = Number(accountId);
    const m = this.members.find((x) => Number(x.accountId) === id);
    if (m) return m;
    const a = this.authors.find((x) => Number(x.accountId) === id);
    return a ? { accountId: a.accountId, displayName: a.displayName, emoji: a.emoji, left: true } : null;
  }

  /** 全局搜索：账本 + 记录 */
  async search(q) {
    const keyword = String(q || '').trim();
    if (!keyword) return { books: [], records: [] };
    return this.apiRaw(`/api/search?q=${encodeURIComponent(keyword)}`);
  }

  recordIcon(record) { return iconOf(record.category); }
}

export function createStore() {
  return new Store();
}
