/**
 * 存储层：所有 SQL 收在这里，路由层只调用语义化方法。
 * 商业版核心变化：一切以「账号 + 账本成员角色」为中心。
 *   - 每个方法都要求调用方先确认账号是该账本成员（assertMember 等）
 *   - 角色：owner（创建者）/ admin（管理员）/ member（普通成员）
 *   - 配额：每账号最多创建 N 个账本；每账本最多 M 名成员
 */

import { randomBytes } from 'node:crypto';
import { rowToRecord, rowToAccount, rowToBook, rowToMessage, rowToMember } from './db.js';
import { HttpError } from './errors.js';

export { HttpError };

export const ROLES = ['owner', 'admin', 'member'];

/** 谁能改任意卡片、谁能用 @ 帮别人记账 */
export const MANAGER_ROLES = ['owner', 'admin'];

export function nowIso() {
  return new Date().toISOString();
}

export class Store {
  constructor(db, cfg = {}) {
    this.db = db;
    this.cfg = cfg;
  }

  /* ============================ 设置 / 配额 ============================ */

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
    return value;
  }

  get quotas() {
    return {
      maxBooksPerAccount: this.cfg.maxBooksPerAccount ?? 10,
      maxMembersPerBook: this.cfg.maxMembersPerBook ?? 5,
    };
  }

  get largeThresholdCents() {
    return Number(this.getSetting('largeThresholdCents', this.cfg.largeThresholdCents ?? 5000)) || 5000;
  }

  /* ============================ 账本 ============================ */

  countBooksCreatedBy(accountId) {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM books WHERE owner_account_id = ? AND is_archived = 0')
      .get(Number(accountId)).c);
  }

  /** 账本列表：我创建的 + 我加入的，带我的角色与成员数 */
  listBooksForAccount(accountId, { exposeInvite = false } = {}) {
    const rows = this.db.prepare(
      `SELECT b.*, m.role AS my_role,
              (SELECT COUNT(*) FROM book_members bm WHERE bm.book_id = b.id) AS member_count,
              (SELECT COUNT(*) FROM records r WHERE r.book_id = b.id AND r.deleted_at IS NULL) AS record_count,
              (SELECT msg.content FROM messages msg WHERE msg.book_id = b.id ORDER BY msg.id DESC LIMIT 1) AS last_content,
              (SELECT msg.created_at FROM messages msg WHERE msg.book_id = b.id ORDER BY msg.id DESC LIMIT 1) AS last_at,
              (SELECT a.display_name FROM messages msg JOIN accounts a ON a.id = msg.author_account_id
                 WHERE msg.book_id = b.id ORDER BY msg.id DESC LIMIT 1) AS last_author,
              (SELECT COUNT(*) FROM message_mentions mm
                 LEFT JOIN book_reads br ON br.book_id = mm.book_id AND br.account_id = mm.account_id
                WHERE mm.book_id = b.id AND mm.account_id = m.account_id
                  AND mm.created_at > COALESCE(br.last_read_at, '')) AS unread_mentions
       FROM books b
       JOIN book_members m ON m.book_id = b.id AND m.account_id = ?
       WHERE b.is_archived = 0
       ORDER BY COALESCE((SELECT msg.created_at FROM messages msg WHERE msg.book_id = b.id ORDER BY msg.id DESC LIMIT 1), b.created_at) DESC`,
    ).all(Number(accountId));
    return rows.map((r) => rowToBook(r, {
      role: r.my_role,
      isOwner: r.my_role === 'owner',
      memberCount: Number(r.member_count),
      recordCount: Number(r.record_count),
      unreadMentions: Number(r.unread_mentions || 0),
      maxMembers: this.quotas.maxMembersPerBook,
      lastMessage: r.last_at
        ? { content: r.last_content || '', at: r.last_at, author: r.last_author || '' }
        : null,
      ...(exposeInvite && MANAGER_ROLES.includes(r.my_role) ? { inviteCode: r.invite_code || null } : {}),
    }));
  }

  getBook(bookId) {
    return rowToBook(this.db.prepare('SELECT * FROM books WHERE id = ?').get(Number(bookId)));
  }

  getMembership(bookId, accountId) {
    const row = this.db.prepare('SELECT * FROM book_members WHERE book_id = ? AND account_id = ?')
      .get(Number(bookId), Number(accountId));
    if (!row) return null;
    return { bookId: Number(row.book_id), accountId: Number(row.account_id), role: row.role, joinedAt: row.joined_at };
  }

  /** 必须是账本成员，否则 403 */
  assertMember(bookId, accountId) {
    const m = this.getMembership(bookId, accountId);
    if (!m) throw new HttpError(403, '你不是这个账本的成员', 'NOT_MEMBER');
    return m;
  }

  /** 必须是管理员或创建者 */
  assertManager(bookId, accountId) {
    const m = this.assertMember(bookId, accountId);
    if (!MANAGER_ROLES.includes(m.role)) throw new HttpError(403, '只有管理员可以执行这个操作', 'NOT_MANAGER');
    return m;
  }

  /** 必须是创建者 */
  assertOwner(bookId, accountId) {
    const m = this.assertMember(bookId, accountId);
    if (m.role !== 'owner') throw new HttpError(403, '只有账本创建者可以执行这个操作', 'NOT_OWNER');
    return m;
  }

  newInviteCode() {
    // 8 位大写字母数字，剔除易混字符（0/O/1/I）
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    const bytes = randomBytes(8);
    for (let i = 0; i < 8; i += 1) code += alphabet[bytes[i] % alphabet.length];
    return code;
  }

  createBook(accountId, { name, emoji = '📒' }) {
    const clean = String(name || '').trim();
    if (!clean) throw new HttpError(400, '账本名字不能为空');
    if (clean.length > 24) throw new HttpError(400, '账本名字不能超过 24 个字');
    const { maxBooksPerAccount } = this.quotas;
    const created = this.countBooksCreatedBy(accountId);
    if (created >= maxBooksPerAccount) {
      throw new HttpError(409, `每个账号最多创建 ${maxBooksPerAccount} 个账本（你已创建 ${created} 个）；加入别人的账本不占这个额度`, 'BOOK_QUOTA');
    }
    let code = this.newInviteCode();
    for (let i = 0; i < 5; i += 1) {
      if (!this.db.prepare('SELECT 1 FROM books WHERE invite_code = ?').get(code)) break;
      code = this.newInviteCode();
    }
    const info = this.db.prepare(
      'INSERT INTO books (name, emoji, owner_account_id, invite_code, created_at) VALUES (?,?,?,?,?)',
    ).run(clean, emoji, Number(accountId), code, nowIso());
    const id = Number(info.lastInsertRowid);
    this.db.prepare('INSERT INTO book_members (book_id, account_id, role, joined_at) VALUES (?,?,?,?)')
      .run(id, Number(accountId), 'owner', nowIso());
    return this.getBookWithRole(id, accountId);
  }

  getBookWithRole(bookId, accountId, { exposeInvite = true } = {}) {
    return this.listBooksForAccount(accountId, { exposeInvite })
      .find((b) => Number(b.id) === Number(bookId)) || null;
  }

  updateBook(bookId, accountId, patch = {}) {
    this.assertManager(bookId, accountId);
    const b = this.getBook(bookId);
    if (!b) throw new HttpError(404, '账本不存在');
    if (patch.name !== undefined) {
      const clean = String(patch.name).trim();
      if (!clean) throw new HttpError(400, '账本名字不能为空');
      if (clean.length > 24) throw new HttpError(400, '账本名字不能超过 24 个字');
    }
    this.db.prepare('UPDATE books SET name = ?, emoji = ? WHERE id = ?').run(
      patch.name !== undefined ? String(patch.name).trim() : b.name,
      patch.emoji ?? b.emoji,
      Number(bookId),
    );
    return this.getBookWithRole(bookId, accountId);
  }

  resetInviteCode(bookId, accountId) {
    this.assertManager(bookId, accountId);
    const code = this.newInviteCode();
    this.db.prepare('UPDATE books SET invite_code = ? WHERE id = ?').run(code, Number(bookId));
    return code;
  }

  /** 用邀请码加入账本 */
  joinByInviteCode(accountId, rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) throw new HttpError(400, '请输入邀请码');
    const book = this.db.prepare('SELECT * FROM books WHERE invite_code = ? AND is_archived = 0').get(code);
    if (!book) throw new HttpError(404, '邀请码无效，请向账本创建者确认');
    if (this.getMembership(book.id, accountId)) {
      return { book: this.getBookWithRole(book.id, accountId), alreadyMember: true };
    }
    const { maxMembersPerBook } = this.quotas;
    const count = Number(this.db.prepare('SELECT COUNT(*) AS c FROM book_members WHERE book_id = ?').get(book.id).c);
    if (count >= maxMembersPerBook) {
      throw new HttpError(409, `该账本已满（最多 ${maxMembersPerBook} 人）`, 'BOOK_FULL');
    }
    this.db.prepare('INSERT INTO book_members (book_id, account_id, role, joined_at) VALUES (?,?,?,?)')
      .run(book.id, Number(accountId), 'member', nowIso());
    return { book: this.getBookWithRole(book.id, accountId), alreadyMember: false };
  }

  listMembers(bookId) {
    return this.db.prepare(
      `SELECT m.book_id, m.account_id, m.role, m.joined_at,
              a.display_name, a.email, a.emoji, a.color
       FROM book_members m JOIN accounts a ON a.id = m.account_id
       WHERE m.book_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at ASC`,
    ).all(Number(bookId)).map(rowToMember);
  }

  /** 创建者分配/撤销管理员 */
  setMemberRole(bookId, actorId, targetAccountId, role) {
    this.assertOwner(bookId, actorId);
    if (!['admin', 'member'].includes(role)) throw new HttpError(400, '角色只能是 admin 或 member');
    const target = this.getMembership(bookId, targetAccountId);
    if (!target) throw new HttpError(404, '该用户不是这个账本的成员');
    if (target.role === 'owner') throw new HttpError(400, '不能修改账本创建者的角色');
    if (Number(targetAccountId) === Number(actorId)) throw new HttpError(400, '不能修改自己的角色');
    this.db.prepare('UPDATE book_members SET role = ? WHERE book_id = ? AND account_id = ?')
      .run(role, Number(bookId), Number(targetAccountId));
    return this.listMembers(bookId);
  }

  /**
   * 移出成员：创建者和管理员都可以；被移出者的记账记录**保留**（只删成员关系）。
   * 约束：不能移出创建者；不能移出自己；管理员不能移出其他管理员。
   */
  removeMember(bookId, actorId, targetAccountId) {
    const actor = this.assertManager(bookId, actorId);
    const target = this.getMembership(bookId, targetAccountId);
    if (!target) throw new HttpError(404, '该用户不是这个账本的成员');
    if (target.role === 'owner') throw new HttpError(400, '不能移除账本创建者');
    if (Number(targetAccountId) === Number(actorId)) throw new HttpError(400, '不能移除自己');
    if (actor.role === 'admin' && target.role === 'admin') {
      throw new HttpError(403, '管理员不能移除其他管理员', 'NOT_OWNER');
    }
    this.db.prepare('DELETE FROM book_members WHERE book_id = ? AND account_id = ?')
      .run(Number(bookId), Number(targetAccountId));
    return this.listMembers(bookId);
  }

  /* ============================ 账目 ============================ */

  insertRecord(rec) {
    const ts = nowIso();
    try {
      const info = this.db.prepare(
        `INSERT INTO records (book_id, author_account_id, payer_account_id, type, amount_cents, currency,
          category, subcategory, merchant, note, occurred_at, occurred_date, occurred_time, occurred_text,
          source, raw_text, confidence, status, group_id, client_msg_id, version, participants_json,
          created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        Number(rec.bookId), rec.authorAccountId ?? null, rec.payerAccountId ?? null, rec.type || 'expense',
        Math.round(rec.amountCents), rec.currency || 'CNY', rec.category || '其他', rec.subcategory || '',
        rec.merchant || '', rec.note || '', rec.occurredAt, rec.occurredDate, rec.occurredTime || null,
        rec.occurredText || '', rec.source || 'text', rec.rawText || '', rec.confidence ?? 1,
        rec.status || 'confirmed', rec.groupId || null, rec.clientMsgId || null, rec.version || 1,
        JSON.stringify(rec.participants || []), ts, ts,
      );
      return this.getRecord(Number(info.lastInsertRowid));
    } catch (err) {
      if (String(err.message || '').includes('UNIQUE') && rec.clientMsgId) {
        const exist = this.db.prepare('SELECT * FROM records WHERE client_msg_id = ?').get(rec.clientMsgId);
        if (exist) return rowToRecord(exist);
      }
      throw err;
    }
  }

  getRecord(id) {
    return rowToRecord(this.db.prepare('SELECT * FROM records WHERE id = ?').get(Number(id)));
  }

  listRecords(query = {}) {
    const where = [];
    const args = [];
    if (query.bookId != null) { where.push('book_id = ?'); args.push(Number(query.bookId)); }
    if (!query.includeDeleted) where.push('deleted_at IS NULL');
    if (query.from) { where.push('occurred_date >= ?'); args.push(query.from); }
    if (query.to) { where.push('occurred_date <= ?'); args.push(query.to); }
    if (query.since) { where.push('updated_at > ?'); args.push(query.since); }
    if (query.payerAccountId != null) {
      where.push('(payer_account_id = ? OR participants_json LIKE ?)');
      args.push(Number(query.payerAccountId), `%"accountId":${Number(query.payerAccountId)}%`);
    }
    if (query.authorAccountId != null) { where.push('author_account_id = ?'); args.push(Number(query.authorAccountId)); }
    if (query.category) { where.push('category = ?'); args.push(query.category); }
    if (query.type) { where.push('type = ?'); args.push(query.type); }
    if (query.q) {
      where.push('(note LIKE ? OR merchant LIKE ? OR raw_text LIKE ? OR category LIKE ?)');
      const like = `%${query.q}%`;
      args.push(like, like, like, like);
    }
    const order = query.since
      ? 'ORDER BY updated_at ASC, id ASC'
      : (query.recentFirst === false ? 'ORDER BY occurred_at ASC, id ASC' : 'ORDER BY occurred_at DESC, id DESC');
    const limit = Math.min(Number(query.limit) || 5000, 20000);
    const offset = Number(query.offset) || 0;
    const sql = `SELECT * FROM records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${order} LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...args, limit, offset).map(rowToRecord);
  }

  countRecords(bookId) {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM records WHERE book_id = ? AND deleted_at IS NULL')
      .get(Number(bookId)).c);
  }

  recentRecords(bookId, limit = 5) {
    const nameOf = this.nameResolver(bookId);
    return this.listRecords({ bookId, limit }).map((r) => ({
      date: r.occurredDate,
      category: r.category,
      subcategory: r.subcategory,
      amountCents: r.amountCents,
      note: r.note,
      userName: nameOf(r.payerAccountId),
    }));
  }

  nameResolver(bookId) {
    const map = new Map(this.listMembers(bookId).map((m) => [Number(m.accountId), m.displayName]));
    return (id) => map.get(Number(id)) || '某人';
  }

  updateRecord(id, patch = {}, expectVersion = null, actorId = null) {
    const cur = this.getRecord(id);
    if (!cur) throw new HttpError(404, '记录不存在');
    if (actorId != null) this.assertCanEdit(cur, actorId, '修改');
    if (expectVersion != null && Number(expectVersion) !== Number(cur.version)) {
      throw new HttpError(409, '这条记录已被其他人修改，请刷新后再改');
    }
    const amountCents = patch.amountCents != null ? Math.round(Number(patch.amountCents)) : cur.amountCents;
    if (!Number.isFinite(amountCents) || amountCents <= 0) throw new HttpError(400, '金额必须大于 0');
    const occurredDate = patch.occurredDate || cur.occurredDate;
    const occurredTime = patch.occurredTime !== undefined ? patch.occurredTime : cur.occurredTime;
    this.db.prepare(
      `UPDATE records SET payer_account_id = ?, type = ?, amount_cents = ?, category = ?, subcategory = ?,
        merchant = ?, note = ?, occurred_at = ?, occurred_date = ?, occurred_time = ?,
        participants_json = ?, status = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(
      patch.payerAccountId !== undefined ? patch.payerAccountId : cur.payerAccountId,
      patch.type || cur.type,
      amountCents,
      patch.category || cur.category,
      patch.subcategory !== undefined ? patch.subcategory : cur.subcategory,
      patch.merchant !== undefined ? patch.merchant : cur.merchant,
      patch.note !== undefined ? patch.note : cur.note,
      `${occurredDate} ${occurredTime || '12:00'}`,
      occurredDate,
      occurredTime || null,
      JSON.stringify(patch.participants !== undefined ? patch.participants : cur.participants),
      patch.status || cur.status,
      nowIso(),
      Number(id),
    );
    return this.getRecord(id);
  }

  /** 权限判定：作者本人，或账本管理员/创建者 */
  assertCanEdit(record, actorId, action = '操作') {
    const membership = this.assertMember(record.bookId, actorId);
    const isAuthor = Number(record.authorAccountId) === Number(actorId);
    const isPayer = Number(record.payerAccountId) === Number(actorId);
    // 作者、账本管理员、以及这笔钱记在他名下的人（被 @ 的人）都可以改
    if (isAuthor || isPayer || MANAGER_ROLES.includes(membership.role)) {
      return { isAuthor, isPayer, role: membership.role };
    }
    throw new HttpError(403, `只能${action}自己发送的记录；需要${action}别人的记录请联系账本管理员`, 'NOT_AUTHOR');
  }

  canEditRecord(record, accountId) {
    if (!record || !accountId) return false;
    const m = this.getMembership(record.bookId, accountId);
    if (!m) return false;
    return Number(record.authorAccountId) === Number(accountId)
      || Number(record.payerAccountId) === Number(accountId)
      || MANAGER_ROLES.includes(m.role);
  }

  softDeleteRecord(id, actorId = null) {
    const cur = this.getRecord(id);
    if (!cur) throw new HttpError(404, '记录不存在');
    if (actorId != null) this.assertCanEdit(cur, actorId, '删除');
    const ts = nowIso();
    this.db.prepare('UPDATE records SET deleted_at = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(ts, 'deleted', ts, Number(id));
    return this.getRecord(id);
  }

  restoreRecord(id, actorId = null) {
    const cur = this.getRecord(id);
    if (!cur) throw new HttpError(404, '记录不存在');
    if (actorId != null) this.assertCanEdit(cur, actorId, '恢复');
    this.db.prepare('UPDATE records SET deleted_at = NULL, status = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run('confirmed', nowIso(), Number(id));
    return this.getRecord(id);
  }

  /** 本账本记录里出现过的所有账号（含已被移出的成员），用于聊天卡片显示作者 */
  listRecordAuthors(bookId) {
    return this.db.prepare(
      `SELECT DISTINCT a.id AS account_id, a.display_name, a.emoji
       FROM accounts a
       WHERE a.id IN (
         SELECT author_account_id FROM records WHERE book_id = ? AND author_account_id IS NOT NULL
         UNION
         SELECT payer_account_id FROM records WHERE book_id = ? AND payer_account_id IS NOT NULL
       )`,
    ).all(Number(bookId), Number(bookId)).map((r) => ({
      accountId: Number(r.account_id),
      displayName: r.display_name,
      emoji: r.emoji || '🙂',
    }));
  }

  /* ============================ 消息 ============================ */

  insertMessage(msg) {
    const ts = msg.createdAt || nowIso();
    const info = this.db.prepare(
      `INSERT INTO messages (book_id, author_account_id, role, kind, content, payload_json, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      msg.bookId ?? null, msg.authorAccountId ?? null, msg.role || 'user', msg.kind || 'text',
      msg.content || '', msg.payload ? JSON.stringify(msg.payload) : null, ts,
    );
    const id = Number(info.lastInsertRowid);
    const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
    if (mentions.length && msg.bookId) {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO message_mentions (message_id, book_id, account_id, created_at) VALUES (?,?,?,?)',
      );
      for (const acc of new Set(mentions.map(Number))) {
        if (!Number.isFinite(acc)) continue;
        stmt.run(id, Number(msg.bookId), acc, ts);
      }
    }
    return rowToMessage(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  }

  /** 记录某人已经读到哪个账本的哪里（用于「有人@我」提示） */
  touchRead(bookId, accountId) {
    this.assertMember(bookId, accountId);
    const ts = nowIso();
    this.db.prepare(
      `INSERT INTO book_reads (book_id, account_id, last_read_at) VALUES (?,?,?)
       ON CONFLICT(book_id, account_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
    ).run(Number(bookId), Number(accountId), ts);
    return { lastReadAt: ts };
  }

  listMessages({ bookId, before, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (bookId != null) { where.push('book_id = ?'); args.push(Number(bookId)); }
    if (before != null) { where.push('id < ?'); args.push(Number(before)); }
    const rows = this.db.prepare(
      `SELECT * FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
    ).all(...args, Math.min(Number(limit) || 200, 500));
    return rows.reverse().map(rowToMessage);
  }

  /**
   * 全局搜索：我参与的账本（按名字）+ 这些账本的记录（备注/商户/类别/原文/金额）。
   */
  search(accountId, rawQuery, limit = 40) {
    const q = String(rawQuery || '').trim();
    if (!q) return { books: [], records: [] };
    const like = `%${q}%`;
    const books = this.listBooksForAccount(accountId)
      .filter((b) => b.name.includes(q));
    const amountCents = /^\d+(\.\d{1,2})?$/.test(q) ? Math.round(Number(q) * 100) : null;

    const rows = this.db.prepare(
      `SELECT r.*, b.name AS book_name, b.emoji AS book_emoji
       FROM records r
       JOIN books b ON b.id = r.book_id
       JOIN book_members m ON m.book_id = r.book_id AND m.account_id = ?
       WHERE r.deleted_at IS NULL
         AND (r.note LIKE ? OR r.merchant LIKE ? OR r.category LIKE ? OR r.raw_text LIKE ?
              ${amountCents != null ? 'OR r.amount_cents = ?' : ''})
       ORDER BY r.occurred_at DESC
       LIMIT ?`,
    ).all(...[Number(accountId), like, like, like, like,
      ...(amountCents != null ? [amountCents] : []), Math.min(Number(limit) || 40, 100)]);

    return {
      books,
      records: rows.map((r) => ({
        ...rowToRecord(r),
        bookName: r.book_name,
        bookEmoji: r.book_emoji || '📒',
      })),
    };
  }

  /* ============================ 审计 / 统计 ============================ */

  audit({ kind, provider, model, accountId, inputText, outputText, latencyMs, ok, error }) {
    try {
      this.db.prepare(
        `INSERT INTO ai_audit (kind, provider, model, account_id, input_text, output_text, latency_ms, ok, error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(kind || 'parse', provider || '', model || '', accountId ?? null, String(inputText || '').slice(0, 2000),
        String(outputText || '').slice(0, 8000), latencyMs ?? null, ok ? 1 : 0,
        error ? String(error).slice(0, 500) : null, nowIso());
    } catch {
      /* 审计失败不影响主流程 */
    }
  }

  /** 账号配额状态（前端展示「还能建几个账本」） */
  accountStats(accountId) {
    const created = this.countBooksCreatedBy(accountId);
    const joined = Number(this.db.prepare('SELECT COUNT(*) AS c FROM book_members WHERE account_id = ?')
      .get(Number(accountId)).c);
    const { maxBooksPerAccount } = this.quotas;
    return {
      booksCreated: created,
      booksJoined: joined,
      maxBooksPerAccount,
      canCreateBook: created < maxBooksPerAccount,
    };
  }

  canManage(bookId, accountId) {
    const m = this.getMembership(bookId, accountId);
    return !!m && MANAGER_ROLES.includes(m.role);
  }
}

export { rowToAccount, rowToRecord, rowToMessage, rowToMember, rowToBook };
