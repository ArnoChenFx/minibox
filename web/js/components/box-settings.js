import { BOX_SETTINGS, boxSettingsOf } from "../lib/box-settings.js";
import { esc, revealInStrip } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { boxHash } from "../lib/routes.js";
import { mountResources } from "./box-resources.js";
import { mountSecurityCard } from "./box-security-card.js";
import { mountTemplateCard } from "./box-template-card.js";
import { mountTools } from "./box-tools.js";
import { mountMounts } from "./box-volumes.js";
import { mountCheckpoints } from "./checkpoints.js";
import { mountEgressCard } from "./egress-card.js";
import { mountEnvCard } from "./env-card.js";
import { mountLifecycleCard } from "./lifecycle-card.js";
import { mountStagedBanner } from "./staged-changes.js";
import { mountStartupCard } from "./startup-card.js";

/** A card that answers box changes through its own `onBoxChange` and is disposed with the section. */
function withBoxChanges(card, onChange) {
  const off = onChange(() => card.onBoxChange());
  return () => {
    off();
    card.dispose();
  };
}

/**
 * The startup command and the idle timeout and TTL. The startup card keeps its own state, so the section forwards each box
 * change to it; the lifecycle card redraws itself and reads the box again once it saves.
 */
function lifecycleSection(panel, { box, onChange, refreshBox }) {
  panel.innerHTML = `<div id="bsStartup"></div><div id="bsLifecycle"></div>`;
  const startup = mountStartupCard(panel.querySelector("#bsStartup"), { box });
  const lifecycle = mountLifecycleCard(panel.querySelector("#bsLifecycle"), { box, refreshBox });
  const off = onChange(() => {
    lifecycle.onBoxChange();
    startup.onBoxChange();
  });
  return () => {
    off();
    lifecycle.dispose();
    startup.dispose();
  };
}

/**
 * The security section: the template the box runs, its network egress and its security profile. All three are rebuild
 * settings, so each card stages its change and the banner above the settings applies them together.
 */
function securitySection(panel, { box, onChange }) {
  panel.innerHTML = `<div id="bsTemplate"></div><div id="bsEgress"></div><div id="bsSecurity"></div>`;
  const template = mountTemplateCard(panel.querySelector("#bsTemplate"), { box });
  const egress = mountEgressCard(panel.querySelector("#bsEgress"), { box });
  const security = mountSecurityCard(panel.querySelector("#bsSecurity"), { box });
  const off = onChange(() => {
    template.onBoxChange();
    egress.onBoxChange();
    security.onBoxChange();
  });
  return () => {
    off();
    template.dispose();
    egress.dispose();
    security.dispose();
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
