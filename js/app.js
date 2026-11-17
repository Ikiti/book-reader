// App shell: routing (#/ and #/book/<id>), importing PDFs, OS integrations, service worker.
import { get, persist, replaceContent, saveBook } from './db.js';
import { renderLibrary } from './library.js';
import { openReader } from './reader.js';
import { loadSettings, settings } from './settings.js';
import { cleanTitle } from './pdf/title.js';
import { $, h, toast } from './ui.js';

const root = $('#app');
let closeView = null;

async function route() {
  closeView?.();
  closeView = null;
  scrollTo(0, 0);
  const m = location.hash.match(/^#\/book\/([\w-]+)/);
  document.body.dataset.view = m ? 'reader' : 'library';
  if (m) {
    closeView = await openReader(root, m[1], { onBack: () => { location.hash = '#/'; } });
  } else {
    await renderLibrary(root, { onImport: importFiles, onOpen, onReprocess: reprocess, onEpub });
    if (location.hash.startsWith('#/inbox')) drainShareInbox();
  }
}

const onOpen = (id) => { location.hash = `#/book/${id}`; };
const onEpub = async (id, opts) => (await import('./epub/export.js')).exportEpub(id, opts);

// ---------- import ----------

async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function progressUi(name) {
  const bar = h('span');
  const label = h('div.muted', 'Reading file…');
  const el = h('div.backdrop.busy', h('div.sheet.progress-sheet', { role: 'dialog', 'aria-label': 'Importing' },
    h('h2', `Importing “${name}”`), label, h('div.progress.big', bar)));
  document.body.append(el);
  return {
    update(done, total, phase) {
      const pct = phase === 'images' ? 85 + (done / total) * 15 : phase === 'chapters' ? (done / total) * 100
        : phase === 'ocr' ? ((done - 0.5) / total) * 85 : (done / total) * 85;
      bar.style.width = `${pct.toFixed(1)}%`;
      label.textContent = phase === 'analyze' ? `Reading page ${done} of ${total}`
        : phase === 'ocr' ? `Page ${done} of ${total} is a picture: recognizing its text (OCR)…`
          : phase === 'chapters' ? `Reading part ${done} of ${total}` : `Saving pictures and tables (${done}/${total})`;
    },
    close() { el.remove(); },
  };
}

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
const isEpub = (f) => f.type === 'application/epub+zip' || /\.epub$/i.test(f.name || '');
const FORMATS = {
  pdf: { mime: 'application/pdf', load: async () => (await import('./pdf/pdfjs.js')).processPdf },
  epub: { mime: 'application/epub+zip', load: async () => (await import('./epub/load.js')).processEpub },
};

async function importFiles(files, { open = false, epub = false } = {}) {
  let lastId = null;
  const ids = [];
  const toConvert = [];
  for (const file of files) {
    const format = isPdf(file) ? 'pdf' : isEpub(file) ? 'epub' : null;
    if (!format) { toast(`${file.name}: only PDF and EPUB files can be opened`); continue; }
    const buf = await file.arrayBuffer();
    const id = await sha256(buf);
    const existing = await get('books', id);
    if (existing) {
      if (!epub) toast(`“${file.name}” is already in your library`);
      lastId = id;
      ids.push(id);
      if ((existing.format || 'pdf') === 'pdf') toConvert.push(id);
      continue;
    }
    const ui = progressUi(file.name);
    try {
      const process = await FORMATS[format].load();
      const res = await process(buf.slice(0), ui.update, { ocr: settings().ocrLang });
      const book = {
        id,
        format,
        title: format === 'epub' ? (res.title || cleanTitle('', file.name, res.model)) : cleanTitle(res.title, file.name, res.model),
        author: res.author,
        pageCount: res.model.pageCount,
        size: file.size,
        addedAt: Date.now(),
        openedAt: 0,
        cover: res.cover,
        progress: null,
        needsOcr: res.model.needsOcr,
        v: res.model.v,
      };
      await saveBook(book, new Blob([buf], { type: FORMATS[format].mime }), res.model, res.images);
      lastId = id;
      ids.push(id);
      if (format === 'pdf') toConvert.push(id);
      const extra = [
        res.model.ocrPages ? `${res.model.ocrPages} page${res.model.ocrPages === 1 ? '' : 's'} read with OCR` : '',
        book.needsOcr ? 'some pages kept as pictures (no text)' : '',
      ].filter(Boolean).join('; ');
      toast(`Added “${book.title}”${extra ? ` — ${extra}` : ''}`, 5000);
    } catch (err) {
      console.error(err);
      toast(`Could not import ${file.name}: ${err.message || err}`, 6000);
    } finally {
      ui.close();
    }
  }
  persist();
  if (epub && toConvert.length) {
    if (document.body.dataset.view === 'library') await route();
    // One file: show the Download/Share dialog. Several: download them one after another.
    if (toConvert.length === 1) await onEpub(toConvert[0]);
    else for (const id of toConvert) await onEpub(id, { direct: true });
    return;
  }
  if (epub && ids.length) toast('That file is already an EPUB: it was added to your library to read here.', 4000);
  if (open && lastId && files.length === 1) onOpen(lastId);
  else if (document.body.dataset.view === 'library') route();
}

async function reprocess(id) {
  const book = await get('books', id);
  const file = await get('files', id);
  if (!book || !file) return;
  const ui = progressUi(book.title);
  try {
    const process = await FORMATS[book.format || 'pdf'].load();
    const res = await process(await file.blob.arrayBuffer(), ui.update, { ocr: settings().ocrLang });
    await replaceContent(id, res.model, res.images, { v: res.model.v, needsOcr: res.model.needsOcr, progress: null });
    toast('Book re-processed');
  } catch (err) {
    toast(`Failed: ${err.message || err}`, 6000);
  } finally {
    ui.close();
    route();
  }
}

// ---------- OS integrations ----------

// Windows/desktop: "Open with Book Reader" for .pdf/.epub files (File Handling API, installed PWA).
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((fh) => fh.getFile()));
    importFiles(files, { open: true });
  });
}

// Android: PDFs shared to the app land in a cache (see sw.js share target).
let draining = false;
async function drainShareInbox() {
  if (draining || !('caches' in window)) return;
  draining = true;
  try {
    const cache = await caches.open('share-inbox');
    const keys = await cache.keys();
    if (!keys.length) return;
    const files = [];
    for (const req of keys) {
      const res = await cache.match(req);
      const name = decodeURIComponent(res.headers.get('x-name') || 'shared.pdf');
      files.push(new File([await res.blob()], name, { type: /\.epub$/i.test(name) ? 'application/epub+zip' : 'application/pdf' }));
    }
    history.replaceState(null, '', location.pathname + '#/');
    await importFiles(files, { open: true });
    // Remove only after a successful import, so a closed app doesn't lose the file.
    await Promise.all(keys.map((k) => cache.delete(k)));
  } finally {
    draining = false;
  }
}

// Drag & drop anywhere (desktop).
addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); document.body.classList.add('drop'); } });
addEventListener('dragleave', (e) => { if (e.target === document.documentElement || !e.relatedTarget) document.body.classList.remove('drop'); });
addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drop');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) importFiles(files);
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
}

// ---------- start ----------
addEventListener('hashchange', route);
await loadSettings();
await route();
window.bookReader = { importFiles }; // handy for tests / console
