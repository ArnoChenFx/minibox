import { api } from "./lib/api.js";
import { $ } from "./lib/dom.js";
import { applyI18n, bindLangSelect, langSelect, t } from "./lib/i18n.js";
import { icon } from "./lib/icons.js";
import { applyTheme, currentTheme, toggleTheme } from "./lib/theme.js";

applyI18n();
document.title = t("login.title");
$("#loginLang").innerHTML = langSelect("loginLangSelect");
bindLangSelect($("#loginLangSelect"));

for (const n of document.querySelectorAll("[data-icon]")) {
  if (n.tagName === "LI") n.insertAdjacentHTML("afterbegin", icon(n.dataset.icon));
  else n.outerHTML = icon(n.dataset.icon);
}
const renderTheme = () => ($("#themeBtn").innerHTML = icon(currentTheme() === "dark" ? "sun" : "moon"));
applyTheme();
renderTheme();
$("#themeBtn").addEventListener("click", () => {
  toggleTheme();
  renderTheme();
});

const form = $("#loginForm");
const input = $("#key");
const err = $("#err");
const btn = $("#submit");

input.addEventListener("input", () => {
  input.classList.remove("invalid");
  err.textContent = "";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = input.value.trim();
  if (!key) {
    input.classList.add("invalid");
    err.textContent = t("login.keyRequired");
    input.focus();
    return;
  }
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${t("login.verifying")}`;
  try {
    await api("/api/auth/login", { method: "POST", body: { key } });
    location.replace("/");
  } catch (ex) {
    input.classList.add("invalid");
    err.textContent = ex.message;
    btn.disabled = false;
    btn.textContent = t("login.submit");
    input.select();
  }
});
