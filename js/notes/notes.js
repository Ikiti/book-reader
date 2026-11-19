// Notes live in the app (IndexedDB, per book) — open them with 🗒 in the reader. Sending copies a
// note to another app (Keep, email, Obsidian…); the note stays here and remembers where it went.
//
// A note: quotes from the book (the first one anchors it in the text; more can be added from other
// places), your own text, and when it was edited / sent.
import { del, notesFor, put } from '../db.js';

export function newNote({ bookId, quote = '', comment = '', chapter = '', page = '', block = 0 }) {
  const now = Date.now();
  return {
    id: crypto.randomUUID?.() || `${now}-${Math.random().toString(16).slice(2)}`,
    bookId,
    createdAt: now,
    updatedAt: now,
    quote: quote.trim(),
    comment: comment.trim(),
    chapter,
    page,
    block,
    clips: [], // more quotes: {quote, chapter, page, block}
    sent: [], // {to: provider id, label, at}
  };
}

export const saveNote = (note) => put('notes', { ...note, updatedAt: Date.now() }).then(() => { note.updatedAt = Date.now(); });
export const deleteNote = (id) => del('notes', id);
export const listNotes = async (bookId) => (await notesFor(bookId)).sort((a, b) => a.block - b.block || a.createdAt - b.createdAt);
export const isEmpty = (note) => !note.comment.trim() && !quotesOf(note).length;

/** All quotes of a note, the anchoring one first. */
export function quotesOf(note) {
  return [{ quote: note.quote, chapter: note.chapter, page: note.page, block: note.block }, ...(note.clips || [])].filter((q) => q.quote);
}

/** The note you worked on last (edited most recently). */
export function lastNote(notes) {
  let best = null;
  for (const n of notes) if (!best || (n.updatedAt || n.createdAt) > (best.updatedAt || best.createdAt)) best = n;
  return best;
}

const where = (note, book) => [book.title, note.chapter, note.page ? `p. ${note.page}` : ''].filter(Boolean).join(' · ');

/** Short title: for Keep's title field, email subject. */
export const noteTitle = (note, book) => `${book.title}${note.page ? ` — p. ${note.page}` : ''}`;

/** Plain text, for Keep / share sheets / email. */
export function noteText(note, book) {
  const qs = quotesOf(note);
  const quotes = qs.map((q) => `“${q.quote}”${qs.length > 1 && q.page ? ` (p. ${q.page})` : ''}`).join('\n\n');
  return [quotes, note.comment, `— ${where(note, book)}`].filter(Boolean).join('\n\n');
}

/** Markdown, for Obsidian / export. */
export function noteMarkdown(note, book) {
  const qs = quotesOf(note);
  const quotes = qs.map((q) => q.quote.split('\n').map((l) => `> ${l}`).join('\n') + (qs.length > 1 && q.page ? `\n> — p. ${q.page}` : '')).join('\n\n');
  const date = new Date(note.createdAt).toISOString().slice(0, 10);
  return [quotes, note.comment, `— *${where(note, book)}* (${date})`].filter(Boolean).join('\n\n');
}

export function bookNotesMarkdown(notes, book) {
  const head = `# Notes: ${book.title}${book.author ? `\n\n*${book.author}*` : ''}\n`;
  return [head, ...notes.map((n) => noteMarkdown(n, book))].join('\n\n---\n\n') + '\n';
}
