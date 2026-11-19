// Library view: the list of books with cover, progress and last-read position.
import { all, deleteBook, get, put } from './db.js';
import { emptyReading } from './progress.js';
import { bookNotesMarkdown, listNotes } from './notes/notes.js';
import { settings, updateSettings } from './settings.js';
import { $, download, fmtDate, h, sheet, toast } from './ui.js';

let urls = [];

export async function renderLibrary(root, { onImport, onOpen, onReprocess, onEpub }) {
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  const books = (await all('books')).sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
  const noteCount = new Map();
  for (const n of await all('notes')) noteCount.set(n.bookId, (noteCount.get(n.bookId) || 0) + 1);
  const input = h('input#pick-import', { type: 'file', accept: 'application/pdf,.pdf,application/epub+zip,.epub', multiple: true, hidden: true, onchange: (e) => { onImport([...e.target.files]); e.target.value = ''; } });
  // One step: pick PDF(s) -> converted -> EPUB offered for download.
  const convertInput = h('input#pick-convert', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, hidden: true, onchange: (e) => { onImport([...e.target.files], { epub: true }); e.target.value = ''; } });

  const grid = h('div.grid', books.map((b) => card(b)));
  const empty = h('div.empty',
    h('div.empty-art', '📖'),
    h('p', 'Your library is empty.'),
    h('p.muted', 'Convert a PDF book or article to EPUB for any e-book app, or read PDF and EPUB books here. Everything happens on this device and works offline.'),
    h('div.actions.center',
      h('button.primary', { onclick: () => convertInput.click() }, 'Convert PDF → EPUB'),
      h('button', { onclick: () => input.click() }, 'Add PDF or EPUB')));

  root.replaceChildren(
    h('header.bar.lib-bar',
      h('h1', 'Library'),
      h('div.spacer'),
      h('button.primary#convert', { onclick: () => convertInput.click(), title: 'Convert PDF files to EPUB' }, 'PDF → EPUB'),
      h('button#import', { onclick: () => input.click(), title: 'Add a PDF or EPUB to the library (or drop files here)', 'aria-label': 'Add book' }, '＋ Add'),
      h('button.icon#lib-settings', { onclick: libSettings, title: 'Import settings', 'aria-label': 'Import settings' }, '⚙'),
      input, convertInput),
    h('main.library', books.length ? grid : empty, h('p.muted.storage#storage')),
  );
  storageInfo();

  function card(b) {
    const cover = b.cover ? URL.createObjectURL(b.cover) : '';
    if (cover) urls.push(cover);
    const p = b.progress;
    const r = b.reading;
    // Share actually read (books saved before reading was tracked: the position).
    const pct = Math.round((r ? r.pct || 0 : p?.pct || 0) * 100);
    const isEpub = b.format === 'epub';
    const size = isEpub ? 'EPUB' : `${b.pageCount} page${b.pageCount === 1 ? '' : 's'}`;
    const where = r?.finishedAt ? `Finished ${fmtDate(r.finishedAt)}${r.bookmarks?.length ? ` · ${r.bookmarks.length} bookmark${r.bookmarks.length > 1 ? 's' : ''}` : ''}`
      : p ? [`${pct}% read`, p.chapter, p.page ? `p. ${p.page}` : null].filter(Boolean).join(' · ') : `${size} · not started`;
    return h('article.card', { dataset: { id: b.id } },
      h('button.cover', { onclick: () => onOpen(b.id), 'aria-label': `Open ${b.title}` },
        cover ? h('img', { src: cover, alt: '', loading: 'lazy' }) : h('div.nocover', b.title.slice(0, 1)),
        b.needsOcr ? h('span.badge', { title: 'Some pages are scans without text' }, 'scan') : null,
        isEpub ? h('span.badge.fmt', { title: 'EPUB book' }, 'EPUB') : null),
      h('div.meta',
        h('button.title', { onclick: () => onOpen(b.id) }, b.title),
        b.author ? h('div.author.muted', b.author) : null,
        h('div.progress', { title: `${pct}% read` }, h('span', { style: { width: `${pct}%` } })),
        h('div.where.muted', where),
        h('div.when.muted', [b.openedAt ? `Opened ${fmtDate(b.openedAt)}` : `Added ${fmtDate(b.addedAt)}`,
          noteCount.get(b.id) ? `🗒 ${noteCount.get(b.id)} note${noteCount.get(b.id) > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')),
        h('div.card-actions',
          isEpub ? null : h('button.small.epub-btn', { onclick: () => onEpub(b.id), title: 'Export as EPUB for other e-book apps' }, '⤓ EPUB'),
          h('button.small', { onclick: () => onOpen(b.id) }, p ? 'Continue' : 'Read'))),
      h('button.icon.more', { 'aria-label': 'Book actions', title: 'Actions', onclick: () => actions(b) }, '⋮'));
  }

  function actions(b) {
    const s = sheet(b.title, h('div.menu',
      h('button', { onclick: () => { s.close(); onOpen(b.id); } }, 'Open'),
      b.format === 'epub' ? null : h('button', { onclick: () => { s.close(); onEpub(b.id); } }, 'Export EPUB'),
      h('button', { onclick: async () => {
        const name = prompt('Book title', b.title);
        if (name && name.trim()) { await put('books', { ...(await get('books', b.id)), title: name.trim() }); s.close(); renderLibrary(root, { onImport, onOpen, onReprocess, onEpub }); }
      } }, 'Rename'),
      h('button', { onclick: async () => {
        const notes = await listNotes(b.id);
        if (!notes.length) { toast('No notes in this book yet'); return; }
        download(`${b.title} - notes.md`, new Blob([bookNotesMarkdown(notes, b)], { type: 'text/markdown' }));
      } }, 'Export notes (Markdown)'),
      h('button', { onclick: async () => {
        const f = await get('files', b.id);
        if (f) download(`${b.title}.${b.format === 'epub' ? 'epub' : 'pdf'}`, f.blob);
      } }, b.format === 'epub' ? 'Download the EPUB file' : 'Download original PDF'),
      b.progress || b.reading ? h('button', { onclick: async () => {
        if (!confirm(`Start “${b.title}” over?\n\nWhat you've read is cleared. Notes and bookmarks are kept.`)) return;
        const cur = await get('books', b.id);
        await put('books', { ...cur, progress: null, reading: { ...emptyReading(), bookmarks: cur.reading?.bookmarks || [], speed: cur.reading?.speed || emptyReading().speed, ms: cur.reading?.ms || 0 } });
        s.close();
        renderLibrary(root, { onImport, onOpen, onReprocess, onEpub });
      } }, 'Start over (clear reading progress)') : null,
      b.reading?.finishedAt ? null : h('button', { onclick: async () => {
        const cur = await get('books', b.id);
        const n = (await get('content', b.id))?.model.blocks.length || 0;
        await put('books', { ...cur, reading: { ...emptyReading(), ...(cur.reading || {}), read: [[0, n]], pct: 1, finishedAt: Date.now() } });
        s.close();
        renderLibrary(root, { onImport, onOpen, onReprocess, onEpub });
      } }, 'Mark as finished'),
      h('button', { onclick: () => { s.close(); onReprocess(b.id); } }, 'Re-process (after an app update)'),
      h('button.danger', { onclick: async () => {
        if (!confirm(`Delete “${b.title}” and its notes from this device?`)) return;
        await deleteBook(b.id);
        s.close();
        toast('Book deleted');
        renderLibrary(root, { onImport, onOpen, onReprocess, onEpub });
      } }, 'Delete'),
    ));
  }
}

const OCR_CHOICES = {
  auto: 'Automatic (English and/or Hebrew)',
  eng: 'English',
  heb: 'Hebrew',
  'eng+heb': 'English + Hebrew (mixed pages)',
  off: 'Off: keep picture pages as pictures',
};

function libSettings() {
  const st = settings();
  sheet('Import settings', h('div.settings',
    h('label.field', h('span', 'Scanned / picture-only PDF pages (OCR)'),
      h('select#ocr-lang', { onchange: (e) => updateSettings({ ocrLang: e.target.value }) },
        Object.entries(OCR_CHOICES).map(([v, label]) => h('option', { value: v, selected: st.ocrLang === v }, label)))),
    h('p.muted', 'Pages that are only a picture of text are read on this device (Tesseract OCR) and turned into real text, headings, code and tables. '
      + 'The first time, about 7 MB of recognition data is downloaded once and kept for offline use. Allow ~3–6 s per page; check the result, OCR can misread letters.'),
    h('p.muted', 'Applies to new imports. For a book already in the library: ⋮ → Re-process.')));
}

async function storageInfo() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    const el = $('#storage');
    if (el) el.textContent = `Stored on this device: ${mb(usage)} of ${mb(quota)}${persisted ? ' · protected from cleanup' : ''}`;
  } catch { /* unsupported */ }
}
