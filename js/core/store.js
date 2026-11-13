/**
 * LIGHTNO · IndexedDB 测光记录仓库
 * 照片以 Blob 直接存储（不转 base64，节省空间）。
 */

const DB_NAME = 'lightno';
const DB_VERSION = 1;
const SHOT_STORE = 'shots';

let dbPromise = null;
const memoryFallback = [];
const IO_TIMEOUT = 3200;
const TX_TIMEOUT = 6000;

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function isSupported() {
  return typeof indexedDB !== 'undefined';
}

export function openDB() {
  if (!isSupported()) return Promise.reject(new Error('INDEXEDDB_UNSUPPORTED'));
  if (dbPromise) return dbPromise;

  dbPromise = withTimeout(
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SHOT_STORE)) {
          const store = db.createObjectStore(SHOT_STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }),
    IO_TIMEOUT,
    '本地数据库打开超时（可能处于隐私模式）'
  ).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDB();
  return withTimeout(
    new Promise((resolve, reject) => {
      let result;
      let failure = null;
      const tx = db.transaction(SHOT_STORE, mode);
      const store = tx.objectStore(SHOT_STORE);
      try {
        result = fn(store);
      } catch (err) {
        failure = err;
      }
      tx.oncomplete = () => (failure ? reject(failure) : resolve(result));
      tx.onerror = () => reject(tx.error || failure);
      tx.onabort = () => reject(tx.error || failure || new Error('TX_ABORTED'));
    }),
    TX_TIMEOUT,
    '本地数据库写入超时'
  );
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putShot(shot) {
  if (!isSupported()) {
    memoryFallback.push(shot);
    return shot;
  }
  await withStore('readwrite', (store) => {
    store.put(shot);
  });
  return shot;
}

export async function getShot(id) {
  if (!isSupported()) return memoryFallback.find((s) => s.id === id) || null;
  return withStore('readonly', (store) => requestToPromise(store.get(id)));
}

export async function listShots() {
  if (!isSupported()) return [...memoryFallback].sort((a, b) => b.createdAt - a.createdAt);
  const all = await withStore('readonly', (store) => requestToPromise(store.getAll()));
  return (all || []).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteShot(id) {
  if (!isSupported()) {
    const i = memoryFallback.findIndex((s) => s.id === id);
    if (i >= 0) memoryFallback.splice(i, 1);
    return;
  }
  await withStore('readwrite', (store) => {
    store.delete(id);
  });
}

export async function clearShots() {
  if (!isSupported()) {
    memoryFallback.length = 0;
    return;
  }
  await withStore('readwrite', (store) => {
    store.clear();
  });
}

export async function countShots() {
  if (!isSupported()) return memoryFallback.length;
  return withStore('readonly', (store) => requestToPromise(store.count()));
}

export async function storageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    } catch {
      /* ignore */
    }
  }
  return null;
}