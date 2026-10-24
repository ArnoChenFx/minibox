import { api } from "./lib/api.js";
import { $ } from "./lib/dom.js";
import { applyI18n, bindLangButton, t } from "./lib/i18n.js";
import { icon } from "./lib/icons.js";
import { applyTheme, currentTheme, toggleTheme } from "./lib/theme.js";

applyI18n();
document.title = t("login.title");
bindLangButton($("#langBtn"), icon);

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
const username = $("#username");
const input = $("#key");
const err = $("#err");
const btn = $("#submit");

input.addEventListener("input", () => {
  input.classList.remove("invalid");
  err.textContent = "";
});

/** Chromium's Credential Management API saves the login without waiting for a page load. Others save from the form. */
async function offerToSave(id, password) {
  if (!("PasswordCredential" in window) || !navigator.credentials?.store) return;
  try {
    const credential = new PasswordCredential({ id, password, name: "MiniBox" });
    await Promise.race([navigator.credentials.store(credential), new Promise((resolve) => setTimeout(resolve, 1500))]);
  } catch {
    // Saving is a convenience. A refusal must not stop the sign-in.
  }
}

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
    input.value = key;
    await offerToSave(username.value || "minibox", key);
    // A password manager treats a login as done when the form leaves the page. Without this the fetch above looks like
    // nothing happened and Chrome, Edge and Safari never ask to save.
    form.remove();
    location.replace("/");
  } catch (ex) {
    input.classList.add("invalid");
    err.textContent = ex.message;
    btn.disabled = false;
    btn.textContent = t("login.submit");
    input.select();
  }
});
