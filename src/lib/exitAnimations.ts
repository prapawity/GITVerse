// Exit animations for dialogs, menus, popovers, backdrops and toasts without changing
// how each component closes. When React removes one of these elements, a static,
// inert copy is put back in its place, plays a short exit animation, then is removed.
// The copy has its ARIA roles stripped so `[role="dialog"]` / `[role="menu"]` queries
// (keyboard shortcuts, Escape handling, tests) treat the element as already closed.

const DURATION = 160;
const MATCH = "[role='dialog'], [role='menu'], [role='listbox'], .fixed.inset-0, .pop-in, .toast-in";

function exitClass(element: Element): string | null {
  const role = element.getAttribute('role');
  if (role === 'dialog') return 'exit-dialog';
  if (role === 'menu' || role === 'listbox' || element.classList.contains('pop-in')) return 'exit-pop';
  if (element.classList.contains('toast-in')) return 'exit-toast';
  if (element.classList.contains('fixed') && element.classList.contains('inset-0')) return 'exit-fade';
  return null;
}

function prepare(element: Element) {
  const cls = exitClass(element);
  if (cls) element.classList.add(cls);
  element.removeAttribute('role');
  element.removeAttribute('aria-modal');
  element.removeAttribute('id');
}

function ghost(node: Element, parent: Node, next: Node | null) {
  const copy = node.cloneNode(true) as HTMLElement;
  for (const element of [copy, ...copy.querySelectorAll(MATCH)]) prepare(element);
  copy.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  copy.setAttribute('inert', '');
  copy.setAttribute('aria-hidden', 'true');
  copy.dataset.exitGhost = '';
  copy.style.pointerEvents = 'none';
  try {
    parent.insertBefore(copy, next && next.parentNode === parent ? next : null);
  } catch {
    return;
  }
  setTimeout(() => copy.remove(), DURATION);
}

let started = false;

export function startExitAnimations() {
  if (started || typeof MutationObserver === 'undefined') return;
  started = true;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  new MutationObserver((records) => {
    if (reduced.matches) return;
    for (const record of records) {
      const parent = record.target;
      if (!parent.isConnected) continue;
      for (const node of record.removedNodes) {
        if (!(node instanceof HTMLElement) || 'exitGhost' in node.dataset) continue;
        // a small wrapper around an overlay (e.g. a portal root) counts; whole panels being swapped do not
        const wrapsOverlay = node.querySelector(MATCH) && node.getElementsByTagName('*').length < 400;
        if (node.matches(MATCH) || wrapsOverlay) ghost(node, parent, record.nextSibling);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
