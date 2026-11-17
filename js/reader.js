// Reader view: reflowed text (font/size/theme adjustable) or the original PDF pages.
// Tracks position (block, page, chapter, %) and handles notes from selected text.
import { get, put } from './db.js';
import { deleteNote, listNotes, newNote, saveNote, bookNotesMarkdown } from './notes/notes.js';
import { PROVIDERS, copy, defaultProviderId, sendNote } from './notes/providers.js';
import { FONTS, THEMES, settings, updateSettings } from './settings.js';
import { $, download, fmtDate, h, sheet, toast } from './ui.js';

export async function openReader(root, bookId, { onBack }) {
  const book = await get('books', bookId);
  const content = await get('content', bookId);
  if (!book || !content) { toast('Book not found'); onBack(); return () => {}; }
  const model = content.model;
  const r = new Reader(root, book, model, onBack);
  await r.mount();
  return () => r.destroy();
}

class Reader {
  constructor(root, book, model, onBack) {
    Object.assign(this, { root, book, model, onBack });
    this.mode = 'flow';
    this.urls = [];
    this.notes = [];
    this.cleanup = [];
    this.pos = book.progress || null;
    // Reading progress by amount of text (independent of layout, fonts and lazy rendering).
    let acc = 0;
    this.cum = model.blocks.map((b) => {
      const start = acc;
      acc += b.runs ? b.runs.reduce((n, r) => n + r.s.length, 0) : b.t === 'table' ? 200 : 300;
      return start;
    });
    this.total = Math.max(1, acc);
  }

  pctAt(b, off = 0) {
    const next = b + 1 < this.cum.length ? this.cum[b + 1] : this.total;
    return Math.min(1, (this.cum[b] + off * (next - this.cum[b])) / this.total);
  }

  async mount() {
    const { book } = this;
    this.chapterEl = h('div.sub.muted');
    this.status = h('div.status');
    this.flow = h('main.flow', { tabIndex: -1 });
    this.pagesEl = h('main.pages', { hidden: true });
    this.selbar = h('div.selbar', { hidden: true },
      h('button', { onmousedown: (e) => e.preventDefault(), onclick: () => this.noteFromSelection() }, '📝 Note'),
      h('button', { onmousedown: (e) => e.preventDefault(), onclick: () => this.copySelection() }, 'Copy'),
      h('button', { onmousedown: (e) => e.preventDefault(), onclick: () => this.quickSend() }, 'Send'));
    this.modeBtn = h('button.icon', { title: 'Original pages / Reflow (O)', 'aria-label': 'Toggle original pages', onclick: () => this.toggleMode() }, '⧉');

    this.root.replaceChildren(
      h('header.bar.top',
        h('button.icon', { onclick: () => this.leave(), title: 'Library (Esc)', 'aria-label': 'Back to library' }, '←'),
        h('div.titles', h('div.ttl', book.title), this.chapterEl),
        h('button.icon', { onclick: () => this.showToc(), title: 'Contents (T)', 'aria-label': 'Contents' }, '☰'),
        h('button.icon', { onclick: () => this.showNotes(), title: 'Notes (N)', 'aria-label': 'Notes' }, '🗒'),
        h('button.icon', { onclick: () => this.showSettings(), title: 'Text settings (A)', 'aria-label': 'Text settings' }, 'Aa'),
        h('button.icon', { onclick: async () => (await import('./epub/export.js')).exportEpub(book.id), title: 'Export EPUB (E)', 'aria-label': 'Export EPUB' }, '⤓'),
        this.modeBtn),
      this.flow,
      this.pagesEl,
      h('footer.bar.bottom', this.status),
      this.selbar,
    );
    this.renderFlow();
    this.notes = await listNotes(book.id);
    this.paintHighlights();
    this.restore();

    const onScroll = throttle(() => this.track(), 250);
    const onSel = debounce(() => this.onSelection(), 180);
    const onKey = (e) => this.onKey(e);
    const onHide = () => { if (document.visibilityState === 'hidden') this.save(true); };
    let lastY = scrollY;
    const onImmersive = () => {
      const dy = scrollY - lastY;
      if (Math.abs(dy) > 12) { document.body.classList.toggle('immersive', dy > 0 && scrollY > 80); lastY = scrollY; }
    };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('scroll', onImmersive, { passive: true });
    document.addEventListener('selectionchange', onSel);
    addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHide);
    this.cleanup.push(() => {
      removeEventListener('scroll', onScroll);
      removeEventListener('scroll', onImmersive);
      document.removeEventListener('selectionchange', onSel);
      removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
      document.body.classList.remove('immersive');
    });
    // Tap on the text (without selecting) toggles the bars, like an e-reader.
    this.flow.addEventListener('click', (e) => {
      if (e.target.closest('a,button,mark,img,table') || String(getSelection())) return;
      document.body.classList.toggle('immersive');
    });
    await put('books', { ...book, openedAt: Date.now() });
  }

  destroy() {
    this.save(true);
    this.cleanup.forEach((f) => f());
    this.io?.disconnect();
    this.pageIo?.disconnect();
    this.pdf?.close();
    this.urls.forEach(URL.revokeObjectURL);
  }

  leave() { this.onBack(); }

  // ---------- reflow rendering ----------
  renderFlow() {
    const { model, book } = this;
    const frag = document.createDocumentFragment();
    let section = null;
    let curPg = -1;
    model.blocks.forEach((b, i) => {
      if (b.pg !== curPg) {
        curPg = b.pg;
        section = h('section.pg', { dataset: { pg: b.pg + 1 } });
        frag.append(section);
      }
      section.append(renderBlock(b, i));
    });
    if (!model.blocks.length) {
      frag.append(h('div.empty', h('p', 'No text was found in this PDF.'),
        h('p.muted', 'It is probably a scanned document. Use the ⧉ button to read the original pages. See README → OCR for how to add a text layer.')));
    }
    frag.append(h('div.end.muted', `End of “${book.title}”`));
    this.flow.replaceChildren(frag);

    // Load pictures lazily from IndexedDB.
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        this.io.unobserve(img);
        get('images', `${book.id}/${img.dataset.k}`).then((row) => {
          if (!row) return;
          const url = URL.createObjectURL(row.blob);
          this.urls.push(url);
          img.src = url;
        });
      }
    }, { rootMargin: '800px 0px' });
    this.flow.querySelectorAll('img[data-k]').forEach((img) => this.io.observe(img));
    this.flow.querySelectorAll('.tbl .snap-btn').forEach((btn) => btn.addEventListener('click', () => {
      const wrap = btn.closest('.tbl');
      wrap.classList.toggle('show-snap');
      btn.textContent = wrap.classList.contains('show-snap') ? 'Show as text' : 'Show original';
      const img = wrap.querySelector('img[data-k]');
      if (img && !img.src) this.io.observe(img);
    }));
  }

  // ---------- position tracking ----------
  topOffset() { return ($('.bar.top')?.getBoundingClientRect().bottom || 0) + 8; }

  currentBlock() {
    const y = Math.max(this.topOffset(), 60);
    const x = this.flow.getBoundingClientRect().left + this.flow.clientWidth / 2;
    let el = document.elementFromPoint(x, y)?.closest('[data-b]');
    if (!el) {
      // Between blocks: take the first block whose bottom is below the bar.
      el = [...this.flow.querySelectorAll('[data-b]')].find((n) => n.getBoundingClientRect().bottom > y);
    }
    return el;
  }

  chapterAt(b) {
    let ch = null;
    for (const t of this.model.toc) { if (t.b <= b) ch = t; else break; }
    return ch;
  }

  track() {
    if (this.mode === 'pages') return this.trackPages();
    const el = this.currentBlock();
    if (!el) return;
    const b = +el.dataset.b;
    const blk = this.model.blocks[b];
    const rect = el.getBoundingClientRect();
    const off = Math.min(1, Math.max(0, (this.topOffset() - rect.top) / Math.max(1, rect.height)));
    const atEnd = scrollY + innerHeight >= document.documentElement.scrollHeight - 4;
    const pct = atEnd ? 1 : this.pctAt(b, off);
    const ch = this.chapterAt(b);
    this.pos = { b, off, page: blk.pg + 1, pct, chapter: ch?.title || '' };
    this.showStatus();
    this.save();
  }

  showStatus() {
    const p = this.pos;
    if (!p) return;
    this.chapterEl.textContent = p.chapter || '';
    this.status.textContent = `Page ${p.page} of ${this.model.pageCount} · ${Math.round(p.pct * 100)}%`;
  }

  save(now = false) {
    clearTimeout(this.saveTimer);
    const write = async () => {
      if (!this.pos) return;
      const cur = await get('books', this.book.id);
      if (cur) await put('books', { ...cur, progress: this.pos, openedAt: Date.now() });
    };
    if (now) write(); else this.saveTimer = setTimeout(write, 800);
  }

  restore() {
    const p = this.pos;
    if (!p) { this.track(); return; }
    this.goToBlock(p.b, p.off || 0);
  }

  goToBlock(b, off = 0) {
    const el = this.flow.querySelector(`[data-b="${b}"]`);
    if (!el) return;
    const jump = () => {
      const rect = el.getBoundingClientRect();
      scrollTo({ top: scrollY + rect.top + off * rect.height - this.topOffset() + 1, behavior: 'instant' });
    };
    jump();
    // Lazy sections/images may change heights: settle once more.
    requestAnimationFrame(() => { jump(); setTimeout(() => { jump(); this.track(); }, 60); });
  }

  // ---------- original pages ----------
  async toggleMode() {
    const toPages = this.mode === 'flow';
    const page = this.pos?.page || 1;
    if (toPages) {
      await this.ensurePages();
      this.mode = 'pages';
      this.flow.hidden = true;
      this.pagesEl.hidden = false;
      this.modeBtn.textContent = '¶';
      this.modeBtn.title = 'Back to reflowed text (O)';
      document.body.classList.add('mode-pages');
      const el = this.pagesEl.querySelector(`[data-page="${page}"]`);
      el?.scrollIntoView({ behavior: 'instant' });
    } else {
      this.mode = 'flow';
      this.pagesEl.hidden = true;
      this.flow.hidden = false;
      this.modeBtn.textContent = '⧉';
      this.modeBtn.title = 'Original pages / Reflow (O)';
      document.body.classList.remove('mode-pages');
      const idx = this.model.blocks.findIndex((b) => b.pg + 1 >= page);
      if (idx >= 0) this.goToBlock(idx, 0);
    }
  }

  async ensurePages() {
    if (this.pdf) return;
    const { openPdf, renderPage } = await import('./pdf/pdfjs.js');
    const file = await get('files', this.book.id);
    this.pdf = await openPdf(new Uint8Array(await file.blob.arrayBuffer()));
    this.zoom = 1;
    const holders = this.model.pages.map((p, i) => h('div.page', {
      dataset: { page: i + 1 },
      style: { aspectRatio: `${p.w} / ${p.h}` },
    }, h('span.pno.muted', i + 1)));
    const zoomBar = h('div.zoom',
      h('button.icon', { onclick: () => this.setZoom(this.zoom - 0.25), 'aria-label': 'Zoom out' }, '−'),
      h('button.icon', { onclick: () => this.setZoom(1), 'aria-label': 'Fit width' }, 'Fit'),
      h('button.icon', { onclick: () => this.setZoom(this.zoom + 0.25), 'aria-label': 'Zoom in' }, '+'));
    this.pagesEl.replaceChildren(zoomBar, h('div.page-list', holders));
    const rendered = new Map();
    this.renderPageEl = async (el) => {
      const n = +el.dataset.page;
      const page = await this.pdf.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = (el.clientWidth * Math.min(devicePixelRatio || 1, 2.5)) / vp1.width;
      const canvas = el.querySelector('canvas') || h('canvas');
      await renderPage(page, scale, canvas);
      el.append(canvas);
      rendered.set(n, scale);
    };
    this.pageIo = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const el = e.target;
        const n = +el.dataset.page;
        if (e.isIntersecting && !rendered.has(n)) { rendered.set(n, 0); this.renderPageEl(el).catch(console.warn); }
        else if (!e.isIntersecting && rendered.has(n) && Math.abs(n - (this.pos?.page || 1)) > 4) {
          el.querySelector('canvas')?.remove();
          rendered.delete(n);
        }
      }
    }, { rootMargin: '1200px 0px' });
    holders.forEach((el) => this.pageIo.observe(el));
    this.reRenderPages = () => { rendered.clear(); holders.forEach((el) => { el.querySelector('canvas')?.remove(); this.pageIo.unobserve(el); this.pageIo.observe(el); }); };
  }

  setZoom(z) {
    const page = this.pos?.page || 1;
    this.zoom = Math.min(4, Math.max(0.5, z));
    this.pagesEl.style.setProperty('--zoom', this.zoom);
    this.reRenderPages?.();
    this.pagesEl.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ behavior: 'instant' });
  }

  trackPages() {
    const y = this.topOffset() + 40;
    const el = [...this.pagesEl.querySelectorAll('.page')].find((n) => n.getBoundingClientRect().bottom > y);
    if (!el) return;
    const page = +el.dataset.page;
    const b = Math.max(0, this.model.blocks.findIndex((x) => x.pg + 1 >= page));
    this.pos = { b, off: 0, page, pct: this.pctAt(b), chapter: this.chapterAt(b)?.title || '' };
    this.showStatus();
    this.save();
  }

  // ---------- selection → notes ----------
  onSelection() {
    const sel = getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, ' ').trim() : '';
    if (!text || this.mode !== 'flow' || !this.flow.contains(sel.anchorNode)) {
      this.selbar.hidden = true;
      return;
    }
    const range = sel.getRangeAt(0);
    const startEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement).closest('[data-b]');
    this.selection = { text, block: startEl ? +startEl.dataset.b : this.pos?.b || 0 };
    const rect = range.getBoundingClientRect();
    const bar = this.selbar;
    bar.hidden = false;
    // Below the selection: Android shows its own menu above it.
    const top = Math.min(innerHeight - bar.offsetHeight - 70, rect.bottom + 12);
    const left = Math.min(innerWidth - bar.offsetWidth - 8, Math.max(8, rect.left + rect.width / 2 - bar.offsetWidth / 2));
    bar.style.top = `${Math.max(this.topOffset(), top)}px`;
    bar.style.left = `${left}px`;
  }

  selectionNote() {
    const s = this.selection;
    if (!s) return null;
    const blk = this.model.blocks[s.block];
    return newNote({ bookId: this.book.id, quote: s.text, chapter: this.chapterAt(s.block)?.title || '', page: blk ? blk.pg + 1 : 0, block: s.block });
  }

  clearSelection() {
    getSelection()?.removeAllRanges();
    this.selbar.hidden = true;
  }

  async copySelection() {
    if (!this.selection) return;
    await copy(this.selection.text);
    toast('Copied');
    this.clearSelection();
  }

  async quickSend() {
    const note = this.selectionNote();
    if (!note) return;
    this.clearSelection();
    await saveNote(note);
    this.notes.push(note);
    this.paintHighlights();
    await sendNote(note, this.book);
  }

  noteFromSelection() {
    const note = this.selectionNote();
    if (!note) return;
    this.clearSelection();
    this.editNote(note, true);
  }

  editNote(note, isNew = false) {
    const quote = h('textarea.quote', { rows: 4, value: note.quote, 'aria-label': 'Quote' });
    const comment = h('textarea', { rows: 3, placeholder: 'Your thoughts (optional)', value: note.comment, 'aria-label': 'Comment' });
    const provider = h('select', { 'aria-label': 'Send to' },
      Object.entries(PROVIDERS).filter(([, p]) => p.available()).map(([id, p]) => h('option', { value: id, selected: id === defaultProviderId() }, p.label)));
    const persist = async () => {
      note.quote = quote.value.trim();
      note.comment = comment.value.trim();
      await saveNote(note);
      if (isNew) this.notes.push(note);
      this.paintHighlights();
    };
    const s = sheet(isNew ? 'New note' : 'Edit note', h('div.form',
      h('div.where.muted', [note.chapter, note.page && `p. ${note.page}`].filter(Boolean).join(' · ')),
      quote, comment,
      h('label.row', 'Send to ', provider),
      h('div.actions',
        h('button', { onclick: async () => { await persist(); s.close(); toast('Note saved'); } }, 'Save'),
        h('button.primary', { onclick: async () => { await persist(); s.close(); await sendNote(note, this.book, provider.value); } }, 'Save & send'))));
    setTimeout(() => comment.focus(), 50);
  }

  /** Mark the start of each note's quote in the text. */
  paintHighlights() {
    this.flow.querySelectorAll('mark.hl').forEach((m) => m.replaceWith(...m.childNodes));
    this.flow.normalize();
    for (const n of this.notes) {
      const el = this.flow.querySelector(`[data-b="${n.block}"]`);
      if (el && n.quote) markText(el, n.quote, n.id, () => this.editNote(n));
    }
  }

  // ---------- panels ----------
  showToc() {
    const cur = this.chapterAt(this.pos?.b ?? 0);
    const items = this.model.toc.map((t) => h(`button.toc-item.l${t.level}${t === cur ? '.current' : ''}`, {
      onclick: () => { s.close(); this.jumpTo(t.b); },
    }, h('span', t.title), h('span.muted', t.pg + 1)));
    const s = sheet('Contents', items.length ? h('nav.toc', items) : h('p.muted', 'This document has no chapters or headings.'), { side: true });
    s.el.querySelector('.current')?.scrollIntoView({ block: 'center' });
  }

  jumpTo(b) {
    if (this.mode === 'pages') {
      const pg = this.model.blocks[b]?.pg + 1;
      this.pagesEl.querySelector(`[data-page="${pg}"]`)?.scrollIntoView({ behavior: 'instant' });
    } else this.goToBlock(b, 0);
  }

  async showNotes() {
    const notes = (this.notes = await listNotes(this.book.id));
    const list = notes.map((n) => h('article.note',
      h('blockquote', { dir: 'auto' }, n.quote),
      n.comment ? h('p', { dir: 'auto' }, n.comment) : null,
      h('div.muted.small', [n.chapter, n.page && `p. ${n.page}`, fmtDate(n.createdAt)].filter(Boolean).join(' · ')),
      h('div.actions',
        h('button', { onclick: () => { s.close(); this.jumpTo(n.block); } }, 'Go to'),
        h('button', { onclick: () => sendNote(n, this.book) }, 'Send'),
        h('button', { onclick: () => { s.close(); this.editNote(n); } }, 'Edit'),
        h('button.danger', { onclick: async (e) => {
          if (!confirm('Delete this note?')) return;
          await deleteNote(n.id);
          this.notes = this.notes.filter((x) => x.id !== n.id);
          this.paintHighlights();
          e.target.closest('.note').remove();
        } }, 'Delete'))));
    const s = sheet(`Notes (${notes.length})`, h('div',
      notes.length ? h('div.actions.top',
        h('button', { onclick: () => download(`${this.book.title} - notes.md`, new Blob([bookNotesMarkdown(notes, this.book)], { type: 'text/markdown' })) }, 'Export .md'),
        h('button', { onclick: async () => { await copy(bookNotesMarkdown(notes, this.book)); toast('All notes copied'); } }, 'Copy all')) : null,
      notes.length ? list : h('p.muted', 'No notes yet. Select text while reading and tap “📝 Note”.')), { side: true });
  }

  showSettings() {
    const st = settings();
    const chip = (key, val, label) => h(`button.chip${st[key] === val ? '.on' : ''}`, {
      onclick: async (e) => {
        await updateSettings({ [key]: val });
        e.target.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
        e.target.classList.add('on');
        this.track();
      },
    }, label);
    const sizeVal = h('span.val', `${st.size}px`);
    const size = async (d) => {
      const v = Math.min(36, Math.max(12, settings().size + d));
      const keep = this.pos;
      await updateSettings({ size: v });
      sizeVal.textContent = `${v}px`;
      if (keep && this.mode === 'flow') this.goToBlock(keep.b, keep.off);
    };
    const range = (key, min, max, step, fmt) => {
      const out = h('span.val', fmt(st[key]));
      const input = h('input', { type: 'range', min, max, step, value: st[key], oninput: async (e) => {
        await updateSettings({ [key]: +e.target.value });
        out.textContent = fmt(+e.target.value);
      } });
      return [input, out];
    };
    const toggle = (key, label) => h('label.row', h('input', { type: 'checkbox', checked: st[key], onchange: (e) => updateSettings({ [key]: e.target.checked }) }), ' ', label);
    const vault = h('input', { value: st.obsidianVault, placeholder: 'Vault name (empty = last opened)', onchange: (e) => updateSettings({ obsidianVault: e.target.value.trim() }) });
    const folder = h('input', { value: st.obsidianFolder, placeholder: 'Folder', onchange: (e) => updateSettings({ obsidianFolder: e.target.value.trim() }) });
    sheet('Text & notes', h('div.settings',
      h('h3', 'Font'), h('div.chips', Object.entries(FONTS).map(([k, f]) => chip('font', k, f.label))),
      h('h3', 'Size'), h('div.row', h('button.icon', { onclick: () => size(-1), 'aria-label': 'Smaller' }, 'A−'), sizeVal, h('button.icon', { onclick: () => size(1), 'aria-label': 'Bigger' }, 'A+')),
      h('h3', 'Line spacing'), h('div.row', ...range('lineHeight', 1.2, 2.2, 0.05, (v) => v.toFixed(2))),
      h('h3', 'Text width'), h('div.row', ...range('width', 24, 60, 1, (v) => `${v} em`)),
      h('h3', 'Theme'), h('div.chips', Object.entries(THEMES).map(([k, l]) => chip('theme', k, l))),
      h('div.toggles', toggle('justify', 'Justify text'), toggle('pageMarkers', 'Show page numbers in text')),
      h('h3', 'Send notes to'),
      h('select', { onchange: (e) => updateSettings({ noteProvider: e.target.value }) },
        h('option', { value: 'auto', selected: st.noteProvider === 'auto' }, 'Automatic (share on phone, Keep on PC)'),
        Object.entries(PROVIDERS).filter(([, p]) => p.available()).map(([id, p]) => h('option', { value: id, selected: st.noteProvider === id }, p.label))),
      h('details', h('summary', 'Obsidian options'), h('div.form', vault, folder)),
    ), { side: true });
  }

  onKey(e) {
    if (e.target.closest?.('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey || $('.backdrop')) return;
    const k = e.key;
    if (k === 'Escape') this.leave();
    else if (k === 't' || k === 'T') this.showToc();
    else if (k === 'n' || k === 'N') this.showNotes();
    else if (k === 'a' || k === 'A') this.showSettings();
    else if (k === 'o' || k === 'O') this.toggleMode();
    else if (k === 'e' || k === 'E') import('./epub/export.js').then((m) => m.exportEpub(this.book.id));
    else if (k === '+' || k === '=') updateSettings({ size: Math.min(36, settings().size + 1) });
    else if (k === '-') updateSettings({ size: Math.max(12, settings().size - 1) });
    else if (k === 'ArrowRight' || k === 'ArrowLeft') {
      e.preventDefault();
      scrollBy({ top: (k === 'ArrowRight' ? 1 : -1) * (innerHeight - 120), behavior: 'smooth' });
    } else return;
  }
}

function renderBlock(b, i) {
  const data = { b: i };
  switch (b.t) {
    case 'h': return h(`h${Math.min(6, b.l + 1)}`, { dataset: data, dir: 'auto' }, runs(b.runs));
    case 'p': return h(`p${b.li ? '.li' : ''}`, { dataset: data, dir: 'auto' }, runs(b.runs));
    case 'img': return h('figure.fig', { dataset: data },
      h('img', { dataset: { k: b.k }, alt: '', width: b.w, height: b.h, style: { aspectRatio: `${b.w} / ${b.h}`, maxWidth: `min(100%, ${Math.round(b.w * 1.6)}px)` } }));
    case 'table': return h('div.tbl', { dataset: data },
      h('div.scroll', h('table', h('tbody', b.rows.map((row, ri) => h('tr', row.map((c) =>
        h(ri === 0 && row.every((x) => x.b) ? 'th' : 'td', { colSpan: c.cs || 1, rowSpan: c.rs || 1, dir: 'auto' }, c.s))))))),
      b.k != null ? h('img.snap', { dataset: { k: b.k }, alt: 'Original table', width: b.w, height: b.h }) : null,
      b.k != null ? h('button.snap-btn.small', 'Show original') : null);
    case 'scan': return h('figure.fig.scan', { dataset: data },
      h('img', { dataset: { k: b.k }, alt: `Scanned page ${b.pg + 1}`, width: b.w, height: b.h, style: { aspectRatio: `${b.w} / ${b.h}` } }),
      h('figcaption.muted', 'Scanned page (no text layer) — see README → OCR'));
    default: return h('div', { dataset: data });
  }
}

function runs(list) {
  return (list || []).map((r) => (r.b && r.i ? h('b', h('i', r.s)) : r.b ? h('b', r.s) : r.i ? h('i', r.s) : r.s));
}

/** Wrap the first occurrence of (the start of) `quote` inside `el` with <mark>. */
function markText(el, quote, id, onClick) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, text.length]); text += n.data; }
  const norm = (s) => s.replace(/\s+/g, ' ');
  const hay = norm(text);
  if (hay.length !== text.length) return; // keep offsets simple; block text is already normalised
  const probe = quote.slice(0, Math.min(40, quote.length));
  const start = hay.indexOf(probe);
  if (start < 0) return;
  const end = Math.min(text.length, start + quote.length);
  const loc = (off) => {
    for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k][1] <= off) return [nodes[k][0], off - nodes[k][1]];
    return [nodes[0][0], 0];
  };
  const range = document.createRange();
  const [sn, so] = loc(start);
  const [en, eo] = loc(end);
  range.setStart(sn, so);
  range.setEnd(en, Math.min(eo, en.data.length));
  try {
    const mark = h('mark.hl', { dataset: { note: id }, title: 'Open note', onclick: (e) => { e.stopPropagation(); onClick(); } });
    mark.append(range.extractContents());
    range.insertNode(mark);
  } catch { /* overlapping highlight: skip */ }
}

function throttle(fn, ms) {
  let t = 0;
  let timer;
  return () => {
    const now = Date.now();
    clearTimeout(timer);
    if (now - t > ms) { t = now; fn(); } else timer = setTimeout(() => { t = Date.now(); fn(); }, ms);
  };
}

function debounce(fn, ms) {
  let timer;
  return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
}
