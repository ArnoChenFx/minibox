const KEY = "minibox.theme";

export function currentTheme() {
  const saved = localStorage.getItem(KEY);
  if (saved === "light" || saved === "dark") return saved;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme = currentTheme()) {
  document.documentElement.dataset.theme = theme;
  for (const img of document.querySelectorAll("img[data-logo]")) {
    img.src = theme === "dark" ? "/assets/logo-dark.svg" : "/assets/logo.svg";
  }
  document.dispatchEvent(new CustomEvent("themechange", { detail: theme }));
}

export function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(KEY, next);
  applyTheme(next);
  return next;
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!localStorage.getItem(KEY)) applyTheme();
});
