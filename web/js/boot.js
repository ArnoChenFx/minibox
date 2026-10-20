// Classic script loaded in <head>, so it runs before the first paint and the page never flashes the wrong theme.
(() => {
  let theme = localStorage.getItem("minibox.theme");
  if (theme !== "light" && theme !== "dark") {
    theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.dataset.theme = theme;
})();

(() => {
  let lang = localStorage.getItem("minibox.lang");
  if (lang !== "en" && lang !== "zh-CN") lang = /^zh/i.test(navigator.language || "") ? "zh-CN" : "en";
  document.documentElement.lang = lang;
})();
