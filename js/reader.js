// Reader view: reflowed text (font/size/theme adjustable) or the original PDF pages.
// Tracks where you are (block, page, chapter) and what you've read (see progress.js), plus
// bookmarks, a "back" chip after jumps, and notes from selected text.
import { get, put } from './db.js';
import {
  FINISHED_SHARE, addRange, blockSizes, chapterRanges, creditVisible, emptyReading, loadReading, prefix,
  rangeStats, readSize, removeRange, timeFor, updateSpeed,
} from './progress.js';
import { deleteNote, listNotes, newNote, saveNote, bookNotesMarkdown } from './notes/notes.js';
import { PROVIDERS, copy, defaultProviderId, sendNote } from './notes/providers.js';
import { FONTS, THEMES, settings, updateSettings } from './settings.js';
import { $, download, fmtDate, h, sheet, toast } from './ui.js';
import { EXTRACT_VERSION } from './pdf/extract.js';

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
    // Progress is measured in amount of text (independent of layout, fonts and lazy rendering).
    this.sizes = blockSizes(model.blocks);
    this.pre = prefix(this.sizes);
    this.total = Math.max(1, this.pre[this.sizes.length]);
    this.chapters = chapterRanges(model.toc || [], model.blocks.length);
    this.reading = loadReading(book, model.blocks.length);
    this.credit = new Map(); // block → seconds-worth of attention so far (not yet "read")
    this.visible = new Set(); // blocks on screen
    this.byPage = new Map(); // pg → blocks (original-pages view)
    model.blocks.forEach((b, i) => { if (!this.byPage.has(b.pg)) this.byPage.set(b.pg, []); this.byPage.get(b.pg).push(i); });
    this.lastActive = Date.now();
    this.advanced = 0; // chars moved forward while reading (speed measurement)
    this.activeSecs = 0;
  }

  /** Printed page number (book's own numbering) for a page index. */
  label(pg) {
    if (this.model.pageless) return '';
    const l = this.model.labels?.[pg];
    return l && !String(l).startsWith('#') ? String(l) : String(pg + 1);
  }

  pctAt(b, off = 0) {
    return Math.min(1, (this.pre[b] + off * (this.sizes[b] || 0)) / this.total);
  }

  /** Outermost contents entry (chapter) containing block b, and the innermost (section). */
  chapterRangeAt(b) {
    let outer = null;
    for (const c of this.chapters) if (c.from <= b && b < c.to && (!outer || c.level < outer.level)) outer = c;
    return outer;
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
    this.isEpub = this.model.kind === 'epub';
    // EPUB books have no fixed pages to show; the "original pages" view is for PDFs.
    this.modeBtn = this.isEpub ? null : h('button.icon', { title: 'Original pages / Reflow (O)', 'aria-label': 'Toggle original pages', onclick: () => this.toggleMode() }, '⧉');

    this.root.replaceChildren(
      h('header.bar.top',
        h('button.icon', { onclick: () => this.leave(), title: 'Library (Esc)', 'aria-label': 'Back to library' }, '←'),
        h('div.titles', h('div.ttl', book.title), this.chapterEl),
        h('button.icon', { onclick: () => this.showToc(), title: 'Contents (T)', 'aria-label': 'Contents' }, '☰'),
        h('button.icon', { onclick: () => this.showNotes(), title: 'Notes (N)', 'aria-label': 'Notes' }, '🗒'),
        h('button.icon', { onclick: () => this.showSettings(), title: 'Text settings (A)', 'aria-label': 'Text settings' }, 'Aa'),
        this.modeBtn,
        h('button.icon', { onclick: () => this.showMenu(), title: 'More: bookmarks, go to page, start over…', 'aria-label': 'More' }, '⋮')),
      this.flow,
      this.pagesEl,
      h('footer.bar.bottom', this.status),
      this.selbar,
      this.backChip = h('div.backchip', { hidden: true },
        h('button.back-go', { onclick: () => this.goBack() }),
        h('button.icon.small', { onclick: () => this.hideBack(), 'aria-label': 'Hide' }, '✕')),
    );
    this.renderFlow();
    if (!this.isEpub && (this.model.v || 1) < EXTRACT_VERSION) toast('This book was converted by an older version. Library → ⋮ → Re-process for better results.', 6000);
    this.notes = await listNotes(book.id);
    this.paintHighlights();
    this.paintBookmarks();
    this.watchVisible();
    this.restore();

    const onScroll = throttle(() => this.track(), 250);
    const onSel = debounce(() => this.onSelection(), 180);
    const onKey = (e) => this.onKey(e);
    const onHide = () => { if (document.visibilityState === 'hidden') this.save(true); };
    const onPageHide = () => this.save(true);
    addEventListener('pagehide', onPageHide);
    this.cleanup.push(() => removeEventListener('pagehide', onPageHide));
    const onActive = () => { this.lastActive = Date.now(); };
    // Reading clock: every second on screen spreads attention over the visible text.
    this.lastTick = performance.now();
    const ticker = setInterval(() => this.tick(), 1000);
    for (const ev of ['scroll', 'pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, onActive, { passive: true });
    this.cleanup.push(() => { clearInterval(ticker); for (const ev of ['scroll', 'pointerdown', 'keydown', 'wheel', 'touchstart']) removeEventListener(ev, onActive); });
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
    // Contents lines inside the book link to their chapter.
    this.flow.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-to]');
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      this.jumpTo(+a.dataset.to);
    }, true);
    // Tap on the text (without selecting) toggles the bars, like an e-reader.
    this.flow.addEventListener('click', (e) => {
      if (e.target.closest('a,button,mark,img,table') || String(getSelection())) return;
      document.body.classList.toggle('immersive');
    });
    this.book = { ...this.book, openedAt: Date.now() };
    await put('books', this.book);
  }

  destroy() {
    this.save(true);
    this.cleanup.forEach((f) => f());
    this.io?.disconnect();
    this.visIo?.disconnect();
    clearTimeout(this.backTimer);
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
        section = h('section.pg', { dataset: { pg: this.label(b.pg) } });
        frag.append(section);
      }
      section.append(renderBlock(b, i, this));
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
    this.pos = { b, off, pgi: blk.pg, page: this.label(blk.pg), pct, chapter: ch?.title || '' };
    this.measure(b, off);
    this.showStatus();
    this.save();
  }

  /** Reading speed: text you moved forward through while reading (jumps don't count). */
  measure(b, off) {
    const at = this.pre[b] + off * this.sizes[b];
    if (this.lastAt != null && !this.jumped) {
      const d = at - this.lastAt;
      if (d > 0 && d < 5000) this.advanced += d;
    }
    this.jumped = false;
    this.lastAt = at;
  }

  /** Blocks currently on screen (between the bars), kept up to date by an observer. */
  watchVisible() {
    this.visIo?.disconnect();
    this.visible.clear();
    this.visIo = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const b = +e.target.dataset.b;
        if (e.isIntersecting) this.visible.add(b); else this.visible.delete(b);
      }
    }, { rootMargin: '-56px 0px -40px 0px' });
    this.flow.querySelectorAll('[data-b]').forEach((el) => this.visIo.observe(el));
  }

  tick() {
    const now = performance.now();
    const dt = Math.min(5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    // Not reading: app in the background, a panel open, or nobody touched anything for 4 minutes.
    if (document.visibilityState !== 'visible' || document.querySelector('.backdrop') || Date.now() - this.lastActive > 240000) return;
    const r = this.reading;
    r.ms = (r.ms || 0) + dt * 1000;
    this.activeSecs += dt;
    if (this.activeSecs >= 90) {
      r.speed = updateSpeed(r.speed, this.advanced, this.activeSecs);
      this.activeSecs = 0;
      this.advanced = 0;
    }
    const vis = this.mode === 'pages' ? (this.byPage.get(this.pos?.pgi) || []) : [...this.visible].sort((a, b) => a - b);
    const done = creditVisible(r, this.credit, this.sizes, vis, dt);
    if (done.length) this.onRead();
    else if (Math.round(r.ms / 1000) % 30 === 0) this.save(); // keep the reading time
  }

  /** Something new was read, or progress was changed by hand (`now`: save at once). */
  onRead(now = false) {
    const r = this.reading;
    r.pct = readSize(r.read, this.pre) / this.total;
    if (r.pct >= FINISHED_SHARE && !r.finishedAt) {
      r.finishedAt = Date.now();
      toast(`You've finished “${this.book.title}” 🎉`, 4000);
    }
    this.showStatus();
    this.save(now);
  }

  showStatus() {
    const p = this.pos;
    if (!p) return;
    this.chapterEl.textContent = p.chapter || '';
    const parts = [];
    if (p.page) parts.push(`Page ${p.page}`);
    const ch = this.chapterRangeAt(p.b);
    if (ch) {
      const left = (this.pre[ch.to] - this.pre[p.b]) - readSize(this.reading.read, this.pre, p.b, ch.to);
      parts.push(left > 0 ? `${timeFor(left, this.reading.speed)} left in chapter` : 'chapter read');
    }
    parts.push(`${Math.round((this.reading.pct || 0) * 100)}% read`);
    this.status.textContent = parts.join(' · ');
  }

  save(now = false) {
    clearTimeout(this.saveTimer);
    // One write, started right away (no read first): it also completes when the page is closing.
    const write = () => {
      if (!this.pos) return;
      this.book = { ...this.book, progress: this.pos, reading: this.reading, openedAt: Date.now() };
      put('books', this.book).catch((err) => console.warn('save failed', err));
    };
    if (now) write(); else this.saveTimer = setTimeout(write, 800);
  }

  restore() {
    this.reading.pct = readSize(this.reading.read, this.pre) / this.total;
    const p = this.pos;
    if (!p || !this.model.blocks[p.b]) { this.pos = null; this.track(); return; }
    this.goToBlock(p.b, p.off || 0);
  }

  goToBlock(b, off = 0) {
    const el = this.flow.querySelector(`[data-b="${b}"]`);
    if (!el) return;
    this.jumped = true;
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
    const page = (this.pos?.pgi ?? 0) + 1; // 1-based PDF page
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
    }, h('span.pno.muted', this.label(i))));
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
        else if (!e.isIntersecting && rendered.has(n) && Math.abs(n - ((this.pos?.pgi ?? 0) + 1)) > 4) {
          el.querySelector('canvas')?.remove();
          rendered.delete(n);
        }
      }
    }, { rootMargin: '1200px 0px' });
    holders.forEach((el) => this.pageIo.observe(el));
    this.reRenderPages = () => { rendered.clear(); holders.forEach((el) => { el.querySelector('canvas')?.remove(); this.pageIo.unobserve(el); this.pageIo.observe(el); }); };
  }

  setZoom(z) {
    const page = (this.pos?.pgi ?? 0) + 1;
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
    this.pos = { b, off: 0, pgi: page - 1, page: this.label(page - 1), pct: this.pctAt(b), chapter: this.chapterAt(b)?.title || '' };
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
    return newNote({ bookId: this.book.id, quote: s.text, chapter: this.chapterAt(s.block)?.title || '', page: blk ? this.label(blk.pg) : '', block: s.block });
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

  // ---------- jumps and the way back ----------
  /**
   * Go to a block from the contents, a bookmark, a note or a link. If that's far from where you
   * were, a "↩ Back to p. X" chip lets you return (and tapping it again flips back).
   */
  jumpTo(b, off = 0, { remember = true } = {}) {
    const from = this.pos;
    if (this.mode === 'pages') {
      const pg = this.model.blocks[b]?.pg + 1;
      this.pagesEl.querySelector(`[data-page="${pg}"]`)?.scrollIntoView({ behavior: 'instant' });
    } else this.goToBlock(b, off);
    if (remember && from && Math.abs(this.pre[b] - this.pre[from.b]) > 1500) this.showBack(from);
  }

  showBack(pos) {
    this.backPos = pos;
    this.backChip.querySelector('.back-go').textContent = `↩ Back to ${pos.page ? `p. ${pos.page}` : pos.chapter || 'where you were'}`;
    this.backChip.hidden = false;
    clearTimeout(this.backTimer);
    this.backTimer = setTimeout(() => this.hideBack(), 180000);
  }

  hideBack() { this.backChip.hidden = true; clearTimeout(this.backTimer); }

  goBack() {
    const to = this.backPos;
    if (!to) return;
    const here = this.pos;
    this.jumpTo(to.b, to.off || 0, { remember: false });
    if (here) this.showBack(here); // tap again to flip back
  }

  // ---------- contents, with what you've read ----------
  showToc(tab = 'toc') {
    const body = h('div.toc-wrap');
    const s = sheet('Contents', body, { side: true });
    const render = (which) => {
      tab = which;
      const nb = this.reading.bookmarks.length;
      body.replaceChildren(
        h('div.tabs', { role: 'tablist' },
          h(`button.tab${tab === 'toc' ? '.on' : ''}`, { role: 'tab', onclick: () => render('toc') }, 'Chapters'),
          h(`button.tab${tab === 'bm' ? '.on' : ''}`, { role: 'tab', onclick: () => render('bm') }, `Bookmarks${nb ? ` (${nb})` : ''}`)),
        tab === 'toc' ? this.tocList(s, () => render('toc')) : this.bookmarkList(s, () => render('bm')));
      body.querySelector('.current')?.scrollIntoView({ block: 'center' });
    };
    render(tab);
  }

  tocList(s, refresh) {
    const r = this.reading;
    const speed = r.speed;
    const book = rangeStats(r, this.pre, 0, this.sizes.length);
    const summary = h('div.read-summary',
      h('div.progress', h('span', { style: { width: `${Math.round(book.pct * 100)}%` } })),
      h('div.muted.small', [
        r.finishedAt ? `Finished ${fmtDate(r.finishedAt)}` : `${Math.round(book.pct * 100)}% read`,
        book.total - book.read > 0 && !r.finishedAt ? `about ${timeFor(book.total - book.read, speed)} left` : '',
        r.ms > 60000 ? `${timeFor((r.ms / 1000) * speed, speed)} spent` : '',
      ].filter(Boolean).join(' · ')));
    if (!this.chapters.length) return h('div', summary, h('p.muted', 'This document has no chapters or headings.'));
    const cur = this.chapterAt(this.pos?.b ?? 0);
    const go = (b) => { s.close(); this.jumpTo(b); };
    const rows = this.chapters.map((c) => {
      const st = rangeStats(r, this.pre, c.from, c.to);
      const icon = st.state === 'done' ? '✓' : st.state === 'started' ? '◐' : '○';
      const meta = st.state === 'done' ? 'read' : st.state === 'started'
        ? `${Math.max(1, Math.round(st.pct * 100))}% · ${timeFor(st.total - st.read, speed)} left` : timeFor(st.total, speed);
      const actions = h('div.toc-actions', { hidden: true },
        h('button.small', { onclick: () => go(c.from) }, 'Go to start'),
        st.state === 'started' ? h('button.small', { onclick: () => go(st.next) }, `Continue at p. ${this.label(this.model.blocks[st.next].pg)}`) : null,
        st.state !== 'done' ? h('button.small', { onclick: () => { r.read = addRange(r.read, c.from, c.to); this.onRead(true); refresh(); } }, 'Mark as read') : null,
        st.read > 0 ? h('button.small', { onclick: () => { r.read = removeRange(r.read, c.from, c.to); r.finishedAt = 0; this.onRead(true); refresh(); } }, 'Mark as unread') : null);
      const t = c.title;
      return h(`div.toc-row.l${c.level}.${st.state}`,
        h(`button.toc-item.l${c.level}${this.model.toc[this.chapters.indexOf(c)] === cur ? '.current' : ''}`,
          { onclick: () => go(st.state === 'started' ? st.next : c.from), title: st.state === 'started' ? 'Continue where you stopped in this chapter' : 'Go to chapter' },
          h('span.state', { 'aria-label': st.state === 'done' ? 'read' : st.state === 'started' ? 'started' : 'not read' }, icon),
          h('span.t', t), h('span.muted.pg', this.label(c.pg))),
        h('div.toc-meta', h('span.muted.small', meta),
          h('button.icon.small.more', { 'aria-label': `Options for ${t}`, onclick: () => { actions.hidden = !actions.hidden; } }, '⋯')),
        actions);
    });
    return h('div', summary, h('nav.toc', rows));
  }

  // ---------- bookmarks ----------
  bookmarkAt(b) { return this.reading.bookmarks.find((m) => m.b === b); }

  toggleBookmark() {
    const p = this.pos;
    if (!p) return;
    const old = this.bookmarkAt(p.b);
    if (old) {
      this.reading.bookmarks = this.reading.bookmarks.filter((m) => m !== old);
      toast('Bookmark removed');
    } else {
      const blk = this.model.blocks[p.b];
      const text = (blk.runs ? blk.runs.map((x) => x.s).join('') : blk.text || '').replace(/\s+/g, ' ').trim();
      this.reading.bookmarks.push({ id: `${Date.now().toString(36)}`, b: p.b, off: p.off, pgi: p.pgi, page: p.page, chapter: p.chapter, text: text.slice(0, 100), at: Date.now() });
      this.reading.bookmarks.sort((a, b) => a.b - b.b);
      toast(`Bookmarked${p.page ? ` p. ${p.page}` : ''}`);
    }
    this.paintBookmarks();
    this.save(true);
  }

  paintBookmarks() {
    this.flow.querySelectorAll('.bm').forEach((el) => el.classList.remove('bm'));
    for (const m of this.reading.bookmarks) this.flow.querySelector(`[data-b="${m.b}"]`)?.classList.add('bm');
  }

  bookmarkList(s, refresh) {
    const here = this.pos && this.bookmarkAt(this.pos.b);
    const add = h('button.small', { onclick: () => { this.toggleBookmark(); refresh(); } }, here ? 'Remove the bookmark here' : '🔖 Bookmark this place');
    const list = this.reading.bookmarks.map((m) => h('div.bm-row',
      h('button.bm-go', { onclick: () => { s.close(); this.jumpTo(m.b, m.off || 0); } },
        h('div', [m.page && `p. ${m.page}`, m.chapter].filter(Boolean).join(' · ') || 'Bookmark'),
        m.text ? h('div.muted.small', { dir: 'auto' }, m.text) : null),
      h('button.icon.small', { 'aria-label': 'Delete bookmark', onclick: () => {
        this.reading.bookmarks = this.reading.bookmarks.filter((x) => x !== m);
        this.paintBookmarks(); this.save(true); refresh();
      } }, '✕')));
    return h('div', h('div.actions.top', add),
      list.length ? h('div.bm-list', list) : h('p.muted', 'No bookmarks yet. Use ⋮ → Bookmark, or press B.'));
  }

  // ---------- ⋮ menu ----------
  showMenu() {
    const p = this.pos;
    const ch = p ? this.chapterRangeAt(p.b) : null;
    const chSt = ch ? rangeStats(this.reading, this.pre, ch.from, ch.to) : null;
    const act = (label, fn, cls = '') => h(`button${cls}`, { onclick: () => { s.close(); fn(); } }, label);
    const s = sheet(this.book.title, h('div.menu',
      act(p && this.bookmarkAt(p.b) ? 'Remove bookmark here' : '🔖 Bookmark this place  (B)', () => this.toggleBookmark()),
      act('Bookmarks…', () => this.showToc('bm')),
      this.model.pageless ? null : act('Go to page…  (G)', () => this.goToPage()),
      ch && chSt.state !== 'done' ? act(`Mark “${short(ch.title)}” as read`, () => { this.reading.read = addRange(this.reading.read, ch.from, ch.to); this.onRead(true); toast('Chapter marked as read'); }) : null,
      ch && chSt.read > 0 ? act(`Mark “${short(ch.title)}” as unread`, () => { this.reading.read = removeRange(this.reading.read, ch.from, ch.to); this.reading.finishedAt = 0; this.onRead(true); toast('Chapter marked as unread'); }) : null,
      this.isEpub ? null : act('Export EPUB  (E)', async () => (await import('./epub/export.js')).exportEpub(this.book.id)),
      act('Start over…', () => this.startOver()),
      this.reading.finishedAt ? null : act('Mark the book as finished', () => { this.reading.read = [[0, this.sizes.length]]; this.onRead(true); }),
    ));
  }

  goToPage() {
    const n = this.model.pages?.length || 0;
    const ans = prompt(`Go to page (as printed in the book; ${this.label(0)}–${this.label(n - 1)})`, this.pos?.page || '');
    if (!ans) return;
    const want = ans.trim().toLowerCase();
    let pg = this.model.pages.findIndex((_, i) => this.label(i).toLowerCase() === want);
    if (pg < 0 && /^\d+$/.test(want)) pg = Math.min(n - 1, Math.max(0, +want - 1)); // file page number
    if (pg < 0) { toast(`No page “${ans}”`); return; }
    const b = this.model.blocks.findIndex((x) => x.pg >= pg);
    if (b >= 0) this.jumpTo(b);
  }

  startOver() {
    if (!confirm(`Start “${this.book.title}” over?\n\nWhat you've read is cleared and you go back to the beginning. Notes and bookmarks are kept.`)) return;
    const from = this.pos;
    const time = this.reading.ms;
    this.reading = { ...emptyReading(), bookmarks: this.reading.bookmarks, speed: this.reading.speed, ms: time };
    this.credit.clear();
    this.goToBlock(0, 0);
    if (from) this.showBack(from);
    this.onRead(true);
    toast('Starting over — your notes and bookmarks are kept', 3500);
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
    else if ((k === 'o' || k === 'O') && !this.isEpub) this.toggleMode();
    else if ((k === 'e' || k === 'E') && !this.isEpub) import('./epub/export.js').then((m) => m.exportEpub(this.book.id));
    else if (k === 'b' || k === 'B') this.toggleBookmark();
    else if ((k === 'g' || k === 'G') && !this.model.pageless) this.goToPage();
    else if (k === '+' || k === '=') updateSettings({ size: Math.min(36, settings().size + 1) });
    else if (k === '-') updateSettings({ size: Math.max(12, settings().size - 1) });
    else if (k === 'ArrowRight' || k === 'ArrowLeft') {
      e.preventDefault();
      scrollBy({ top: (k === 'ArrowRight' ? 1 : -1) * (innerHeight - 120), behavior: 'smooth' });
    } else return;
  }
}

function renderBlock(b, i, reader) {
  const data = { b: i };
  switch (b.t) {
    case 'h': return h(`h${Math.min(6, b.l + 1)}`, { dataset: data, dir: 'auto' }, runs(b.runs));
    case 'p':
      if (b.note) return h('div.note', { dataset: data, dir: 'auto' }, h('span.note-label', b.note), ' ', runs(b.runs));
      return h(`p${b.li ? '.li' : ''}${b.quote ? '.quote' : ''}${b.nl ? '.nl' : ''}`, { dataset: data, dir: 'auto' }, runs(b.runs));
    case 'code': return h('pre.code', { dataset: data }, h('code', b.text));
    case 'tl': return h(`p.toc-line.l${b.lvl || 0}`, { dataset: data, dir: 'auto' },
      b.to != null ? h('a', { href: '#', dataset: { to: b.to } }, runs(b.runs)) : runs(b.runs),
      b.num ? h('span.pn', b.num) : null);
    case 'il': return h(`p.index-line.l${b.lvl || 0}`, { dataset: data, dir: 'auto' }, runs(b.runs));
    case 'img': return h('figure.fig', { dataset: data },
      // PDF sizes are in points (scale up a little); EPUB sizes are real pixels.
      h('img', { dataset: { k: b.k }, alt: b.alt || '', width: b.w, height: b.h, style: { aspectRatio: `${b.w} / ${b.h}`, maxWidth: `min(100%, ${Math.round(b.w * (reader.isEpub ? 1 : 1.6))}px)` } }));
    case 'table': return h('div.tbl', { dataset: data },
      h('div.scroll', h('table', h('tbody', b.rows.map((row, ri) => h('tr', row.map((c) =>
        h(ri === 0 && row.every((x) => x.b) ? 'th' : 'td', { colSpan: c.cs || 1, rowSpan: c.rs || 1, dir: 'auto' }, c.s))))))),
      b.k != null ? h('img.snap', { dataset: { k: b.k }, alt: 'Original table', width: b.w, height: b.h }) : null,
      b.k != null ? h('button.snap-btn.small', 'Show original') : null);
    case 'scan': return h('figure.fig.scan', { dataset: data },
      h('img', { dataset: { k: b.k }, alt: `Scanned page ${reader.label(b.pg)}`, width: b.w, height: b.h, style: { aspectRatio: `${b.w} / ${b.h}` } }),
      b.pg === 0 ? null : h('figcaption.muted', 'Picture of the page (no text in the PDF) — see README → OCR'));
    default: return h('div', { dataset: data });
  }
}

function runs(list) {
  return (list || []).map((r) => {
    let el = r.m ? h('code', r.s) : r.s;
    if (r.i) el = h('i', el);
    if (r.b) el = h('b', el);
    return el;
  });
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

const short = (t) => (t.length > 34 ? `${t.slice(0, 32)}…` : t);

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
