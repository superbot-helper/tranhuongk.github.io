/**
 * HistoryStore — lưu lịch sử generate (kèm file mp3) vào IndexedDB.
 *
 * Dùng IndexedDB chứ không localStorage vì localStorage chỉ nhận string:
 * audio phải base64 (phình ~33%) và trần ~5MB là hết chỗ sau vài file.
 * IndexedDB chứa Blob trực tiếp, dung lượng theo quota của origin.
 */

const DB_NAME = '11labs';
const DB_VERSION = 1;
const STORE_NAME = 'history';
const MAX_ITEMS = 20;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Bọc một request IndexedDB thành Promise. */
function ask(store, method, ...args) {
  return new Promise((resolve, reject) => {
    const req = store[method](...args);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  const store = db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  return fn(store);
}

const HistoryStore = {
  MAX_ITEMS,

  /** Toàn bộ bản đã lưu, mới nhất trước. */
  async list() {
    const items = await withStore('readonly', (s) => ask(s, 'getAll'));
    return items.sort((a, b) => b.at - a.at);
  },

  /** @param {object} item phải có id, at và blob. */
  async put(item) {
    return withStore('readwrite', (s) => ask(s, 'put', item));
  },

  async remove(id) {
    return withStore('readwrite', (s) => ask(s, 'delete', id));
  },

  async clear() {
    return withStore('readwrite', (s) => ask(s, 'clear'));
  },

  /** Xoá bản cũ vượt quá `max`. Trả về danh sách id đã xoá. */
  async prune(max = MAX_ITEMS) {
    const items = await this.list();
    const stale = items.slice(max);
    await Promise.all(stale.map((it) => this.remove(it.id)));
    return stale.map((it) => it.id);
  },
};

window.HistoryStore = HistoryStore;
