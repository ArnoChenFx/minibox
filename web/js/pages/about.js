import { api } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime } from "../lib/format.js";
import { lang, t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { onHost } from "../lib/store.js";
import { currentTheme } from "../lib/theme.js";

const REPO = "https://github.com/ArnoChenFx/minibox";

function projectLinks() {
  const readme = lang === "zh-CN" ? "README-zh.md" : "README.md";
  const docs = lang === "zh-CN" ? "docs/zh-CN/README.md" : "docs/README.md";
  return [
    { icon: "bookOpen", label: t("about.readme"), meta: t("about.readmeMeta"), href: `${REPO}/blob/main/${readme}` },
    { icon: "folder", label: t("about.docs"), meta: t("about.docsMeta"), href: `${REPO}/blob/main/${docs}` },
    {
      icon: "history",
      label: t("about.changelog"),
      meta: t("about.changelogMeta"),
      href: `${REPO}/blob/main/CHANGELOG.md`,
    },
    { icon: "bug", label: t("about.issues"), meta: t("about.issuesMeta"), href: `${REPO}/issues` },
    { icon: "scale", label: t("about.license"), meta: t("about.licenseMeta"), href: `${REPO}/blob/main/LICENSE` },
  ];
}

function dockerLabel(host) {
  if (!host) return t("common.loading");
  return host.docker.available && host.docker.version ? host.docker.version : t("ov.unavailable");
}

export function render(view) {
  const links = projectLinks()
    .map(
      (l) => `<li><a href="${esc(l.href)}" target="_blank" rel="noopener">
        <span class="ico">${icon(l.icon)}</span>
        <span class="meta"><strong>${esc(l.label)}</strong><span class="subtle">${esc(l.meta)}</span></span>
        ${icon("externalLink", "external")}</a></li>`,
    )
    .join("");
  view.innerHTML = `
    <div class="page-head"><div><h1>${t("nav.about")}</h1><p>${t("about.subtitle")}</p></div></div>
    <div class="grid grid-2">
      <div class="stack">
        <div class="card about-hero">
          <img data-logo src="/assets/${currentTheme() === "dark" ? "logo-dark" : "logo"}.svg" alt="MiniBox" />
          <p class="muted">${t("common.tagline")}</p>
          <a class="btn btn-sm" href="${REPO}" target="_blank" rel="noopener">${icon("github")}GitHub</a>
        </div>
        <div class="card">
          <div class="card-head"><h3>${t("about.versionRuntime")}</h3>${icon("server")}</div>
          <div class="card-body" id="abRuntime"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>
        </div>
      </div>
      <div class="card about-links">
        <div class="card-head"><h3>${t("about.links")}</h3></div>
        <ul class="link-list">${links}</ul>
      </div>
    </div>`;

  let host = null;
  const paintDocker = () => {
    const el = view.querySelector("#abDocker");
    if (el) el.textContent = dockerLabel(host);
  };
  const off = onHost((h) => {
    host = h;
    paintDocker();
  });

  api("/api/system")
    .then((s) => {
      view.querySelector("#abRuntime").innerHTML = `<dl class="kv">
        <dt>${t("about.version")}</dt><dd class="mono">v${esc(s.version)}</dd>
        <dt>${t("about.started")}</dt><dd>${esc(dateTime(s.startedAt))}</dd>
        <dt>${t("about.runtime")}</dt><dd class="mono">${esc(s.runtime)}</dd>
        <dt>${t("about.docker")}</dt><dd class="mono" id="abDocker"></dd>
      </dl>`;
      paintDocker();
    })
    .catch((e) => {
      view.querySelector("#abRuntime").innerHTML =
        `<div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div>`;
    });

  return () => off();
}
