import { $, el, esc } from "./dom.js";
import { lang, t } from "./i18n.js";
import { icon } from "./icons.js";

// ---------- Toasts ----------
export function toast(title, { type = "success", message = "", timeout = 4000 } = {}) {
  let root = $("#toasts");
  if (!root) {
    root = el('<div id="toasts" class="toasts" role="status" aria-live="polite"></div>');
    document.body.append(root);
  }
  const ic = type === "error" ? "alertCircle" : type === "info" ? "info" : "checkCircle";
  const node = el(
    `<div class="toast ${type}">${icon(ic)}<div><strong>${esc(title)}</strong>${message ? `<div class="muted">${esc(message)}</div>` : ""}</div></div>`,
  );
  root.append(node);
  setTimeout(
    () => {
      node.classList.add("leaving");
      setTimeout(() => node.remove(), 220);
    },
    type === "error" ? timeout + 2000 : timeout,
  );
}

export const toastError = (title, err) => toast(title, { type: "error", message: err?.message ?? String(err) });

// ---------- Dialogs ----------
let openCount = 0;

/**
 * Open a modal dialog. `body` is an HTML string; `footer` an HTML string of buttons.
 * Returns { root, close }. onClose runs once on any close.
 */
export function openDialog({
  title,
  description = "",
  body = "",
  footer = "",
  iconName,
  tone = "",
  wide = false,
  onClose,
}) {
  const overlay = el(`<div class="overlay" role="presentation">
    <div class="dialog ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="dlg-title-${++openCount}">
      <div class="dialog-head">
        ${iconName ? `<div class="dialog-icon ${tone}">${icon(iconName, "icon-lg")}</div>` : ""}
        <div><h2 id="dlg-title-${openCount}">${esc(title)}</h2>${description ? `<p>${description}</p>` : ""}</div>
        <button class="icon-btn" data-close aria-label="${t("common.close")}">${icon("x")}</button>
      </div>
      ${body ? `<div class="dialog-body">${body}</div>` : ""}
      ${footer ? `<div class="dialog-foot">${footer}</div>` : ""}
    </div>
  </div>`);
  const prevFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    onClose?.();
    prevFocus?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  setTimeout(
    () =>
      (
        overlay.querySelector("[autofocus]") ??
        overlay.querySelector(".dialog-body input, .dialog-foot .btn-primary, .dialog-foot .btn-danger")
      )?.focus(),
    30,
  );
  return { root: overlay, close };
}

/** Promise-based confirm dialog. `message` and `body` are HTML. Resolves to false, or to { checked } when confirmed. */
export function confirmDialog({
  title,
  message,
  body = "",
  confirmText = t("common.confirm"),
  danger = false,
  checkbox,
}) {
  return new Promise((resolve) => {
    let result = false;
    const { root, close } = openDialog({
      title,
      description: message,
      iconName: danger ? "alert" : "info",
      tone: danger ? "danger" : "",
      body: checkbox
        ? `<label class="checkbox"><input type="checkbox" id="cfm-check" /> <span>${checkbox.label}${checkbox.help ? `<div class="help">${checkbox.help}</div>` : ""}</span></label>`
        : body,
      footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn ${danger ? "btn-danger" : "btn-primary"}" id="cfm-ok">${esc(confirmText)}</button>`,
      onClose: () => resolve(result),
    });
    root.querySelector("#cfm-ok").addEventListener("click", () => {
      result = { checked: !!root.querySelector("#cfm-check")?.checked };
      close();
    });
  });
}

/** Simple single-field prompt dialog. Resolves to the string or null. */
export function promptDialog({
  title,
  description = "",
  label,
  placeholder = "",
  value = "",
  help = "",
  confirmText = t("common.ok"),
  iconName = "info",
  validate,
}) {
  return new Promise((resolve) => {
    let result = null;
    const { root, close } = openDialog({
      title,
      description,
      iconName,
      body: `<div class="field"><label class="label" for="pd-input">${esc(label)}</label>
        <input class="input" id="pd-input" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off" autofocus />
        ${help ? `<div class="help">${help}</div>` : ""}<div class="error-text" id="pd-err"></div></div>`,
      footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="pd-ok">${esc(confirmText)}</button>`,
      onClose: () => resolve(result),
    });
    const input = root.querySelector("#pd-input");
    const submit = () => {
      const v = input.value.trim();
      const err = validate?.(v);
      if (err) {
        input.classList.add("invalid");
        root.querySelector("#pd-err").textContent = err;
        return;
      }
      result = v;
      close();
    };
    root.querySelector("#pd-ok").addEventListener("click", submit);
    input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  });
}

/** Put a button into a loading state while `fn` runs. */
export async function withBusy(btn, fn) {
  if (!btn) return fn();
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${btn.classList.contains("icon-btn") ? "" : `<span>${esc(btn.textContent.trim())}</span>`}`;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}

// ---------- Shared fragments ----------
export function emptyState({ iconName = "box", title, text = "", action = "" }) {
  return `<div class="empty"><div class="empty-icon">${icon(iconName, "icon-lg")}</div><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ""}${action}</div>`;
}

export function skeletonRows(n = 3, cols = 5) {
  return Array.from(
    { length: n },
    () => `<tr>${Array.from({ length: cols }, () => '<td><div class="skeleton sk-line"></div></td>').join("")}</tr>`,
  ).join("");
}

const STATE = {
  running: "badge-success",
  exited: "",
  created: "",
  paused: "badge-warning",
  restarting: "badge-warning",
  removing: "badge-warning",
  dead: "badge-danger",
  sleeping: "badge-warning",
};
/** `boxState(box)` picks sleeping when the box was stopped for idle/TTL. */
export function boxState(box) {
  if (box?.sleeping) return "sleeping";
  return box?.state ?? "unknown";
}
export function stateBadge(state) {
  const known = state in STATE;
  const cls = known ? STATE[state] : "";
  const label = known ? t(`state.${state}`) : (state ?? t("common.unknown"));
  return `<span class="badge ${cls}"><span class="dot"></span>${esc(label)}</span>`;
}

export function usageBar(label, percent, right, extra = "") {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const lvl = p >= 90 ? "crit" : p >= 75 ? "warn" : extra;
  return `<div class="usage-cell"><div class="bar-label"><span>${esc(label)}</span><span>${esc(right)}</span></div><div class="bar ${lvl}"><span style="width:${p}%"></span></div></div>`;
}

export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
/** Client-side name validation. `what` is a label key (label.*). */
export const nameError = (v, what = "name") => {
  const label = t(`label.${what}`);
  if (!v) return t("ui.nameRequired", { what: lang === "en" ? label.charAt(0).toLowerCase() + label.slice(1) : label });
  return NAME_RE.test(v) ? "" : t("ui.nameInvalid", { what: label });
};
