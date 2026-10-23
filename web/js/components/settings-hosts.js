import { api, enc } from "../lib/api.js";
import { esc, copyText } from "../lib/dom.js";
import { cpus, mem, relTime } from "../lib/format.js";
import { HOST_BADGE, agentState } from "../lib/host-list.js";
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
  const { shown, toggle } = limitList(view, "hosts", hosts);
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.hosts")}</h3><p class="help">${t("st.hostsHelp")}</p></div>
      <button class="btn btn-sm btn-primary" id="stHostAdd">${icon("plus")}${t("st.hostAdd")}</button>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>${t("st.hostColName")}</th><th class="hide-sm">${t("st.hostColEndpoint")}</th><th>${t("st.hostColStatus")}</th>
        <th class="hide-sm">${t("st.hostColCapacity")}</th><th class="hide-sm">${t("st.hostColBoxes")}</th><th></th>
      </tr></thead>
      <tbody>${shown.map(hostRow).join("")}</tbody>
    </table></div>
    <div class="list-more">${toggle}</div>`;
  card.querySelector("#stHostAdd").addEventListener("click", () => addHost(view));
  card.querySelectorAll("[data-remove-host]").forEach((btn) => {
    btn.addEventListener("click", () => removeHost(view, btn.dataset.removeHost, btn.dataset.hostName));
  });
  card.querySelectorAll("[data-revoke-host]").forEach((btn) => {
    btn.addEventListener("click", () => revokeAgent(view, btn.dataset.revokeHost, btn.dataset.hostName));
  });
  bindToggles(view, card, () => loadHosts(view));
}

function hostRow(host) {
  const capacity = host.capacity
    ? `${cpus(host.capacity.cpus)} · ${mem(host.capacity.memoryBytes)}`
    : t("common.unknown");
  const latency = host.latencyMs == null ? "" : ` <span class="subtle">${host.latencyMs} ms</span>`;
  const error = host.error ? `<div class="help" title="${esc(host.error)}">${esc(host.error)}</div>` : "";
  const endpoint = host.agent
    ? `<span class="subtle">${esc(t("st.agentEndpoint"))}</span> <span class="badge">${esc(t("st.transport.agent"))}</span>`
    : `<span class="mono">${esc(host.endpoint)}</span> <span class="badge">${esc(t(`st.transport.${host.transport}`))}</span>`;
  const agent = host.agent ? agentDetails(host.agent) : "";
  return `<tr>
    <td><strong>${esc(host.name)}</strong> <span class="subtle mono">${esc(host.id)}</span></td>
    <td class="hide-sm">${endpoint}</td>
    <td class="${host.agent ? "" : "nowrap"}"><span class="badge ${HOST_BADGE[host.status] ?? ""}"><span class="dot"></span>${esc(t(`st.hostStatus.${host.status}`))}</span>${latency}${error}${agent}</td>
    <td class="hide-sm nowrap">${capacity}</td>
    <td class="hide-sm">${host.boxes}</td>
    <td class="nowrap"><div class="actions">${hostActions(host)}</div></td>
  </tr>`;
}

function hostActions(host) {
  if (host.transport === "local") return `<span class="subtle">${t("st.hostLocal")}</span>`;
  const revoke =
    host.agent && !host.agent.revoked
      ? `<button class="btn btn-sm" data-revoke-host="${esc(host.id)}" data-host-name="${esc(host.name)}">${icon("alert")}${t("st.agentRevoke")}</button>`
      : "";
  const remove = `<button class="btn btn-sm btn-danger" data-remove-host="${esc(host.id)}" data-host-name="${esc(host.name)}">${icon("x")}${t("st.hostRemove")}</button>`;
  return `${revoke}${remove}`;
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
              <label class="field">${t("st.hostName")}<input class="input" name="name" maxlength="64" placeholder="Lab" /></label>
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
            <label class="field">${t("st.hostName")}<input class="input" name="name" maxlength="64" placeholder="Lab" /></label>
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

async function removeHost(view, id, name) {
  const ok = await confirmDialog({
    title: t("st.hostRemoveTitle"),
    message: esc(t("st.hostRemoveMessage", { name })),
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

async function revokeAgent(view, id, name) {
  const ok = await confirmDialog({
    title: t("st.agentRevokeTitle"),
    message: esc(t("st.agentRevokeMessage", { name })),
    confirmText: t("st.agentRevoke"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/hosts/${enc(id)}/revoke`, { method: "POST" });
  } catch (e) {
    toastError(t("st.agentRevokeFailed"), e);
    return;
  }
  toast(t("st.agentRevokedToast"), { message: name });
  await refreshHosts();
  loadHosts(view);
}
