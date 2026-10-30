import { api, enc } from "../lib/api.js";
import { esc, copyText } from "../lib/dom.js";
import { bytes, cpus, mem, relTime } from "../lib/format.js";
import { diskReading } from "../lib/host-disk.js";
import { HOST_BADGE, accessWarningShown, agentState, forceRemoveShown, hostLabel } from "../lib/host-list.js";
import { refreshHosts } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { openDialog, toast, toastError, confirmDialog } from "../lib/ui.js";
import { bindToggles, limitList } from "./list-toggle.js";
import {
  pairingView,
  watchAgent,
  expiredLine,
  schemeOf,
  withBusyHost,
  testHost,
  trustHostKey,
  hostBody,
} from "./settings-host-form.js";

export async function loadHosts(view) {
  const card = view.querySelector("#stHosts");
  let hosts;
  try {
    ({ hosts } = await api("/api/hosts"));
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.hosts")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  // Share pending and completed reads across redraws. A newly revealed host is read once; existing rows reuse theirs.
  const readings = new Map();
  const readDisk = (id) => {
    if (!readings.has(id))
      readings.set(
        id,
        api(`/api/hosts/${enc(id)}/disk`).catch(() => null),
      );
    return readings.get(id);
  };
  drawHosts(view, card, { hosts, readDisk });
}

/**
 * What each host's engine holds, read after the card is drawn so the table never waits on it. Only the rows the card
 * shows are asked for, each at once, and each answer stands on its own: one host that does not answer leaves its own
 * line empty and the others shown. Each line is the one the drawing made, so a redraw that happens while a read is in
 * flight is not written into by the older answer.
 */
async function loadDisk(lines, hosts, readDisk) {
  await Promise.all(
    hosts.map(async (host, index) => {
      const disk = await readDisk(host.id);
      const line = lines[index];
      if (line) line.innerHTML = diskLines(disk);
    }),
  );
}

/**
 * Draws the cached host list. Disk reads are shared across draws, including a read still in flight during a toggle.
 */
function drawHosts(view, card, { hosts, readDisk }) {
  const { shown, toggle } = limitList(view, "hosts", hosts);
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.hosts")}</h3><p class="help">${t("st.hostsHelp")}</p></div>
      <button class="btn btn-sm btn-primary" id="stHostAdd">${icon("plus")}${t("st.hostAdd")}</button>
    </div>
    ${accessWarningShown(hosts) ? `<div class="card-body"><div class="callout warn">${icon("alert")}<span>${esc(t("st.hostAccessWarn"))}</span></div></div>` : ""}
    <div class="table-wrap"><table class="table host-table">
      <thead><tr>
        <th>${t("st.hostColName")}</th><th class="hide-sm">${t("st.hostColEndpoint")}</th><th>${t("st.hostColStatus")}</th>
        <th class="hide-sm">${t("st.hostColCapacity")}</th><th class="hide-sm">${t("st.hostColBoxes")}</th><th></th>
      </tr></thead>
      <tbody>${shown.map((host) => hostRow(host, hosts)).join("")}</tbody>
    </table></div>
    <div class="list-more">${toggle}</div>`;
  card.querySelector("#stHostAdd").addEventListener("click", () => addHost(view));
  card.querySelectorAll("[data-remove-host]").forEach((btn) => {
    btn.addEventListener("click", () =>
      removeHost(view, btn.dataset.removeHost, btn.dataset.hostName, btn.dataset.hostAgent === "true"),
    );
  });
  card.querySelectorAll("[data-force-remove-host]").forEach((btn) => {
    btn.addEventListener("click", () =>
      forceRemoveHost(view, btn.dataset.forceRemoveHost, btn.dataset.hostName, btn.dataset.hostAgent === "true"),
    );
  });
  bindToggles(view, card, () => drawHosts(view, card, { hosts, readDisk }));
  const lines = shown.map((host) => card.querySelector(`[data-disk-host="${host.id}"]`));
  void loadDisk(lines, shown, readDisk);
  return shown;
}

function hostRow(host, hosts) {
  const capacity = host.capacity
    ? `${cpus(host.capacity.cpus)} · ${mem(host.capacity.memoryBytes)}`
    : t("common.unknown");
  const latency = host.latencyMs == null ? "" : ` <span class="subtle">${host.latencyMs} ms</span>`;
  const error = host.error ? `<div class="help" title="${esc(host.error)}">${esc(host.error)}</div>` : "";
  const endpoint = host.agent
    ? `<span class="subtle">${esc(t("st.agentEndpoint"))}</span> <span class="badge">${esc(t("st.transport.agent"))}</span>`
    : `<span class="mono">${esc(host.endpoint)}</span> <span class="badge">${esc(t(`st.transport.${host.transport}`))}</span>`;
  const agent = host.agent ? agentDetails(host.agent) : "";
  const labels = hostLabelsLine(host.labels);
  return `<tr>
    <td><strong>${esc(host.name)}</strong> <span class="subtle mono">${esc(host.id)}</span>${labels}</td>
    <td class="hide-sm host-endpoint">${endpoint}</td>
    <td><span class="badge ${HOST_BADGE[host.status] ?? ""}"><span class="dot"></span>${esc(t(`st.hostStatus.${host.status}`))}</span>${latency}${error}${agent}</td>
    <td class="hide-sm nowrap">${capacity}</td>
    <td class="hide-sm">${host.boxes}</td>
    <td><div class="actions">${hostActions(host, hosts)}</div></td>
  </tr>
  <tr class="host-disk-row">
    <td colspan="6" data-disk-host="${esc(host.id)}">${diskLines(null)}</td>
  </tr>`;
}

/**
 * One host's engine storage, under its row: the bytes each class `docker system df` counts takes, with the share a
 * removal would free. A host with no reading, which is every host until its answer arrives, says why in one line.
 */
function diskLines(disk) {
  const reading = diskReading(disk, bytes);
  if (reading.reason) {
    return `<div class="help host-disk-note">${icon("disk")}<span>${esc(t(reading.reason.key, reading.reason.params))}</span></div>`;
  }
  const rows = reading.rows
    .map(
      (row) => `<div class="host-disk-class">
        <span class="host-disk-label">${esc(t(row.label))}${row.count == null ? "" : ` <span class="subtle">${esc(t("st.disk.count", { n: row.count, active: row.activeCount ?? "?" }))}</span>`}</span>
        <span class="mono">${esc(row.total)}</span>
        <span class="subtle">${row.reclaimable == null ? t("st.disk.reclaimableUnknown") : esc(t("st.disk.reclaimable", { n: row.reclaimable, pct: row.reclaimablePercent }))}</span>
      </div>`,
    )
    .join("");
  return `<div class="host-disk" aria-label="${esc(t("st.disk.title"))}">${rows}</div>`;
}

/** The labels a host carries, under its name. A host with none shows nothing, so the table keeps its old shape. */
function hostLabelsLine(labels) {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) return "";
  const badges = entries
    .map(([key, value]) => `<span class="badge">${esc(value === "" ? key : `${key}=${value}`)}</span>`)
    .join(" ");
  return `<div class="help mono">${badges}</div>`;
}

/**
 * A host's remove button, for an agent host too: removing one revokes its agent first. It carries the host's label for
 * its confirm dialog and toast, so a name two hosts share is asked about with its id, and the operator can tell which of
 * them goes.
 */
function hostActions(host, hosts) {
  if (host.transport === "local") return `<span class="subtle">${t("st.hostLocal")}</span>`;
  const label = hostLabel(host, hosts);
  const remove = `<button class="btn btn-sm btn-danger" data-remove-host="${esc(host.id)}" data-host-name="${esc(label)}" data-host-agent="${host.agent ? "true" : "false"}">${icon("x")}${t("st.hostRemove")}</button>`;
  // Only an offline host can have been lost. The ordinary removal still answers first: it works when nothing is left,
  // and its 409 names what holds it, which is the moment the force path is meant for.
  if (!forceRemoveShown(host)) return remove;
  const force = `<button class="btn btn-sm" data-force-remove-host="${esc(host.id)}" data-host-name="${esc(label)}" data-host-agent="${host.agent ? "true" : "false"}">${icon("alert")}${t("st.hostForceRemove")}</button>`;
  return `${remove}${force}`;
}

/** An agent's connection under its status: the version it runs, when it was last seen, and what to do when it is out of date. */
function agentDetails(agent) {
  const state = agentState(agent);
  const seen = agent.lastSeenAt ? t("st.agentLastSeen", { when: relTime(agent.lastSeenAt) }) : t("st.agentNeverSeen");
  const revoked = state === "revoked" ? `<span class="badge badge-danger">${esc(t("st.agentRevoked"))}</span>` : "";
  const upgrade =
    state === "upgrade"
      ? `<div class="callout warn">${icon("alert")}<span>${esc(t("st.agentUpgrade"))}</span></div>
        <div class="help">${esc(t("st.agentUpgradeHelp"))}</div>`
      : "";
  return `<div class="help agent-meta">${revoked}<span>${esc(t("st.agentVersion", { version: agent.version }))}</span><span>${esc(seen)}</span></div>${upgrade}`;
}

/**
 * Adds a host by the method the operator picks. The agent method pairs a machine that dials in. The endpoint method
 * takes a Docker endpoint: a socket, mutual TLS or an SSH login.
 */
function addHost(view) {
  let fingerprint = "";
  let pending = null;
  let stopWatching = null;
  const { root, close } = openDialog({
    title: t("st.hostAdd"),
    description: t("st.hostAddHelp"),
    iconName: "server",
    wide: true,
    body: `
      <div class="segmented segmented-2" role="group" aria-label="${esc(t("st.hostMethod"))}">
        <button type="button" class="seg" data-method="agent" aria-pressed="true"><strong>${esc(t("st.hostMethodAgent"))}</strong><span>${esc(t("st.hostMethodAgentHint"))}</span></button>
        <button type="button" class="seg" data-method="endpoint" aria-pressed="false"><strong>${esc(t("st.hostMethodEndpoint"))}</strong><span>${esc(t("st.hostMethodEndpointHint"))}</span></button>
      </div>
      <div data-method-panel="agent">
        <div id="stAgentBody">
          <form id="stAgentForm" class="stack" autocomplete="off">
            <div class="grid grid-2 form-grid">
              <label class="field">${t("st.hostId")}<input class="input mono" name="id" required pattern="[a-z][a-z0-9\\-]{0,31}" placeholder="lab" /><span class="help">${t("st.hostIdHelp")}</span></label>
              <label class="field">${t("st.hostName")}<input class="input" name="name" maxlength="64" placeholder="Lab" /><span class="help">${t("st.hostNameHelp")}</span></label>
            </div>
            <p class="help">${t("st.agentFormHelp")}</p>
          </form>
        </div>
        <div id="stAgentResult"></div>
      </div>
      <div data-method-panel="endpoint" hidden>
        <form id="stHostForm" class="stack" autocomplete="off">
          <div class="grid grid-2 form-grid">
            <label class="field">${t("st.hostId")}<input class="input mono" name="id" required pattern="[a-z][a-z0-9\\-]{0,31}" placeholder="lab" /><span class="help">${t("st.hostIdHelp")}</span></label>
            <label class="field">${t("st.hostName")}<input class="input" name="name" maxlength="64" placeholder="Lab" /><span class="help">${t("st.hostNameHelp")}</span></label>
          </div>
          <label class="field">${t("st.hostEndpoint")}<input class="input mono" name="endpoint" required placeholder="unix:///var/run/docker.sock" /><span class="help">${t("st.hostEndpointHelp")}</span></label>
          <div data-cred="tcp" hidden>
            <label class="field">${t("st.hostCa")}<textarea class="textarea mono" name="ca" rows="3" spellcheck="false"></textarea></label>
            <label class="field">${t("st.hostCert")}<textarea class="textarea mono" name="cert" rows="3" spellcheck="false"></textarea></label>
            <label class="field">${t("st.hostKey")}<textarea class="textarea mono" name="key" rows="3" spellcheck="false"></textarea><span class="help">${t("st.hostCredHelp")}</span></label>
          </div>
          <label class="field" data-cred="ssh" hidden>${t("st.hostPrivateKey")}<textarea class="textarea mono" name="privateKey" rows="4" spellcheck="false"></textarea><span class="help">${t("st.hostCredHelp")}</span></label>
          <div id="stHostResult"></div>
        </form>
      </div>`,
    footer: `<button class="btn" data-close>${t("common.cancel")}</button>
      <button class="btn btn-primary" id="stAgentCreate">${icon("terminal")}${t("st.agentCreate")}</button>
      <button class="btn" id="stHostTest" hidden>${icon("refresh")}${t("st.hostTest")}</button>
      <button class="btn btn-primary" id="stHostSave" hidden>${icon("plus")}${t("st.hostAddSubmit")}</button>`,
    onClose: () => stopWatching?.(),
  });

  const agentBody = root.querySelector("#stAgentBody");
  const agentResult = root.querySelector("#stAgentResult");
  const agentCreate = root.querySelector("#stAgentCreate");
  const hostTest = root.querySelector("#stHostTest");
  const hostSave = root.querySelector("#stHostSave");
  const showMethod = (method) => {
    for (const button of root.querySelectorAll("[data-method]")) {
      button.setAttribute("aria-pressed", String(button.dataset.method === method));
    }
    root.querySelector('[data-method-panel="agent"]').hidden = method !== "agent";
    root.querySelector('[data-method-panel="endpoint"]').hidden = method !== "endpoint";
    agentCreate.hidden = method !== "agent" || pending !== null;
    hostTest.hidden = method !== "endpoint";
    hostSave.hidden = method !== "endpoint";
  };
  for (const button of root.querySelectorAll("[data-method]")) {
    button.addEventListener("click", () => showMethod(button.dataset.method));
  }

  async function issueCode(request) {
    stopWatching?.();
    agentResult.innerHTML = "";
    let pairing;
    try {
      pairing = await api("/api/hosts/pairing", { method: "POST", body: request });
    } catch (e) {
      agentResult.innerHTML = `<div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div>`;
      return;
    }
    pending = request;
    agentCreate.hidden = true;
    agentBody.innerHTML = pairingView(pairing);
    stopWatching = watchAgent(pairing.id, pairing.expiresAt, {
      onConnected: async (host) => {
        close();
        toast(t("st.agentConnected"), { message: host.name });
        await refreshHosts();
        loadHosts(view);
      },
      onExpired: () => {
        agentBody.querySelector("[data-agent-wait]").outerHTML = expiredLine();
      },
    });
  }

  agentCreate.addEventListener("click", () => {
    const form = root.querySelector("#stAgentForm");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    issueCode({ id: String(data.get("id") ?? "").trim(), name: String(data.get("name") ?? "").trim() });
  });

  root.addEventListener("click", async (event) => {
    if (event.target.closest("[data-agent-new]")) {
      issueCode(pending);
      return;
    }
    const copy = event.target.closest("[data-copy]");
    if (!copy) return;
    try {
      await copyText(copy.dataset.copy);
      toast(t("st.agentCopied"));
    } catch (err) {
      toastError(t("st.agentCopyFailed"), err);
    }
  });

  const form = root.querySelector("#stHostForm");
  const result = root.querySelector("#stHostResult");
  const endpoint = form.elements.namedItem("endpoint");
  endpoint.addEventListener("input", () => {
    const scheme = schemeOf(endpoint.value);
    for (const block of form.querySelectorAll("[data-cred]")) block.hidden = block.dataset.cred !== scheme;
    fingerprint = "";
    result.innerHTML = "";
  });
  hostTest.addEventListener("click", (e) =>
    withBusyHost(e.currentTarget, async () => {
      let res = await testHost(form, result, fingerprint);
      const presented = res?.error?.key === "host_key_unconfirmed" ? res.hostKeyFingerprint : null;
      if (!presented) return;
      // The operator confirms the key here, once; only then does the test log in and reach the engine.
      if (!(await trustHostKey(presented, t("st.hostTrustTest")))) return;
      fingerprint = presented;
      res = await testHost(form, result, fingerprint);
    }),
  );
  hostSave.addEventListener("click", (e) =>
    withBusyHost(e.currentTarget, () => saveHost(view, form, close, () => fingerprint)),
  );
}

async function saveHost(view, form, close, confirmedFingerprint) {
  const body = hostBody(form);
  const scheme = schemeOf(body.endpoint ?? "");
  if (scheme === "ssh" && confirmedFingerprint()) body.hostKeyFingerprint = confirmedFingerprint();
  try {
    await api("/api/hosts", { method: "POST", body });
  } catch (e) {
    const presented = e.key === "host_key_unconfirmed" ? e.details?.fingerprint : null;
    if (!presented) {
      toastError(t("st.hostAddFailed"), e);
      return;
    }
    if (!(await trustHostKey(presented))) return;
    try {
      await api("/api/hosts", { method: "POST", body: { ...body, hostKeyFingerprint: presented } });
    } catch (again) {
      toastError(t("st.hostAddFailed"), again);
      return;
    }
  }
  close();
  toast(t("st.hostAdded"), { message: body.name ?? body.id });
  await refreshHosts();
  loadHosts(view);
}

/** Removes a host after a confirm. An agent host's dialog also says its agent is cut off and what is left on the machine. */
async function removeHost(view, id, name, agent) {
  const ok = await confirmDialog({
    title: t("st.hostRemoveTitle"),
    message: esc(t(agent ? "st.agentRemoveMessage" : "st.hostRemoveMessage", { name })),
    confirmText: t("st.hostRemove"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/hosts/${enc(id)}`, { method: "DELETE" });
  } catch (e) {
    toastError(t("st.hostRemoveFailed"), e);
    return;
  }
  toast(t("st.hostRemoved"), { message: name });
  await refreshHosts();
  loadHosts(view);
}

/** One class of record the force removal discards, with its count and the names the preview lists. */
function recordsSection(labelKey, names) {
  if (names.length === 0) return "";
  return `<p class="help"><strong>${esc(t(labelKey, { count: names.length }))}</strong> ${esc(names.join(", "))}</p>`;
}

/** The records a force removal would discard, as the confirm dialog lists them. */
function forceRemoveBody(preview) {
  const boxes = preview?.boxes ?? [];
  const volumes = preview?.volumes ?? [];
  const checkpoints = preview?.checkpoints ?? [];
  const sections = [
    recordsSection(
      "st.hostForceRemoveBoxes",
      boxes.map((box) => box.name),
    ),
    recordsSection(
      "st.hostForceRemoveVolumes",
      volumes.map((volume) => volume.name),
    ),
    recordsSection(
      "st.hostForceRemoveCheckpoints",
      checkpoints.map((checkpoint) => checkpoint.label),
    ),
  ].join("");
  return sections || `<p class="help">${esc(t("st.hostForceRemoveNothing"))}</p>`;
}

/**
 * Force-removes a host whose machine is gone. The preview is asked for first, without confirm, so the dialog lists the
 * records MiniBox would drop; only the confirm sends `confirm: true`. Nothing is sent to the machine, which the dialog
 * says in as many words: its containers, if it is still there, are left as orphans MiniBox no longer manages.
 */
async function forceRemoveHost(view, id, name, agent) {
  let preview;
  try {
    preview = (await api(`/api/hosts/${enc(id)}/force-remove`, { method: "POST", body: { confirm: false } })).preview;
  } catch (e) {
    if (e.key !== "host_force_remove_confirm") {
      toastError(t("st.hostForceRemoveFailed"), e);
      return;
    }
    preview = e.details?.preview;
  }
  if (!preview) {
    toastError(t("st.hostForceRemoveFailed"), { message: t("st.hostForceRemoveNoPreview") });
    return;
  }
  const message = `${t("st.hostForceRemoveMessage", { name })}${agent ? ` ${t("st.hostForceRemoveAgent")}` : ""}`;
  for (;;) {
    const ok = await confirmDialog({
      title: t("st.hostForceRemoveTitle"),
      message: esc(message),
      body: forceRemoveBody(preview),
      confirmText: t("st.hostForceRemove"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/hosts/${enc(id)}/force-remove`, {
        method: "POST",
        body: { confirm: true, digest: preview.digest },
      });
      break;
    } catch (e) {
      // A record was written or moved since the preview. Nothing was discarded; show the fresh set and ask again.
      if (e.key === "host_records_changed" && e.details?.preview) {
        preview = e.details.preview;
        toast(t("st.hostForceRemoveChanged"), { type: "info" });
        continue;
      }
      toastError(t("st.hostForceRemoveFailed"), e);
      return;
    }
  }
  toast(t("st.hostForceRemoved"), { message: name });
  await refreshHosts();
  loadHosts(view);
}
