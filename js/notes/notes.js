// Notes: a quote from the book, an optional comment, and where it came from.
import { del, notesFor, put } from '../db.js';

export function newNote({ bookId, quote, comment = '', chapter = '', page = 0, block = 0 }) {
  return {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    bookId,
    createdAt: Date.now(),
    quote: quote.trim(),
    comment: comment.trim(),
    chapter,
    page,
    block,
  };
}

export const saveNote = (note) => put('notes', note);
export const deleteNote = (id) => del('notes', id);
export const listNotes = async (bookId) => (await notesFor(bookId)).sort((a, b) => a.block - b.block || a.createdAt - b.createdAt);

const where = (note, book) => [book.title, note.chapter, note.page ? `p. ${note.page}` : ''].filter(Boolean).join(' · ');

/** Plain text, for Keep / share sheets. */
export function noteText(note, book) {
  return [note.quote && `“${note.quote}”`, note.comment, `— ${where(note, book)}`].filter(Boolean).join('\n\n');
}

/** Markdown, for Obsidian / export. */
export function noteMarkdown(note, book) {
  const quote = note.quote ? note.quote.split('\n').map((l) => `> ${l}`).join('\n') : '';
  const date = new Date(note.createdAt).toISOString().slice(0, 10);
  return [quote, note.comment, `— *${where(note, book)}* (${date})`].filter(Boolean).join('\n\n');
}

export function bookNotesMarkdown(notes, book) {
  const head = `# Notes: ${book.title}${book.author ? `\n\n*${book.author}*` : ''}\n`;
  return [head, ...notes.map((n) => noteMarkdown(n, book))].join('\n\n---\n\n') + '\n';
}
