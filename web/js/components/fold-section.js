import { esc } from "../lib/dom.js";
import { icon } from "../lib/icons.js";

/**
 * A section of a form that folds under its heading: a chevron button with the title and, optionally, a summary of what
 * is chosen that stays visible while folded. `extraHtml` sits at the right of the heading (a search) and folds with the
 * body. The title and summary keep the ids `${id}Title` and `${id}Summary`, so callers can repaint them.
 */
export function foldSectionHtml({ id, title, summary = "", open = false, extraHtml = "", body }) {
  return `<section class="fold-section" id="${esc(id)}" data-open="${open}">
    <div class="fold-head">
      <button type="button" class="fold-toggle" id="${esc(id)}Toggle" aria-expanded="${open}" aria-controls="${esc(id)}Body">${icon("chevron")}<span class="fold-title" id="${esc(id)}Title">${title}</span><span class="fold-summary" id="${esc(id)}Summary">${summary}</span></button>
      ${extraHtml}
    </div>
    <div class="fold-body" id="${esc(id)}Body"${open ? "" : " hidden"}>${body}</div>
  </section>`;
}

/** Opens or folds the section `id` under `root`. */
export function setFoldOpen(root, id, open) {
  const section = root.querySelector(`#${id}`);
  section.dataset.open = String(open);
  section.querySelector(".fold-toggle").setAttribute("aria-expanded", String(open));
  section.querySelector(".fold-body").hidden = !open;
}

/** Connects the fold buttons of every section under `root`. `onToggle(id, open)` runs after a click changes one. */
export function bindFoldSections(root, onToggle = () => {}) {
  for (const button of root.querySelectorAll(".fold-toggle")) {
    button.addEventListener("click", () => {
      const id = button.closest(".fold-section").id;
      const open = button.getAttribute("aria-expanded") !== "true";
      setFoldOpen(root, id, open);
      onToggle(id, open);
    });
  }
}
