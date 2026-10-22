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

/**
 * Copies text to the clipboard. The async API exists only in secure contexts, so a dashboard opened over plain HTTP
 * falls back to selecting the text in a hidden field and running the copy command.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    if (!copied) throw new Error("the browser refused the copy");
  }
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
