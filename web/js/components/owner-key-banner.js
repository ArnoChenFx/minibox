import { api } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { ownerKeyNotice } from "../lib/owner-key.js";

const POLL_MS = 60_000;

/**
 * Shows above every page while an agent uses the owner access key on /mcp, so the owner can move the agent to an agent
 * token. It reads `/api/system` on a timer, and redraws only when the notice changes, so the link is not rebuilt each
 * minute.
 */
export function mountOwnerKeyBanner(root) {
  if (!root) return;
  let shown = "";
  const show = (system) => {
    const outcome = ownerKeyNotice(system);
    const key = outcome ? `${outcome} ${system.mcpOwnerKey.lastUsedAt}` : "";
    if (key === shown) return;
    shown = key;
    root.hidden = outcome === null;
    if (outcome === null) {
      root.innerHTML = "";
      return;
    }
    const time = dateTime(system.mcpOwnerKey.lastUsedAt);
    const text = outcome === "refused" ? t("shell.ownerKeyRefused", { time }) : t("shell.ownerKeyAccepted", { time });
    root.innerHTML = `<div class="callout warn">${icon("alert")}<span>${esc(text)} <a href="#/settings/tokens">${esc(t("shell.ownerKeyAction"))}</a></span></div>`;
  };
  const refresh = () =>
    api("/api/system")
      .then(show)
      .catch(() => {});
  void refresh();
  setInterval(refresh, POLL_MS);
}
