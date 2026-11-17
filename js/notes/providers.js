// Where notes can be sent. To add a provider (Notion, OneNote, email, a REST endpoint…),
// add an entry with {label, available(), send(note, book)} and it shows up in Settings.
//
// Google Keep has no public API for personal accounts (the Keep API is Workspace-admin only),
// so we reach Keep through the OS share sheet (Android) or clipboard + keep.new (Windows/desktop).

import { settings } from '../settings.js';
import { toast } from '../ui.js';
import { noteMarkdown, noteText } from './notes.js';

const isMobile = () => navigator.userAgentData?.mobile ?? /Android|iPhone|iPad/i.test(navigator.userAgent);

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

export const PROVIDERS = {
  share: {
    label: 'Share sheet (Android → Google Keep)',
    available: () => !!navigator.share,
    async send(note, book) {
      try {
        await navigator.share({ title: `${book.title} — note`, text: noteText(note, book) });
        return true;
      } catch (e) {
        if (e.name === 'AbortError') return false;
        throw e;
      }
    },
  },
  keep: {
    label: 'Google Keep (copy + open Keep)',
    available: () => true,
    async send(note, book) {
      await copy(noteText(note, book));
      toast('Note copied — paste it into the new Keep note');
      openUrl('https://keep.new');
      return true;
    },
  },
  obsidian: {
    label: 'Obsidian (append to a note per book)',
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
    label: 'Copy as Markdown',
    available: () => true,
    async send(note, book) {
      await copy(noteMarkdown(note, book));
      toast('Note copied as Markdown');
      return true;
    },
  },
};

/** Provider id to use for "Send": the user's choice, or a sensible default per platform. */
export function defaultProviderId() {
  const chosen = settings().noteProvider;
  if (chosen && chosen !== 'auto' && PROVIDERS[chosen]?.available()) return chosen;
  return isMobile() && PROVIDERS.share.available() ? 'share' : 'keep';
}

export async function sendNote(note, book, id = defaultProviderId()) {
  const p = PROVIDERS[id];
  try {
    return await p.send(note, book);
  } catch (e) {
    console.warn('send failed', e);
    toast(`Could not send: ${e.message || e}`);
    return false;
  }
}

export { copy };
