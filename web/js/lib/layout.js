import { $, esc } from "./dom.js";

/** Render topbar breadcrumbs. Items are strings or { label, href }. */
export function setCrumbs(parts) {
  $("#crumbs").innerHTML = parts
    .map(
      (p, i) =>
        (typeof p === "string" ? `<span>${esc(p)}</span>` : `<a href="${p.href}">${esc(p.label)}</a>`) +
        (i < parts.length - 1 ? '<span class="sep">/</span>' : ""),
    )
    .join("");
}
