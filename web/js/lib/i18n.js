import en from "../i18n/en.js";
import zh from "../i18n/zh-CN.js";

/** Tiny i18n layer: flat dictionaries, `{name}` interpolation, language persisted in localStorage. */
const DICTS = { en, "zh-CN": zh };
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

/** The other language (two are supported, so the switch is a simple toggle). */
export const nextLang = () => (lang === "en" ? "zh-CN" : "en");

/** Wire an icon button to toggle the UI language; its tooltip names the target language. */
export function bindLangButton(btn, icon) {
  if (!btn) return;
  const label = t("shell.switchLang");
  btn.innerHTML = icon("languages");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.addEventListener("click", () => setLang(nextLang()));
}
