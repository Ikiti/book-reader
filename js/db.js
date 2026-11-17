// Minimal promise wrapper over IndexedDB. Everything the app stores lives here.
//
// Stores:
//   books    {id, title, author, pageCount, size, addedAt, openedAt, cover: Blob, progress, needsOcr, v}
//   files    {id, blob}                     original PDF (kept for the "Original" view and re-processing)
//   content  {id, model}                    extracted reflow model (see pdf/extract.js)
//   images   {key: `${bookId}/${n}`, blob}  cropped pictures / table snapshots
//   notes    {id, bookId, createdAt, quote, comment, chapter, page, block}
//   kv       {key, value}                   settings

const DB_NAME = 'book-reader';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('books', { keyPath: 'id' });
      db.createObjectStore('files', { keyPath: 'id' });
      db.createObjectStore('content', { keyPath: 'id' });
      db.createObjectStore('images', { keyPath: 'key' });
      const notes = db.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('bookId', 'bookId');
      db.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(stores, mode, fn) {
  const db = await open();
  const t = db.transaction(stores, mode);
  const finished = new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  const result = await fn(...[].concat(stores).map((s) => t.objectStore(s)));
  await finished;
  return result;
}

export const get = (store, key) => tx(store, 'readonly', (s) => done(s.get(key)));
export const put = (store, value) => tx(store, 'readwrite', (s) => done(s.put(value)));
export const del = (store, key) => tx(store, 'readwrite', (s) => done(s.delete(key)));
export const all = (store) => tx(store, 'readonly', (s) => done(s.getAll()));

export const notesFor = (bookId) => tx('notes', 'readonly', (s) => done(s.index('bookId').getAll(bookId)));

export async function getSetting(key, fallback) {
  const row = await get('kv', key);
  return row ? row.value : fallback;
}
export const setSetting = (key, value) => put('kv', { key, value });

/** Save a newly imported book in one transaction. */
export function saveBook(book, fileBlob, model, images) {
  return tx(['books', 'files', 'content', 'images'], 'readwrite', (b, f, c, im) => {
    b.put(book);
    f.put({ id: book.id, blob: fileBlob });
    c.put({ id: book.id, model });
    images.forEach((blob, n) => im.put({ key: `${book.id}/${n}`, blob }));
  });
}

/** Replace the extracted content of an existing book (re-process). */
export function replaceContent(bookId, model, images, patch) {
  return tx(['books', 'content', 'images'], 'readwrite', async (b, c, im) => {
    const range = IDBKeyRange.bound(`${bookId}/`, `${bookId}/￿`);
    im.delete(range);
    c.put({ id: bookId, model });
    images.forEach((blob, n) => im.put({ key: `${bookId}/${n}`, blob }));
    const book = await done(b.get(bookId));
    if (book) b.put({ ...book, ...patch });
  });
}

export function deleteBook(id) {
  return tx(['books', 'files', 'content', 'images', 'notes'], 'readwrite', async (b, f, c, im, n) => {
    b.delete(id);
    f.delete(id);
    c.delete(id);
    im.delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`));
    const keys = await done(n.index('bookId').getAllKeys(id));
    keys.forEach((k) => n.delete(k));
  });
}

/** Ask the browser not to evict our data under storage pressure (important on Android). */
export async function persist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* not supported */ }
}
