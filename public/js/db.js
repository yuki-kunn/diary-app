/* IndexedDB ラッパー — entries(日記) / photos(写真Blob) */
const DiaryDB = (() => {
  const DB_NAME = 'hidamari-diary';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('entries')) {
          db.createObjectStore('entries', { keyPath: 'date' }); // date: 'YYYY-MM-DD'
        }
        if (!db.objectStoreNames.contains('photos')) {
          const store = db.createObjectStore('photos', { keyPath: 'id' });
          store.createIndex('by-date', 'date');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      const result = fn(store);
      t.oncomplete = () => resolve(result && result._value !== undefined ? result._value : result);
      t.onerror = () => reject(t.error);
    }));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    async getEntry(date) {
      const db = await open();
      return reqToPromise(db.transaction('entries').objectStore('entries').get(date));
    },
    async getAllEntries() {
      const db = await open();
      return reqToPromise(db.transaction('entries').objectStore('entries').getAll());
    },
    async putEntry(entry) {
      return tx('entries', 'readwrite', s => s.put(entry));
    },
    async deleteEntry(date) {
      return tx('entries', 'readwrite', s => s.delete(date));
    },
    async getPhoto(id) {
      const db = await open();
      return reqToPromise(db.transaction('photos').objectStore('photos').get(id));
    },
    async getPhotosByDate(date) {
      const db = await open();
      return reqToPromise(db.transaction('photos').objectStore('photos').index('by-date').getAll(date));
    },
    async getAllPhotos() {
      const db = await open();
      return reqToPromise(db.transaction('photos').objectStore('photos').getAll());
    },
    async putPhoto(photo) {
      return tx('photos', 'readwrite', s => s.put(photo));
    },
    async deletePhoto(id) {
      return tx('photos', 'readwrite', s => s.delete(id));
    },
  };
})();
