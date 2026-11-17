// Tiny DOM helpers shared by the views.

/** h('div.cls#id', {attrs/props/on*}, ...children) */
export function h(tag, props, ...kids) {
  const [, name, rest] = tag.match(/^([a-z0-9-]+)(.*)$/i);
  const el = document.createElement(name);
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) {
    if (m[1] === '.') el.classList.add(m[2]); else el.id = m[2];
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

let toastTimer;
export function toast(msg, ms = 2600) {
  let el = $('#toast');
  if (!el) { el = h('div#toast', { role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/**
 * Bottom sheet (phones) / side panel (wide screens). Returns {el, close}.
 * Closes on backdrop click, Esc, or the browser back button.
 */
export function sheet(title, body, { side = false, onClose } = {}) {
  const close = () => {
    if (!wrap.isConnected) return;
    wrap.remove();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', onPop);
    if (history.state?.sheet) history.back();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const onPop = () => { if (wrap.isConnected) { wrap.remove(); onClose?.(); } window.removeEventListener('popstate', onPop); };
  const panel = h(`div.sheet${side ? '.side' : ''}`, { role: 'dialog', 'aria-label': title },
    h('div.sheet-head', h('h2', title), h('button.icon', { onclick: close, 'aria-label': 'Close', title: 'Close' }, '✕')),
    h('div.sheet-body', body));
  const wrap = h('div.backdrop', { onclick: (e) => { if (e.target === wrap) close(); } }, panel);
  document.body.append(wrap);
  window.addEventListener('keydown', onKey);
  history.pushState({ ...(history.state || {}), sheet: true }, '');
  window.addEventListener('popstate', onPop);
  return { el: panel, close };
}

export function confirmDialog(message) {
  return Promise.resolve(window.confirm(message));
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function download(name, blob) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
