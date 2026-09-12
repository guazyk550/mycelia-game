/**
 * 存档后端：IndexedDB 优先 + localStorage 兜底。
 *
 * 为什么需要它：游戏要跑在 Android WebView 里，而 WebView 的 localStorage
 * 在系统清理存储、或应用被"强行停止"时可能被抹掉 —— 对增量游戏来说等于毁档。
 * IndexedDB 同样会被清，但它更耐受"只清 localStorage"这类常规清理，
 * 而且写入是异步的，不会卡住主线程。
 *
 * 策略是**双写**：每次保存同时写两处；加载时优先读 IndexedDB，失败回落 localStorage。
 * 这样桌面浏览器（可能禁用 IDB）与 WebView（IDB 更可靠）都能正常工作。
 */

const DB_NAME = 'mycelia';
const STORE = 'saves';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** 写一份到 IndexedDB（失败静默：localStorage 仍然是可靠的兜底） */
export async function idbSet(key: string, value: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** 从 IndexedDB 读（读不到返回 null） */
export async function idbGet(key: string): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * 合并读取：优先 IndexedDB，拿不到再退回 localStorage。
 * 返回时会把拿到的那一份**补写回另一处**，让两份尽快一致。
 */
export async function readSave(key: string): Promise<string | null> {
  const fromIdb = await idbGet(key);
  if (fromIdb) {
    try {
      if (localStorage.getItem(key) !== fromIdb) localStorage.setItem(key, fromIdb);
    } catch {
      /* 忽略配额错误 */
    }
    return fromIdb;
  }
  try {
    const fromLs = localStorage.getItem(key);
    if (fromLs) void idbSet(key, fromLs);
    return fromLs;
  } catch {
    return null;
  }
}

/** 双写：两份都写，任何一份成功都算保存成功 */
export async function writeSave(key: string, value: string): Promise<void> {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 配额或隐私模式 */
  }
  void idbSet(key, value);
}

export async function deleteSave(key: string): Promise<void> {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
  await idbDelete(key);
}
