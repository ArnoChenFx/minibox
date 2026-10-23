export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Scrolls a sideways-scrolling strip, such as a tab bar on a narrow screen, so that `item` is in view. Only the strip
 * scrolls; the page stays where it is. A strip that fits its width does not move.
 */
export function revealInStrip(strip, item) {
  if (!strip || !item || strip.scrollWidth <= strip.clientWidth) return;
  const left = item.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
  strip.scrollLeft = left - (strip.clientWidth - item.offsetWidth) / 2;
}

/** Parse an HTML string into a single element. */
export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/**
 * Copies text to the clipboard. The async API exists only in secure contexts, so a dashboard opened over plain HTTP
 * falls back to selecting the text in a hidden field and running the copy command.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Plain HTTP has no navigator.clipboard, and a browser may refuse it; the copy command below still works there.
  }
  const previous = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.left = "0";
  field.style.opacity = "0";
  field.style.pointerEvents = "none";
  document.body.append(field);
  let copied = false;
  try {
    field.select();
    copied = document.execCommand("copy");
  } finally {
    field.remove();
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  }
  if (!copied) throw new Error("the browser refused the copy");
}

/** Delegate clicks on `[data-action]` within root to handlers[action](el, event). */
export function delegate(root, handlers) {
  root.addEventListener("click", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target || !root.contains(target)) return;
    const fn = handlers[target.dataset.action];
    if (fn) {
      e.preventDefault();
      e.stopPropagation();
      fn(target, e);
    }
  });
}
