// Where a note can be sent. To add one (Notion, OneNote, a REST endpoint…), add an entry with
// {label, available(), send(note, book)}; it then shows up in the note editor and in Settings.
//
// Google Keep can't be filled in from a web page on a computer: there's no "new note with this
// text" link, and its API is only for company (Workspace) accounts. So:
//   phone → the share sheet; pick Keep and the note arrives filled in;
//   PC    → the note is copied and Keep opens on a new note: paste with Ctrl+V.
// Email, Gmail and Obsidian do get the text filled in on every device.

import { settings, updateSettings } from '../settings.js';
import { download, h, sheet, toast } from '../ui.js';
import { noteMarkdown, noteText, noteTitle } from './notes.js';

const isMobile = () => navigator.userAgentData?.mobile ?? /Android|iPhone|iPad/i.test(navigator.userAgent);
const isMac = () => /Mac/i.test(navigator.platform || navigator.userAgent);

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers that block the async clipboard API.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function openUrl(url) {
  const a = Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noopener' });
  document.body.append(a);
  a.click();
  a.remove();
}

const safeName = (s) => s.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Book notes';

async function share(note, book) {
  try {
    await navigator.share({ title: noteTitle(note, book), text: noteText(note, book) });
    return true;
  } catch (e) {
    if (e.name === 'AbortError') return false;
    throw e;
  }
}

/**
 * Keep on a computer: copy, explain the paste step once, open a new Keep note.
 * The "Open Keep" button is its own click, so the browser doesn't block the new tab.
 */
function keepOnComputer(note, book) {
  const text = noteText(note, book);
  const keys = isMac() ? '⌘V' : 'Ctrl+V';
  return new Promise((resolve) => {
    copy(text);
    if (settings().keepTipSeen) {
      openUrl('https://keep.new');
      toast(`Note copied — press ${keys} in the new Keep note`, 5000);
      resolve(true);
      return;
    }
    let done = false;
    const again = h('label.row.small', h('input', { type: 'checkbox' }), ' Don’t explain this again');
    const s = sheet('Send to Google Keep', h('div.form',
      h('p', 'On a computer, Google Keep can’t receive text from other apps, so the note is ', h('b', 'copied'), ' for you.'),
      h('ol.steps', h('li', 'Tap ', h('b', 'Open Keep'), ' — a new note opens.'), h('li', 'Press ', h('kbd', keys), ' to paste the note.')),
      h('pre.preview', { dir: 'auto' }, text),
      again,
      h('div.actions',
        h('button', { onclick: async () => { await copy(text); toast('Copied again'); } }, 'Copy again'),
        h('button.primary', { onclick: async () => {
          await copy(text);
          if (again.querySelector('input').checked) await updateSettings({ keepTipSeen: true });
          openUrl('https://keep.new');
          done = true;
          s.close();
        } }, 'Open Keep'))), { onClose: () => resolve(done) });
  });
}

export const PROVIDERS = {
  keep: {
    label: 'Google Keep',
    hint: () => (isMobile() && navigator.share ? 'opens the share menu: pick Keep, the note is filled in' : 'copies the note and opens a new Keep note: paste it'),
    available: () => true,
    send: (note, book) => (isMobile() && navigator.share ? share(note, book) : keepOnComputer(note, book)),
  },
  share: {
    label: 'Share… (other apps)',
    hint: () => (isMobile() ? 'the phone’s share menu' : 'Windows share: Mail, OneNote, Nearby…'),
    available: () => !!navigator.share,
    send: share,
  },
  email: {
    label: 'Email',
    hint: () => 'your mail app, with the note filled in',
    available: () => true,
    async send(note, book) {
      openUrl(`mailto:?subject=${encodeURIComponent(noteTitle(note, book))}&body=${encodeURIComponent(noteText(note, book))}`);
      return true;
    },
  },
  gmail: {
    label: 'Gmail (web)',
    hint: () => 'a new Gmail message with the note filled in',
    available: () => true,
    async send(note, book) {
      const q = new URLSearchParams({ view: 'cm', fs: '1', su: noteTitle(note, book), body: noteText(note, book) });
      openUrl(`https://mail.google.com/mail/?${q}`);
      return true;
    },
  },
  obsidian: {
    label: 'Obsidian',
    hint: () => 'added to one Markdown note per book',
    available: () => true,
    async send(note, book) {
      const s = settings();
      const file = `${s.obsidianFolder ? s.obsidianFolder.replace(/\/+$/, '') + '/' : ''}${safeName(book.title)}`;
      const params = new URLSearchParams({ file, content: `\n${noteMarkdown(note, book)}\n`, append: 'true' });
      if (s.obsidianVault) params.set('vault', s.obsidianVault);
      // URLSearchParams encodes spaces as '+', Obsidian expects %20.
      openUrl(`obsidian://new?${params.toString().replace(/\+/g, '%20')}`);
      return true;
    },
  },
  clipboard: {
    label: 'Copy (Markdown)',
    hint: () => 'paste it anywhere',
    available: () => true,
    async send(note, book) {
      await copy(noteMarkdown(note, book));
      toast('Note copied as Markdown');
      return true;
    },
  },
  file: {
    label: 'Download .md file',
    hint: () => 'saved to your Downloads folder',
    available: () => true,
    async send(note, book) {
      download(`${safeName(book.title)} - note.md`, new Blob([`${noteMarkdown(note, book)}\n`], { type: 'text/markdown' }));
      return true;
    },
  },
};

/** Provider id to use for "Send": the user's choice, else Google Keep. */
export function defaultProviderId() {
  const chosen = settings().noteProvider;
  if (chosen === 'share' && !navigator.share) return 'keep';
  return chosen && chosen !== 'auto' && PROVIDERS[chosen]?.available() ? chosen : 'keep';
}

/** Send a note; on success it's recorded in note.sent (the caller saves the note). */
export async function sendNote(note, book, id = defaultProviderId()) {
  const p = PROVIDERS[id];
  try {
    const ok = await p.send(note, book);
    if (ok) (note.sent ||= []).push({ to: id, label: p.label, at: Date.now() });
    return ok;
  } catch (e) {
    console.warn('send failed', e);
    toast(`Could not send: ${e.message || e}`);
    return false;
  }
}

export { copy };
