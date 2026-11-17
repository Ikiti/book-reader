// Library view: the list of books with cover, progress and last-read position.
import { all, deleteBook, get, put } from './db.js';
import { bookNotesMarkdown, listNotes } from './notes/notes.js';
import { $, download, fmtDate, h, sheet, toast } from './ui.js';

let urls = [];

export async function renderLibrary(root, { onImport, onOpen, onReprocess, onEpub }) {
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  const books = (await all('books')).sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
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
      input, convertInput),
    h('main.library', books.length ? grid : empty, h('p.muted.storage#storage')),
  );
  storageInfo();

  function card(b) {
    const cover = b.cover ? URL.createObjectURL(b.cover) : '';
    if (cover) urls.push(cover);
    const p = b.progress;
    const pct = Math.round((p?.pct || 0) * 100);
    const isEpub = b.format === 'epub';
    const size = isEpub ? 'EPUB' : `${b.pageCount} page${b.pageCount === 1 ? '' : 's'}`;
    const where = p ? [p.chapter, p.page ? `p. ${p.page}` : null, `${pct}%`].filter(Boolean).join(' · ') : `${size} · not started`;
    return h('article.card', { dataset: { id: b.id } },
      h('button.cover', { onclick: () => onOpen(b.id), 'aria-label': `Open ${b.title}` },
        cover ? h('img', { src: cover, alt: '', loading: 'lazy' }) : h('div.nocover', b.title.slice(0, 1)),
        b.needsOcr ? h('span.badge', { title: 'Some pages are scans without text' }, 'scan') : null,
        isEpub ? h('span.badge.fmt', { title: 'EPUB book' }, 'EPUB') : null),
      h('div.meta',
        h('button.title', { onclick: () => onOpen(b.id) }, b.title),
        b.author ? h('div.author.muted', b.author) : null,
        h('div.progress', { title: `${pct}%` }, h('span', { style: { width: `${pct}%` } })),
        h('div.where.muted', where),
        h('div.when.muted', b.openedAt ? `Opened ${fmtDate(b.openedAt)}` : `Added ${fmtDate(b.addedAt)}`),
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

async function storageInfo() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    const el = $('#storage');
    if (el) el.textContent = `Stored on this device: ${mb(usage)} of ${mb(quota)}${persisted ? ' · protected from cleanup' : ''}`;
  } catch { /* unsupported */ }
}
