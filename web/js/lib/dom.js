export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** Parse an HTML string into a single element. */
export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
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
