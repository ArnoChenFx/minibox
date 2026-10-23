import { api } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { pct, cpus, gbOrMb, mem, duration, dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { usageBar } from "../lib/ui.js";
import { mountsCard } from "./box-volumes.js";
import { mountEgressCard } from "./egress-card.js";
import { mountEnvCard } from "./env-card.js";
import { mountStartupCard } from "./startup-card.js";

function joined(names, translate) {
  return esc((names ?? []).map((name) => (translate ? t(`reset.${name}`) : name)).join(t("reset.sep")));
}

function specBanners(box) {
  const parts = [];
  const recovery = box.recovery;
  if (recovery?.needsReset?.length) {
    const fields = joined(recovery.needsReset, true);
    const degraded = recovery.source === "degraded";
    const title = degraded ? t("bd.degradedTitle") : t("bd.claimTitle");
    const text = degraded ? t("bd.degradedText", { fields }) : t("bd.claimText", { fields });
    parts.push(
      `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span><strong>${title}</strong> ${text}</span></div>`,
    );
  }
  if (box.storage?.status === "unreachable") {
    const pools = (box.storage.pools ?? [])
      .filter((pool) => pool.status === "unreachable")
      .map((pool) => pool.name)
      .join(", ");
    parts.push(
      `<div class="callout danger" style="margin-bottom:16px">${icon("alert")}<span><strong>${t("vol.unreachable")}</strong> ${t("vol.storageUnreachable", { pools: esc(pools) })}</span></div>`,
    );
  }
  if (box.drift?.length) {
    const fields = joined(
      box.drift.map((item) => item.field),
      false,
    );
    parts.push(
      `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span><strong>${t("bd.driftTitle")}</strong> ${t("bd.driftText", { fields })}</span></div>`,
    );
  }
  return parts.join("");
}

export function mountOverview(root, { box, onChange }) {
  root.innerHTML = `<div id="ovMain"></div><div id="ovEgress"></div><div id="ovEnv"></div><div id="ovStartup"></div><div id="ovMounts"></div>`;
  const egress = mountEgressCard(root.querySelector("#ovEgress"), { box });
  const env = mountEnvCard(root.querySelector("#ovEnv"), { box });
  const startup = mountStartupCard(root.querySelector("#ovStartup"), { box });
  let volumes = new Map();
  let open = true;
  const draw = () => {
    const b = box();
    const s = b.stats;
    root.querySelector("#ovMain").innerHTML = `
        ${specBanners(b)}
        <div class="grid grid-3">
          <div class="card metric"><div class="metric-top"><span>CPU</span>${icon("cpu")}</div>
            <div class="metric-value">${s ? pct(s.cpuPercent) : "—"}<small>${t("bd.quota", { v: cpus(b.cpus) })}</small></div>
            <div style="margin-top:auto">${s ? usageBar(t("bd.relQuota"), b.cpus ? s.cpuPercent / b.cpus : s.cpuPercent, b.cpus ? pct(s.cpuPercent / b.cpus, 0) : "") : `<span class="subtle">${t("bd.notRunning")}</span>`}</div></div>
          <div class="card metric"><div class="metric-top"><span>${t("ov.memory")}</span>${icon("memory")}</div>
            <div class="metric-value">${s ? gbOrMb(s.memUsage) : "—"}<small>${t("bd.quota", { v: mem(b.memory) })}</small></div>
            <div style="margin-top:auto">${s ? usageBar(t("bd.relQuota"), s.memPercent, pct(s.memPercent, 0), "mem") : `<span class="subtle">${t("bd.notRunning")}</span>`}</div></div>
          <div class="card metric"><div class="metric-top"><span>${t("bd.uptime")}</span>${icon("clock")}</div>
            <div class="metric-value" style="font-size:20px">${b.running && b.startedAt ? duration((Date.now() - new Date(b.startedAt).getTime()) / 1000) : t("bd.stopped")}</div>
            <div class="metric-sub">${b.startedAt ? t("bd.lastStarted", { t: dateTime(b.startedAt) }) : t("bd.neverStarted")}</div></div>
        </div>
        <div class="card" style="margin-top:16px"><div class="card-head"><h3>${t("bd.info")}</h3></div><div class="card-body"><dl class="kv">
          <dt>${t("bd.name")}</dt><dd>${esc(b.name)}</dd>
          <dt>${t("bd.boxId")}</dt><dd class="mono">${esc(b.boxId || "—")}</dd>
          <dt>${t("bd.revision")}</dt><dd>${esc(String(b.revision ?? "—"))}</dd>
          <dt>${t("bd.desired")}</dt><dd>${b.desired === "stopped" ? t("bd.desiredStopped") : t("bd.desiredRunning")}</dd>
          <dt>${t("bd.sleeping")}</dt><dd>${b.sleeping ? t("bd.sleepingYes") : t("bd.sleepingNo")}${b.stopReason ? ` <span class="subtle">(${esc(t(`bd.stopReason.${b.stopReason}`))})</span>` : ""}</dd>
          <dt>${t("bd.lastActivity")}</dt><dd>${b.lastActivityAt ? dateTime(b.lastActivityAt) : t("bd.lastActivityUnknown")}</dd>
          <dt>${t("bd.idleTimeout")}</dt><dd>${b.idleTimeoutSec === 0 ? t("bd.idleNever") : b.idleTimeoutSec != null ? t("bd.seconds", { n: b.idleTimeoutSec }) : t("bd.idleInherit")}</dd>
          <dt>${t("bd.ttl")}</dt><dd>${b.ttlSec != null ? t("bd.seconds", { n: b.ttlSec }) : t("bd.ttlNone")}</dd>
          <dt>${t("bd.createdBy")}</dt><dd>${b.createdBy ? esc(b.createdBy) : t("bd.createdByUnknown")}</dd>
          <dt>${t("bd.containerId")}</dt><dd class="mono">${esc(b.id)}</dd>
          <dt>${t("bd.image")}</dt><dd class="mono">${esc(b.image)}</dd>
          <dt>${t("bd.template")}</dt><dd class="mono">${esc(b.template || "—")}</dd>
          <dt>${t("bd.profile")}</dt><dd>${b.profile ? t(`profile.${b.profile}`) : t("bd.profileLegacy")}</dd>
          <dt>${t("bd.network")}</dt><dd class="mono">${esc(b.network)}</dd>
          <dt>${t("bd.tools")}</dt><dd>${(b.tools ?? []).length ? esc((b.tools ?? []).map((item) => item.id).join(", ")) : t("bd.toolsNone")}</dd>
          <dt>${t("bd.workspace")}</dt><dd><span class="mono">/workspace</span> <span class="subtle">${t("bd.volume")}</span> <span class="mono">${esc(b.volume || "—")}</span></dd>
          <dt>${t("bd.created")}</dt><dd>${dateTime(b.createdAt)}</dd>
          <dt>${t("bd.cli")}</dt><dd><code>docker exec -it ${esc(b.containerName || `minibox-${b.name}`)} bash</code></dd>
        </dl></div></div>`;
    root.querySelector("#ovMounts").innerHTML = mountsCard(b, volumes);
  };
  draw();
  api("/api/volumes")
    .then(({ volumes: listed }) => {
      if (!open) return;
      volumes = new Map(listed.map((volume) => [volume.id, volume]));
      draw();
    })
    .catch(() => undefined);
  const off = onChange(() => {
    draw();
    egress.onBoxChange();
    env.onBoxChange();
    startup.onBoxChange();
  });
  return () => {
    open = false;
    off();
    egress.dispose();
    env.dispose();
    startup.dispose();
  };
}
