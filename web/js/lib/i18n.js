import en from "../i18n/en.js";
import zh from "../i18n/zh-CN.js";

/** Tiny i18n layer: flat dictionaries, `{name}` interpolation, language persisted in localStorage. */
const DICTS = { en, "zh-CN": zh };
export const LANGS = [
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
];
const KEY = "minibox.lang";

function detect() {
  const saved = localStorage.getItem(KEY);
  if (saved && DICTS[saved]) return saved;
  const nav = (navigator.languages?.[0] ?? navigator.language ?? "en").toLowerCase();
  return nav.startsWith("zh") ? "zh-CN" : "en";
}

export const lang = detect();
const dict = DICTS[lang];
document.documentElement.lang = lang;

/** Translate `key`, replacing `{param}` placeholders. Falls back to English, then to the key itself. */
export function t(key, params) {
  const s = dict[key] ?? en[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => params[k] ?? m) : s;
}

/** Whether a key exists (used to translate optional server-provided keys). */
export const has = (key) => key in dict || key in en;

export function setLang(next) {
  if (!DICTS[next] || next === lang) return;
  localStorage.setItem(KEY, next);
  location.reload();
}

/**
 * Translate static markup:
 *   data-i18n="key"            → textContent
 *   data-i18n-html="key"       → innerHTML (trusted dictionary strings only)
 *   data-i18n-attr="attr:key;attr2:key2"
 */
export function applyI18n(root = document) {
  for (const n of root.querySelectorAll("[data-i18n]")) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll("[data-i18n-html]")) n.innerHTML = t(n.dataset.i18nHtml);
  for (const n of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of n.dataset.i18nAttr.split(";")) {
      const [attr, key] = pair.split(":");
      if (attr && key) n.setAttribute(attr.trim(), t(key.trim()));
    }
  }
}

/** A compact language <select>; switching reloads the page. */
export function langSelect(id = "langSelect") {
  return `<select class="select lang-select" id="${id}" aria-label="${t("common.language")}">${LANGS.map(
    (l) => `<option value="${l.id}"${l.id === lang ? " selected" : ""}>${l.label}</option>`,
  ).join("")}</select>`;
}

export function bindLangSelect(el) {
  el?.addEventListener("change", (e) => setLang(e.target.value));
}
