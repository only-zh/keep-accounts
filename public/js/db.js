/**
 * 极简 IndexedDB 封装（无依赖）。
 * 本地模式是唯一数据源；服务器模式下作为离线缓存。
 *
 * 关键健壮性：如果运行环境拿不到 IndexedDB（隐私模式、WebView 关闭了存储、
 * 初始化卡住等），自动降级为内存存储——数据在本次会话内可用，刷新后丢失，
 * 但绝不会让 App 卡在「正在加载…」。
 */

const DB_NAME = 'keep-accounts';
const DB_VERSION = 1;
const OPEN_TIMEOUT_MS = 4000;

export const STORES = ['users', 'books', 'members', 'records', 'messages', 'settings', 'queue'];

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 操作失败'));
  });
}

function clone(value) {
  try {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

export class LocalDb {
  constructor() {
    this.db = null;
    this.memory = null;
    this.degraded = false;
    this.degradedReason = '';
  }

  async open() {
    if (this.db) return this.db;
    if (this.degraded) return null;
    if (typeof indexedDB === 'undefined') {
      this.degrade('当前环境不支持 IndexedDB');
      return null;
    }
    const opening = new Promise((resolve, reject) => {
      let settled = false;
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      open.onsuccess = () => { if (!settled) { settled = true; resolve(open.result); } };
      open.onerror = () => { if (!settled) { settled = true; reject(open.error || new Error('IndexedDB 打开失败')); } };
      open.onblocked = () => { if (!settled) { settled = true; reject(new Error('IndexedDB 被其它标签页占用')); } };
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('本地存储初始化超时')), OPEN_TIMEOUT_MS));
    try {
      this.db = await Promise.race([opening, timeout]);
    } catch (err) {
      this.degrade(err.message);
      return null;
    }
    return this.db;
  }

  /** 降级为内存存储 */
  degrade(reason) {
    this.degraded = true;
    this.degradedReason = String(reason || '未知原因');
    this.memory = new Map();
    for (const s of STORES) this.memory.set(s, new Map());
    console.warn(`[keep-accounts] 本地存储不可用（${this.degradedReason}），已改用内存存储，数据在刷新后会丢失。`);
  }

  async tx(storeNames, mode, fn) {
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('事务被中断'));
      try {
        result = fn(tx);
      } catch (err) {
        try { tx.abort(); } catch { /* ignore */ }
        reject(err);
      }
    });
  }

  /* ------------------------- 读写 ------------------------- */

  async put(store, value) {
    if (this.degraded) { this.memory.get(store).set(value.id, clone(value)); return value; }
    return this.tx([store], 'readwrite', (tx) => tx.objectStore(store).put(clone(value)));
  }

  async putAll(store, values) {
    if (this.degraded) {
      for (const v of values || []) this.memory.get(store).set(v.id, clone(v));
      return;
    }
    return this.tx([store], 'readwrite', (tx) => {
      const os = tx.objectStore(store);
      for (const v of values || []) os.put(clone(v));
    });
  }

  async get(store, key) {
    if (this.degraded) return this.memory.get(store).get(key) || null;
    return this.tx([store], 'readonly', (tx) => req(tx.objectStore(store).get(key)));
  }

  async all(store) {
    if (this.degraded) return [...this.memory.get(store).values()];
    return this.tx([store], 'readonly', (tx) => req(tx.objectStore(store).getAll()));
  }

  async remove(store, key) {
    if (this.degraded) { this.memory.get(store).delete(key); return; }
    return this.tx([store], 'readwrite', (tx) => tx.objectStore(store).delete(key));
  }

  async clear(store) {
    if (this.degraded) { this.memory.get(store).clear(); return; }
    return this.tx([store], 'readwrite', (tx) => tx.objectStore(store).clear());
  }

  /** 批量替换（先清空再写入），用于服务器同步 */
  async replaceAll(store, values) {
    if (this.degraded) {
      const m = this.memory.get(store);
      m.clear();
      for (const v of values || []) m.set(v.id, clone(v));
      return;
    }
    return this.tx([store], 'readwrite', (tx) => {
      const os = tx.objectStore(store);
      os.clear();
      for (const v of values || []) os.put(clone(v));
    });
  }
}

/** localStorage 包装（配置项，不需要异步） */
export const prefs = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`ka.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`ka.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
  remove(key) {
    try { localStorage.removeItem(`ka.${key}`); } catch { /* ignore */ }
  },
};
