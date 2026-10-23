import { BOX_SETTINGS, boxSettingsOf } from "../lib/box-settings.js";
import { esc, revealInStrip } from "../lib/dom.js";
import { dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { boxHash } from "../lib/routes.js";
import { mountResources } from "./box-resources.js";
import { mountTools } from "./box-tools.js";
import { mountMounts } from "./box-volumes.js";
import { mountCheckpoints } from "./checkpoints.js";
import { mountEgressCard } from "./egress-card.js";
import { mountEnvCard } from "./env-card.js";
import { mountStagedBanner } from "./staged-changes.js";
import { mountStartupCard } from "./startup-card.js";

function kvCard(title, rows) {
  return `<div class="card"><div class="card-head"><h3>${esc(title)}</h3></div><div class="card-body"><dl class="kv">${rows}</dl></div></div>`;
}

function lifecycleRows(b) {
  return `<dt>${t("bd.desired")}</dt><dd>${b.desired === "stopped" ? t("bd.desiredStopped") : t("bd.desiredRunning")}</dd>
    <dt>${t("bd.sleeping")}</dt><dd>${b.sleeping ? t("bd.sleepingYes") : t("bd.sleepingNo")}${b.stopReason ? ` <span class="subtle">(${esc(t(`bd.stopReason.${b.stopReason}`))})</span>` : ""}</dd>
    <dt>${t("bd.lastActivity")}</dt><dd>${b.lastActivityAt ? dateTime(b.lastActivityAt) : t("bd.lastActivityUnknown")}</dd>
    <dt>${t("bd.idleTimeout")}</dt><dd>${b.idleTimeoutSec === 0 ? t("bd.idleNever") : b.idleTimeoutSec != null ? t("bd.seconds", { n: b.idleTimeoutSec }) : t("bd.idleInherit")}</dd>
    <dt>${t("bd.ttl")}</dt><dd>${b.ttlSec != null ? t("bd.seconds", { n: b.ttlSec }) : t("bd.ttlNone")}</dd>`;
}

function securityRows(b) {
  return `<dt>${t("bd.profile")}</dt><dd>${b.profile ? t(`profile.${b.profile}`) : t("bd.profileLegacy")}</dd>
    <dt>${t("bd.selfToken")}</dt><dd>${b.selfToken ? t("bd.selfTokenOn") : t("bd.selfTokenOff")}</dd>`;
}

/** A card that answers box changes through its own `onBoxChange` and is disposed with the section. */
function withBoxChanges(card, onChange) {
  const off = onChange(() => card.onBoxChange());
  return () => {
    off();
    card.dispose();
  };
}

function lifecycleSection(panel, { box, onChange }) {
  panel.innerHTML = `<div id="bsStartup"></div><div id="bsLifecycle"></div>`;
  const startup = mountStartupCard(panel.querySelector("#bsStartup"), { box });
  const draw = () => {
    panel.querySelector("#bsLifecycle").innerHTML = kvCard(t("bd.setLifecycle"), lifecycleRows(box()));
  };
  draw();
  const off = onChange(() => {
    draw();
    startup.onBoxChange();
  });
  return () => {
    off();
    startup.dispose();
  };
}

function securitySection(panel, { box, onChange }) {
  panel.innerHTML = `<div id="bsEgress"></div><div id="bsSecurity"></div>`;
  const egress = mountEgressCard(panel.querySelector("#bsEgress"), { box });
  const draw = () => {
    panel.querySelector("#bsSecurity").innerHTML = kvCard(t("bd.setSecurity"), securityRows(box()));
  };
  draw();
  const off = onChange(() => {
    draw();
    egress.onBoxChange();
  });
  return () => {
    off();
    egress.dispose();
  };
}

/** Each section mounts into the panel and returns its cleanup. Only the section the address names is mounted. */
const SECTIONS = {
  resources: (panel, { box, history, onChange }) => mountResources(panel, { box, history, onChange }),
  storage: (panel, { box, onChange }) => mountMounts(panel, { box, onChange }),
  tools: (panel, { box, refreshBox }) => mountTools(panel, { box, refreshBox }),
  env: (panel, { box, onChange }) => withBoxChanges(mountEnvCard(panel, { box }), onChange),
  lifecycle: lifecycleSection,
  security: securitySection,
  checkpoints: (panel, { box, refreshBox }) => mountCheckpoints(panel, { box, refreshBox }),
};

function navLink(id, item, activeId) {
  const current = item.id === activeId ? ' aria-current="page"' : "";
  return `<a href="${boxHash(id, "settings", item.id)}"${current}>${esc(t(item.label))}</a>`;
}

/**
 * The settings tab of a box: a sub-nav beside the one section the address names. A section that is not named falls back
 * to the first, as the settings page does. Above the section, a banner shows the changes staged for the next rebuild,
 * whichever section staged them. Returns the cleanup that the page calls when the tab closes.
 */
export function mountBoxSettings(root, { box, section, history, onChange, refreshBox }) {
  const active = boxSettingsOf(section);
  root.innerHTML = `<div class="settings box-settings">
    <nav class="settings-nav" aria-label="${esc(t("bd.setNav"))}">${BOX_SETTINGS.map((item) => navLink(box().id, item, active.id)).join("")}</nav>
    <div class="settings-panel box-stack">
      <div id="bsStaged" hidden></div>
      <div class="box-stack" id="bsPanel"></div>
    </div>
  </div>`;
  const nav = root.querySelector(".settings-nav");
  revealInStrip(nav, nav.querySelector('[aria-current="page"]'));
  const banner = mountStagedBanner(root.querySelector("#bsStaged"), { box });
  const offBanner = onChange(() => banner.onBoxChange());
  const cleanup = SECTIONS[active.id](root.querySelector("#bsPanel"), { box, history, onChange, refreshBox });
  return () => {
    offBanner();
    banner.dispose();
    cleanup?.();
  };
}
