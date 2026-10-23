import { esc } from "../lib/dom.js";
import { pct, cpus, gbOrMb, mem, duration, dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { usageBar } from "../lib/ui.js";
import { mountAgentCard } from "./box-agent.js";

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
    parts.push(`<div class="callout warn">${icon("alert")}<span><strong>${title}</strong> ${text}</span></div>`);
  }
  if (box.storage?.status === "unreachable") {
    const pools = (box.storage.pools ?? [])
      .filter((pool) => pool.status === "unreachable")
      .map((pool) => pool.name)
      .join(", ");
    parts.push(
      `<div class="callout danger">${icon("alert")}<span><strong>${t("vol.unreachable")}</strong> ${t("vol.storageUnreachable", { pools: esc(pools) })}</span></div>`,
    );
  }
  if (box.drift?.length) {
    const fields = joined(
      box.drift.map((item) => item.field),
      false,
    );
    parts.push(
      `<div class="callout warn">${icon("alert")}<span><strong>${t("bd.driftTitle")}</strong> ${t("bd.driftText", { fields })}</span></div>`,
    );
  }
  return parts.join("");
}

/**
 * The overview tab: the box's banners, its CPU, memory and uptime, and what identifies it. The agent card shows when the
 * box has a self token or its agent has asked questions. Egress, environment, startup, mounts and lifecycle live in the
 * settings tab.
 */
export function mountOverview(root, { box, onChange }) {
  root.innerHTML = `<div class="box-stack"><div id="ovMain" class="box-stack"></div><div id="ovAgent"></div></div>`;
  const agent = mountAgentCard(root.querySelector("#ovAgent"), { box });
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
        <div class="card"><div class="card-head"><h3>${t("bd.info")}</h3></div><div class="card-body"><div class="kv-cols">
          <dl class="kv">
            <dt>${t("bd.name")}</dt><dd>${esc(b.name)}</dd>
            <dt>${t("bd.boxId")}</dt><dd class="mono">${esc(b.boxId || "—")}</dd>
            <dt>${t("bd.revision")}</dt><dd>${esc(String(b.revision ?? "—"))}</dd>
            <dt>${t("bd.containerId")}</dt><dd class="mono">${esc(b.id)}</dd>
            <dt>${t("bd.image")}</dt><dd class="mono">${esc(b.image)}</dd>
            <dt>${t("bd.network")}</dt><dd class="mono">${esc(b.network)}</dd>
          </dl>
          <dl class="kv">
            <dt>${t("bd.template")}</dt><dd class="mono">${esc(b.template || "—")}</dd>
            <dt>${t("bd.tools")}</dt><dd>${(b.tools ?? []).length ? esc((b.tools ?? []).map((item) => item.id).join(", ")) : t("bd.toolsNone")}</dd>
            <dt>${t("bd.workspace")}</dt><dd><span class="mono">/workspace</span> <span class="subtle">${t("bd.volume")}</span> <span class="mono">${esc(b.volume || "—")}</span></dd>
            <dt>${t("bd.createdBy")}</dt><dd>${b.createdBy ? esc(b.createdBy) : t("bd.createdByUnknown")}</dd>
            <dt>${t("bd.created")}</dt><dd>${dateTime(b.createdAt)}</dd>
            <dt>${t("bd.cli")}</dt><dd><code>docker exec -it ${esc(b.containerName || `minibox-${b.name}`)} bash</code></dd>
          </dl>
        </div></div></div>`;
  };
  draw();
  const off = onChange(() => {
    draw();
    agent.onBoxChange();
  });
  return () => {
    off();
    agent.dispose();
  };
}
