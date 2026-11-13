/**
 * 极简内存版 IndexedDB 替身，用于测试 js/core/store.js
 * 只实现本项目用到的 API。
 */
export function installFakeIndexedDB() {
  const dbs = new Map();

  class FakeRequest {
    constructor() {
      this.result = undefined;
      this.error = null;
      this.onsuccess = null;
      this.onerror = null;
    }
    succeed(result) {
      this.result = result;
      if (this.onsuccess) this.onsuccess();
    }
  }

  class FakeStore {
    constructor(tx, data, keyPath) {
      this.tx = tx;
      this.data = data;
      this.keyPath = keyPath;
    }
    createIndex() {
      return {};
    }
    _request(apply) {
      const req = new FakeRequest();
      this.tx.pending++;
      setTimeout(() => {
        try {
          req.result = apply();
          if (req.onsuccess) req.onsuccess();
        } catch (err) {
          req.error = err;
          if (req.onerror) req.onerror();
        } finally {
          this.tx.pending--;
        }
      }, 0);
      return req;
    }
    put(value) {
      const key = this.keyPath ? value[this.keyPath] : value.id;
      return this._request(() => {
        this.data.set(key, value);
        return key;
      });
    }
    get(key) {
      return this._request(() => this.data.get(key));
    }
    getAll() {
      return this._request(() => Array.from(this.data.values()));
    }
    delete(key) {
      return this._request(() => {
        this.data.delete(key);
      });
    }
    clear() {
      return this._request(() => this.data.clear());
    }
    count() {
      return this._request(() => this.data.size);
    }
  }

  class FakeTransaction {
    constructor(db, storeName) {
      this.db = db;
      this.storeName = storeName;
      this.pending = 0;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      setTimeout(() => {
        if (this.pending === 0 && this.oncomplete) this.oncomplete();
      }, 4);
    }
    objectStore() {
      const meta = this.db.stores.get(this.storeName);
      return new FakeStore(this, meta.data, meta.keyPath);
    }
  }

  class FakeDB {
    constructor(name) {
      this.name = name;
      this.stores = new Map();
      this.objectStoreNames = {
        contains: (n) => this.stores.has(n)
      };
    }
    createObjectStore(name, options) {
      this.stores.set(name, { data: new Map(), keyPath: options && options.keyPath });
      return {
        createIndex() {
          return {};
        }
      };
    }
    transaction(storeName) {
      return new FakeTransaction(this, storeName);
    }
  }

  const fake = {
    open(name) {
      const req = new FakeRequest();
      let db = dbs.get(name);
      const isNew = !db;
      if (!db) {
        db = new FakeDB(name);
        dbs.set(name, db);
      }
      setTimeout(() => {
        req.result = db;
        if (isNew && req.onupgradeneeded) req.onupgradeneeded();
        req.succeed(db);
      }, 0);
      return req;
    }
  };

  globalThis.indexedDB = fake;
  return { dbs, reset: () => dbs.clear() };
}