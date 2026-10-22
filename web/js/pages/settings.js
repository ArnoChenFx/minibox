import { agentBashCommand, agentPowerShellCommand } from "../lib/agent-command.js";
import { api, enc, errorText } from "../lib/api.js";
import { copyText, esc } from "../lib/dom.js";
import { ENV_VALUE_MAX, SECRET_NAME_RE, validSecretValue } from "../lib/env.js";
import { cpus, dateTime, mem, relTime } from "../lib/format.js";
import { agentState, HOST_BADGE } from "../lib/host-list.js";
import { refreshHosts } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { CHANNEL_TYPES, channelBody, failureOf, NOTICE_KINDS } from "../lib/notify-state.js";
import { currentTheme, toggleTheme } from "../lib/theme.js";
import { confirmDialog, emptyState, nameError, openDialog, toast, toastError, withBusy } from "../lib/ui.js";

export function render(view) {
  view.innerHTML = `
    <div class="page-narrow">
      <div class="page-head"><div><h1>${t("nav.settings")}</h1><p>${t("st.subtitle")}</p></div></div>
      <div class="stack">
        <div class="card" id="stRuntime">
          <div class="card-head"><h3>${t("st.runtime")}</h3>${icon("settings")}</div>
          <div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>
        </div>
        <div class="card" id="stHosts"></div>
        <div class="card">
          <div class="card-head"><h3>${t("st.appearance")}</h3></div>
          <div class="card-body row between">
            <div><strong>${t("st.theme")}</strong><div class="help">${t("st.themeHelp")}</div></div>
            <button class="btn" id="stTheme"></button>
          </div>
        </div>
        <div class="card" id="stSessions"></div>
        <div class="card" id="stTokens"></div>
        <div class="card" id="stSecrets"></div>
        <div class="card" id="stNotify"></div>
      </div>
    </div>`;

  const themeBtn = view.querySelector("#stTheme");
  const paintTheme = () => {
    const dark = currentTheme() === "dark";
    themeBtn.innerHTML = `${icon(dark ? "sun" : "moon")}${dark ? t("st.toLight") : t("st.toDark")}`;
  };
  paintTheme();
  themeBtn.addEventListener("click", toggleTheme);
  document.addEventListener("themechange", paintTheme);

  loadRuntime(view);
  loadHosts(view);
  loadSessions(view);
  loadTokens(view);
  loadSecrets(view);
  loadNotify(view);
  return () => document.removeEventListener("themechange", paintTheme);
}

async function loadHosts(view) {
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
      <tbody>${hosts.map(hostRow).join("")}</tbody>
    </table></div>`;
  card.querySelector("#stHostAdd").addEventListener("click", () => addHost(view));
  card.querySelectorAll("[data-remove-host]").forEach((btn) => {
    btn.addEventListener("click", () => removeHost(view, btn.dataset.removeHost, btn.dataset.hostName));
  });
  card.querySelectorAll("[data-revoke-host]").forEach((btn) => {
    btn.addEventListener("click", () => revokeAgent(view, btn.dataset.revokeHost, btn.dataset.hostName));
  });
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

const HOST_CREDENTIALS = { tcp: ["ca", "cert", "key"], ssh: ["privateKey"] };

function schemeOf(endpoint) {
  return endpoint.trim().split("://")[0].toLowerCase();
}

function hostBody(form) {
  const data = new FormData(form);
  const scheme = schemeOf(String(data.get("endpoint") ?? ""));
  const body = {};
  for (const key of ["id", "name", "endpoint", ...(HOST_CREDENTIALS[scheme] ?? [])]) {
    const value = String(data.get(key) ?? "").trim();
    if (value) body[key] = value;
  }
  return body;
}

const AGENT_POLL_MS = 2_000;

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

/** The pairing code and the two commands that start the agent, shown until it connects or the code runs out. */
function pairingView({ code, expiresAt }) {
  return `<div class="stack">
    <p class="help">${esc(t("st.agentPairHelp"))}</p>
    <div class="agent-code-box">
      <div><div class="help">${esc(t("st.agentCode"))}</div><span class="agent-code mono">${esc(code)}</span></div>
      <button class="btn btn-sm" type="button" data-copy="${esc(code)}">${icon("copy")}${esc(t("st.agentCopyCode"))}</button>
    </div>
    <div class="help">${esc(t("st.agentExpires", { time: dateTime(expiresAt) }))}</div>
    <div class="help">${esc(t("st.agentServer", { server: location.origin }))}</div>
    ${commandBlock(t("st.agentBash"), agentBashCommand(location.origin, code))}
    ${commandBlock(t("st.agentPowerShell"), agentPowerShellCommand(location.origin, code))}
    <div class="agent-wait" role="status" data-agent-wait>${icon("refresh")}<span>${esc(t("st.agentWaiting"))}</span></div>
  </div>`;
}

function commandBlock(label, text) {
  return `<div class="ssh-cmd">
    <div class="ssh-cmd-head">
      <span class="ssh-label">${esc(label)}</span>
      <button class="btn btn-sm" type="button" data-copy="${esc(text)}">${icon("copy")}${esc(t("st.agentCopy"))}</button>
    </div>
    <pre class="token-snippet" tabindex="0">${esc(text)}</pre>
  </div>`;
}

function expiredLine() {
  return `<div class="callout warn agent-expired" role="status" data-agent-wait>${icon("alert")}<span>${esc(t("st.agentExpired"))}</span>
    <button class="btn btn-sm" type="button" data-agent-new>${icon("refresh")}${esc(t("st.agentNewCode"))}</button></div>`;
}

/**
 * Checks the host list until the agent that paired with `hostId` is connected. When the code runs out with no host
 * created, `onExpired` runs instead. Returns a function that stops the checks.
 */
function watchAgent(hostId, expiresAt, { onConnected, onExpired }) {
  let timer = 0;
  let stopped = false;
  const check = async () => {
    let hosts = null;
    try {
      ({ hosts } = await api("/api/hosts"));
    } catch {
      hosts = null;
    }
    if (stopped) return;
    const host = hosts?.find((item) => item.id === hostId);
    if (host?.agent?.connected) {
      stopped = true;
      onConnected(host);
      return;
    }
    if (hosts && !host && Date.now() >= Date.parse(expiresAt)) {
      stopped = true;
      onExpired();
      return;
    }
    timer = setTimeout(check, AGENT_POLL_MS);
  };
  timer = setTimeout(check, AGENT_POLL_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function withBusyHost(btn, fn) {
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
  }
}

function trustHostKey(fingerprint, confirmText = t("st.hostTrust")) {
  return confirmDialog({
    title: t("st.hostTrustTitle"),
    message: esc(t("st.hostTrustMessage", { fingerprint })),
    confirmText,
  });
}

async function testHost(form, result, fingerprint) {
  result.innerHTML = `<div class="callout">${icon("refresh")}<span>${t("st.hostTesting")}</span></div>`;
  const body = hostBody(form);
  if (fingerprint && schemeOf(body.endpoint ?? "") === "ssh") body.hostKeyFingerprint = fingerprint;
  let res;
  try {
    res = await api("/api/hosts/test", { method: "POST", body });
  } catch (e) {
    result.innerHTML = `<div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div>`;
    return null;
  }
  const parts = [];
  if (res.ok) {
    const cap = res.capacity
      ? t("st.hostTestCapacity", { cores: res.capacity.cpus, mem: mem(res.capacity.memoryBytes) })
      : "";
    parts.push(
      `<div class="callout">${icon("check")}<span>${esc(t("st.hostTestOk", { version: res.dockerVersion ?? "—", ms: res.latencyMs ?? "—" }))}${cap ? ` · ${esc(cap)}` : ""}</span></div>`,
    );
  } else if (res.error?.key !== "host_key_unconfirmed") {
    parts.push(`<div class="callout danger">${icon("alert")}<span>${esc(errorText(res.error ?? {}))}</span></div>`);
  }
  if (res.hostKeyFingerprint) {
    parts.push(
      `<div class="callout">${icon("info")}<span>${esc(t("st.hostFingerprint", { fingerprint: res.hostKeyFingerprint }))}</span></div>`,
    );
  }
  result.innerHTML = parts.join("");
  return res;
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

async function loadRuntime(view) {
  const body = view.querySelector("#stRuntime .card-body");
  let s;
  try {
    s = await api("/api/system");
  } catch (e) {
    body.innerHTML = `<div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div>`;
    return;
  }
  const c = s.config;
  body.innerHTML = `<div class="kv-cols">
    <dl class="kv">
      <dt>${t("st.listen")}</dt><dd class="mono">${esc(c.host)}:${esc(c.port)}</dd>
      <dt>Docker Socket</dt><dd class="mono">${esc(c.dockerSocket)}</dd>
      <dt>${t("st.labelPrefix")}</dt><dd class="mono">${esc(c.labelPrefix)}</dd>
      <dt>${t("st.baseTemplate")}</dt><dd class="mono">${esc(c.baseTemplate)}</dd>
      <dt>${t("st.boxProfile")}</dt><dd>${t(`profile.${c.boxProfile}`)}</dd>
    </dl>
    <dl class="kv">
      <dt>${t("st.containerRuntime")}</dt><dd>${c.containerRuntime ? `<span class="mono">${esc(c.containerRuntime)}</span>` : t("st.runtimeDefault")}</dd>
      <dt>${t("st.pidsLimit")}</dt><dd>${t("st.pidsValue", { n: c.boxPidsLimit })}</dd>
      <dt>${t("st.boxNetwork")}</dt><dd class="mono">${esc(c.boxNetwork)}</dd>
      <dt>${t("st.interval")}</dt><dd>${t("st.intervalValue", { n: c.metricsIntervalMs / 1000 })}</dd>
      <dt>${t("st.boxLimits")}</dt><dd>${t("st.boxLimitsValue", { minC: s.limits.minCpus, maxC: s.limits.maxCpus, minM: s.limits.minMemoryMb, maxM: s.limits.maxMemoryMb })}</dd>
    </dl>
  </div>`;
}

async function loadSessions(view) {
  const card = view.querySelector("#stSessions");
  let sessions;
  try {
    ({ sessions } = await api("/api/auth/sessions"));
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.sessions")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  const others = sessions.filter((s) => !s.current).length;
  const rows = sessions.length
    ? sessions.map(sessionRow).join("")
    : `<tr><td colspan="4">${emptyState({ iconName: "key", title: t("st.sessionsNone") })}</td></tr>`;
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.sessions")}</h3><p class="help">${t("st.sessionsHelp")}</p></div>
      <button class="btn btn-sm" id="stSignOutOthers" ${others ? "" : "disabled"}>${icon("logout")}${t("st.signOutOthers")}</button>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${t("st.sessionDevice")}</th><th class="hide-sm">${t("st.sessionCreated")}</th><th>${t("st.sessionLastSeen")}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  card
    .querySelectorAll("[data-revoke]")
    .forEach((btn) => btn.addEventListener("click", () => revokeSession(view, btn.dataset.revoke)));
  card.querySelector("#stSignOutOthers")?.addEventListener("click", () => signOutOthers(view));
}

function sessionRow(s) {
  const device = s.userAgent ? esc(s.userAgent) : t("common.unknown");
  const action = s.current
    ? `<span class="badge badge-accent">${t("st.sessionCurrent")}</span>`
    : `<button class="btn btn-sm btn-danger" data-revoke="${esc(s.id)}">${icon("x")}${t("st.sessionRevoke")}</button>`;
  return `<tr>
    <td><div class="session-ua" title="${esc(s.userAgent)}">${device}</div></td>
    <td class="hide-sm subtle nowrap">${dateTime(s.createdAt)}</td>
    <td class="subtle nowrap">${relTime(s.lastSeenAt)}</td>
    <td class="nowrap"><div class="actions">${action}</div></td>
  </tr>`;
}

async function revokeSession(view, id) {
  const ok = await confirmDialog({
    title: t("st.sessionRevokeTitle"),
    message: t("st.sessionRevokeMessage"),
    confirmText: t("st.sessionRevoke"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/auth/sessions/${enc(id)}`, { method: "DELETE" });
  } catch (e) {
    toastError(t("st.sessionRevokeFailed"), e);
    return;
  }
  toast(t("st.sessionRevoked"));
  loadSessions(view);
}

async function signOutOthers(view) {
  const ok = await confirmDialog({
    title: t("st.signOutOthersTitle"),
    message: t("st.signOutOthersMessage"),
    confirmText: t("st.signOutOthers"),
    danger: true,
  });
  if (!ok) return;
  let revoked;
  try {
    ({ revoked } = await api("/api/auth/sessions/revoke-others", { method: "POST", body: {} }));
  } catch (e) {
    toastError(t("st.signOutOthersFailed"), e);
    return;
  }
  toast(t("st.signedOutOthers", { n: revoked }));
  loadSessions(view);
}

const PRESETS = ["readonly", "operator", "sandboxed-agent", "admin"];

function linesOf(value) {
  return value
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function tokenStatus(token) {
  if (token.revokedAt) return { key: "st.tokenRevoked", badge: "badge-danger" };
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now())
    return { key: "st.tokenExpired", badge: "badge-warning" };
  return { key: "st.tokenLive", badge: "badge-success" };
}

function scopeSummary(token) {
  const scopes = token.scopes.join(", ");
  return `<span class="subtle" title="${esc(scopes)}">${esc(token.preset ? t(`st.preset.${token.preset}`) : scopes)}</span>`;
}

async function loadTokens(view) {
  const card = view.querySelector("#stTokens");
  if (!card) return;
  let tokens;
  try {
    ({ tokens } = await api("/api/tokens"));
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.tokens")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  const rows = tokens.length
    ? tokens.map(tokenRow).join("")
    : `<tr><td colspan="6">${emptyState({ iconName: "key", title: t("st.tokenNone") })}</td></tr>`;
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.tokens")}</h3><p class="help">${t("st.tokensHelp")}</p></div>
      <button class="btn btn-sm btn-primary" id="stTokenCreate">${icon("plus")}${t("st.tokenCreate")}</button>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>${t("label.tokenName")}</th><th>${t("st.tokenPrefix")}</th><th class="hide-sm">${t("st.tokenScopes")}</th>
        <th class="hide-sm">${t("st.tokenExpires")}</th><th>${t("st.tokenLastUsed")}</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  card.querySelector("#stTokenCreate").addEventListener("click", () => createToken(view));
  card.querySelectorAll("[data-revoke-token]").forEach((btn) => {
    btn.addEventListener("click", () => revokeToken(view, btn.dataset.revokeToken, btn.dataset.tokenName));
  });
}

function tokenRow(token) {
  const status = tokenStatus(token);
  const action = token.revokedAt
    ? `<span class="badge ${status.badge}">${t(status.key)}</span>`
    : `<button class="btn btn-sm btn-danger" data-revoke-token="${esc(token.id)}" data-token-name="${esc(token.name)}">${icon("x")}${t("st.tokenRevoke")}</button>`;
  const used = token.lastUsedAt
    ? `${esc(relTime(token.lastUsedAt))}${token.lastUsedIp ? ` <span class="subtle">${esc(token.lastUsedIp)}</span>` : ""}`
    : `<span class="subtle">${t("st.tokenUnused")}</span>`;
  return `<tr>
    <td><strong>${esc(token.name)}</strong> <span class="badge ${status.badge}">${t(status.key)}</span></td>
    <td class="mono">${esc(token.prefix)}</td>
    <td class="hide-sm">${scopeSummary(token)}</td>
    <td class="hide-sm subtle nowrap">${token.expiresAt ? esc(dateTime(token.expiresAt)) : t("st.tokenNever")}</td>
    <td class="subtle nowrap">${used}</td>
    <td class="nowrap"><div class="actions">${action}</div></td>
  </tr>`;
}

function createToken(view) {
  const presetOptions = PRESETS.map((name) => `<option value="${name}">${esc(t(`st.preset.${name}`))}</option>`).join(
    "",
  );
  const { root, close } = openDialog({
    title: t("st.tokenCreate"),
    description: t("st.tokenPresetHelp"),
    iconName: "key",
    wide: true,
    body: `
      <form id="stTokenForm" class="stack">
        <label class="field">${t("label.tokenName")}<input class="input" name="name" autocomplete="off" required /></label>
        <label class="field">${t("st.tokenPreset")}<select class="select" name="preset">${presetOptions}</select></label>
        <label class="field">${t("st.tokenBoxes")}
          <select class="select" name="boxes">
            <option value="created-by-me">${esc(t("st.tokenBoxesCreated"))}</option>
            <option value="*">${esc(t("st.tokenBoxesAll"))}</option>
            <option value="ids">${esc(t("st.tokenBoxesIds"))}</option>
            <option value="tags">${esc(t("st.tokenBoxesTags"))}</option>
          </select>
        </label>
        <label class="field" data-box-ids hidden>${t("st.tokenBoxList")}<textarea class="textarea token-lines" name="boxIds"></textarea><span class="help">${t("st.tokenBoxListHelp")}</span></label>
        <label class="field" data-box-tags hidden>${t("st.tokenTags")}<textarea class="textarea token-lines" name="boxTags"></textarea><span class="help">${t("st.tokenTagsHelp")}</span></label>
        <label class="field">${t("st.tokenVolumes")}<textarea class="textarea token-lines" name="volumes"></textarea><span class="help">${t("st.tokenVolumesHelp")}</span></label>
        <label class="checkbox"><input type="checkbox" name="volumesAll" /> <span>${t("st.tokenVolumesAll")}</span></label>
        <label class="field">${t("st.tokenHosts")}
          <select class="select" name="hosts">
            <option value="local">${esc(t("st.tokenHostsLocal"))}</option>
            <option value="*">${esc(t("st.tokenHostsAll"))}</option>
          </select>
        </label>
        <label class="field">${t("st.tokenExpiry")}<input class="input" name="days" inputmode="numeric" /><span class="help">${t("st.tokenExpiryHelp")}</span></label>
        <div class="field"><strong>${t("st.tokenQuotas")}</strong><span class="help">${t("st.tokenQuotaHelp")}</span></div>
        <div class="grid grid-2">
          <label class="field">${t("st.tokenQuotaBoxes")}<input class="input" name="maxBoxes" inputmode="numeric" /></label>
          <label class="field">${t("st.tokenQuotaCpus")}<input class="input" name="maxCpus" inputmode="decimal" /></label>
          <label class="field">${t("st.tokenQuotaMemory")}<input class="input" name="maxMemoryMb" inputmode="numeric" /></label>
          <label class="field">${t("st.tokenQuotaTtl")}<input class="input" name="maxTtlHours" inputmode="numeric" /></label>
          <label class="field">${t("st.tokenQuotaRate")}<input class="input" name="rateLimit" inputmode="numeric" /></label>
          <label class="field">${t("st.tokenQuotaCheckpoints")}<input class="input" name="maxCheckpoints" inputmode="numeric" /></label>
        </div>
      </form>`,
    footer: `<button class="btn" data-close type="button">${t("common.cancel")}</button><button class="btn btn-primary" id="stTokenSave" type="button">${t("st.tokenCreate")}</button>`,
  });
  const form = root.querySelector("#stTokenForm");
  const boxes = form.elements.boxes;
  const syncBoxes = () => {
    root.querySelector("[data-box-ids]").hidden = boxes.value !== "ids";
    root.querySelector("[data-box-tags]").hidden = boxes.value !== "tags";
  };
  boxes.addEventListener("change", syncBoxes);
  root.querySelector("#stTokenSave").addEventListener("click", () => submitToken(view, form, close));
}

function numberOrSkip(value) {
  const text = value.trim();
  if (!text) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.NaN;
}

async function submitToken(view, form, close) {
  const data = new FormData(form);
  const name = String(data.get("name") ?? "").trim();
  const invalid = nameError(name, "tokenName");
  if (invalid) {
    toast(t("st.tokenCreateFailed"), { type: "error", message: invalid });
    return;
  }
  const body = { name, preset: String(data.get("preset")) };
  const boxes = String(data.get("boxes"));
  if (boxes === "*") body.boxes = "*";
  else if (boxes === "ids") body.boxes = { ids: linesOf(String(data.get("boxIds") ?? "")) };
  else if (boxes === "tags") body.boxes = { tags: linesOf(String(data.get("boxTags") ?? "")) };
  else body.boxes = "created-by-me";
  if (data.get("volumesAll")) body.volumes = "*";
  else {
    const volumes = linesOf(String(data.get("volumes") ?? ""));
    if (volumes.length) body.volumes = volumes;
  }
  if (String(data.get("hosts")) === "*") body.hosts = "*";
  const days = numberOrSkip(String(data.get("days") ?? ""));
  if (days !== undefined) body.expiresInSec = Math.round(days * 86_400);
  const quotas = {};
  const maxBoxes = numberOrSkip(String(data.get("maxBoxes") ?? ""));
  const maxCpus = numberOrSkip(String(data.get("maxCpus") ?? ""));
  const maxMemoryMb = numberOrSkip(String(data.get("maxMemoryMb") ?? ""));
  const maxTtlHours = numberOrSkip(String(data.get("maxTtlHours") ?? ""));
  const rateLimit = numberOrSkip(String(data.get("rateLimit") ?? ""));
  const maxCheckpoints = numberOrSkip(String(data.get("maxCheckpoints") ?? ""));
  if (maxBoxes !== undefined) quotas.maxBoxes = maxBoxes;
  if (maxCpus !== undefined) quotas.maxCpus = maxCpus;
  if (maxMemoryMb !== undefined) quotas.maxMemoryMb = maxMemoryMb;
  if (maxTtlHours !== undefined) quotas.maxTtlSec = Math.round(maxTtlHours * 3600);
  if (rateLimit !== undefined) quotas.rateLimit = rateLimit;
  if (maxCheckpoints !== undefined) quotas.maxCheckpoints = maxCheckpoints;
  if (Object.keys(quotas).length) body.quotas = quotas;
  let created;
  try {
    created = await api("/api/tokens", { method: "POST", body });
  } catch (e) {
    toastError(t("st.tokenCreateFailed"), e);
    return;
  }
  close();
  showTokenSecret(created.token);
  loadTokens(view);
}

function showTokenSecret(secret) {
  const origin = location.origin;
  const curl = `curl -s -H "Authorization: Bearer ${secret}" ${origin}/api/boxes`;
  const mcp = JSON.stringify(
    { mcpServers: { minibox: { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${secret}` } } } },
    null,
    2,
  );
  const { root } = openDialog({
    title: t("st.tokenCreate"),
    description: t("st.tokenOnce"),
    iconName: "key",
    wide: true,
    body: `
      <div class="stack">
        <div class="token-secret" id="stTokenSecret">${esc(secret)}</div>
        <div><div class="help">${t("st.tokenCurl")}</div><pre class="token-snippet">${esc(curl)}</pre></div>
        <div><div class="help">${t("st.tokenMcp")}</div><pre class="token-snippet">${esc(mcp)}</pre></div>
        <div class="callout warn">${icon("alert")}<span>${t("st.tokenMcpNote")}</span></div>
      </div>`,
    footer: `<button class="btn" id="stTokenCopy" type="button">${icon("copy")}${t("st.tokenCopy")}</button><button class="btn btn-primary" data-close type="button">${t("common.close")}</button>`,
  });
  root.querySelector("#stTokenCopy").addEventListener("click", async () => {
    try {
      await copyText(secret);
      toast(t("st.tokenCopied"));
    } catch (e) {
      toastError(t("st.tokenCopy"), e);
    }
  });
}

async function revokeToken(view, id, name) {
  const ok = await confirmDialog({
    title: t("st.tokenRevokeTitle"),
    message: t("st.tokenRevokeMessage"),
    confirmText: t("st.tokenRevoke"),
    danger: true,
    checkbox: { label: t("st.tokenDeleteCreated"), help: t("st.tokenDeleteCreatedHelp") },
  });
  if (!ok) return;
  try {
    await api(`/api/tokens/${enc(id)}?deleteCreated=${ok.checked ? "true" : "false"}`, { method: "DELETE" });
  } catch (e) {
    toastError(t("st.tokenRevokeFailed"), e);
    return;
  }
  toast(t("st.tokenRevokedToast"), { message: name ?? "" });
  loadTokens(view);
}

async function loadSecrets(view) {
  const card = view.querySelector("#stSecrets");
  if (!card) return;
  let secrets;
  try {
    ({ secrets } = await api("/api/secrets"));
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.secrets")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  const rows = secrets.length
    ? secrets.map(secretRow).join("")
    : `<tr><td colspan="4">${emptyState({ iconName: "key", title: t("st.secretNone") })}</td></tr>`;
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.secrets")}</h3><p class="help">${t("st.secretsHelp")}</p></div>
      <button class="btn btn-sm btn-primary" id="stSecretAdd">${icon("plus")}${t("st.secretAdd")}</button>
    </div>
    <div class="card-note"><p class="help">${t("st.secretsNote")}</p></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${t("label.name")}</th><th class="hide-sm">${t("st.secretUpdated")}</th><th>${t("st.secretUsedBy")}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  card.querySelector("#stSecretAdd").addEventListener("click", () => secretDialog(view));
  card.querySelectorAll("[data-secret-replace]").forEach((btn) => {
    btn.addEventListener("click", () => secretDialog(view, btn.dataset.secretReplace));
  });
  card.querySelectorAll("[data-secret-delete]").forEach((btn) => {
    btn.addEventListener("click", () => deleteSecret(view, btn.dataset.secretDelete));
  });
}

function secretRow(secret) {
  const used = secret.boxes.length
    ? secret.boxes.map((name) => `<span class="badge mono">${esc(name)}</span>`).join(" ")
    : `<span class="subtle">${t("st.secretUnused")}</span>`;
  return `<tr>
    <td class="nowrap"><strong>${esc(secret.name)}</strong></td>
    <td class="hide-sm subtle nowrap" title="${esc(dateTime(secret.updatedAt))}">${esc(relTime(secret.updatedAt))}</td>
    <td>${used}</td>
    <td class="nowrap"><div class="actions">
      <button class="btn btn-sm" data-secret-replace="${esc(secret.name)}" title="${esc(t("st.secretReplace"))}" aria-label="${esc(t("st.secretReplace"))}">${icon("key")}<span class="hide-sm">${t("st.secretReplace")}</span></button>
      <button class="btn btn-sm btn-danger" data-secret-delete="${esc(secret.name)}" title="${esc(t("st.secretDelete"))}" aria-label="${esc(t("st.secretDelete"))}">${icon("trash")}<span class="hide-sm">${t("st.secretDelete")}</span></button>
    </div></td>
  </tr>`;
}

/** Adds a secret, or replaces the value of `replacing`. The value is sent once and never shown again. */
function secretDialog(view, replacing = "") {
  const { root, close } = openDialog({
    title: replacing ? t("st.secretDialogReplace", { name: replacing }) : t("st.secretDialogAdd"),
    description: t("st.secretDialogHelp"),
    iconName: "key",
    body: `<form id="stSecretForm" class="stack" autocomplete="off">
      <label class="field">${t("st.secretNameLabel")}
        <input class="input mono" name="name" value="${esc(replacing)}"${replacing ? " readonly" : " autofocus"} required autocapitalize="off" autocomplete="off" spellcheck="false" />
        <span class="help">${t("st.secretNameHelp")}</span></label>
      <label class="field">${t("st.secretValueLabel")}
        <input class="input mono" name="value" type="password"${replacing ? " autofocus" : ""} required autocapitalize="off" autocomplete="new-password" spellcheck="false" />
        <span class="help">${t("st.secretValueHelp", { max: ENV_VALUE_MAX })}</span></label>
      <div class="error-text" id="stSecretErr"></div>
    </form>`,
    footer: `<button class="btn" data-close type="button">${t("common.cancel")}</button><button class="btn btn-primary" id="stSecretSave" type="button">${t("st.secretSave")}</button>`,
  });
  const error = root.querySelector("#stSecretErr");
  root.querySelector("#stSecretSave").addEventListener("click", async (event) => {
    const data = new FormData(root.querySelector("#stSecretForm"));
    const name = String(data.get("name") ?? "").trim();
    const value = String(data.get("value") ?? "");
    if (!SECRET_NAME_RE.test(name)) {
      error.textContent = t("err.secret_name_invalid");
      return;
    }
    if (!validSecretValue(value)) {
      error.textContent = t("err.secret_value_invalid", { max: ENV_VALUE_MAX });
      return;
    }
    error.textContent = "";
    try {
      const { created } = await withBusy(event.currentTarget, () =>
        api(`/api/secrets/${enc(name)}`, { method: "PUT", body: { value } }),
      );
      close();
      toast(t(created ? "st.secretSaved" : "st.secretReplaced"), { message: name });
      loadSecrets(view);
    } catch (e) {
      error.textContent = e.message;
    }
  });
}

async function deleteSecret(view, name) {
  const ok = await confirmDialog({
    title: t("st.secretDeleteTitle", { name }),
    message: t("st.secretDeleteMessage"),
    confirmText: t("st.secretDelete"),
    danger: true,
  });
  if (ok) await removeSecret(view, name, false);
}

/** Deletes a secret. When boxes still use it, the server names them and the user confirms a forced delete. */
async function removeSecret(view, name, force) {
  try {
    await api(`/api/secrets/${enc(name)}${force ? "?force=true" : ""}`, { method: "DELETE" });
  } catch (e) {
    if (e.status === 409 && Array.isArray(e.details?.boxes)) {
      const again = await confirmDialog({
        title: t("st.secretInUseTitle", { name }),
        message: esc(t("st.secretInUseMessage", { boxes: e.details.boxes.join(", ") })),
        confirmText: t("st.secretDeleteAnyway"),
        danger: true,
      });
      if (again) await removeSecret(view, name, true);
      return;
    }
    toastError(t("st.secretDeleteFailed"), e);
    return;
  }
  toast(t("st.secretDeleted"), { message: name });
  loadSecrets(view);
}

const NOTIFY_DELIVERIES = 20;
const kindLabel = (kind) => t(`st.notifyKind.${kind}`);
const typeLabel = (type) => t(`st.notifyType.${type}`);

function failureText(code) {
  const failure = failureOf(code);
  return failure ? t(failure.key, failure.params) : "";
}

/** The notification channels, and the latest sends to them: each attempt, and why a failed one failed. */
async function loadNotify(view) {
  const card = view.querySelector("#stNotify");
  if (!card) return;
  let channels;
  let deliveries;
  try {
    [{ channels }, { deliveries }] = await Promise.all([
      api("/api/notify/channels"),
      api(`/api/notify/deliveries?limit=${NOTIFY_DELIVERIES}`),
    ]);
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.notify")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  const channelRows = channels.length
    ? channels.map(notifyChannelRow).join("")
    : `<tr><td colspan="5">${emptyState({ iconName: "zap", title: t("st.notifyNone") })}</td></tr>`;
  const deliveryRows = deliveries.length
    ? deliveries.map(deliveryRow).join("")
    : `<tr><td colspan="5">${emptyState({ iconName: "activity", title: t("st.notifyDeliveriesNone") })}</td></tr>`;
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.notify")}</h3><p class="help">${t("st.notifyHelp")}</p></div>
      <button class="btn btn-sm btn-primary" id="stNotifyAdd">${icon("plus")}${t("st.notifyAdd")}</button>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>${t("st.notifyColChannel")}</th><th class="hide-sm">${t("st.notifyColDestination")}</th>
        <th>${t("st.notifyColNotices")}</th><th class="hide-sm">${t("st.notifyBoxes")}</th><th></th>
      </tr></thead>
      <tbody>${channelRows}</tbody>
    </table></div>
    <div class="card-note"><strong>${t("st.notifyDeliveries")}</strong><p class="help">${t("st.notifyDeliveriesHelp")}</p></div>
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>${t("st.notifyColWhen")}</th><th>${t("st.notifyColChannel")}</th><th>${t("st.notifyColNotice")}</th>
        <th>${t("st.notifyColResult")}</th><th class="hide-sm">${t("st.notifyColAttempts")}</th>
      </tr></thead>
      <tbody>${deliveryRows}</tbody>
    </table></div>`;
  card.querySelector("#stNotifyAdd").addEventListener("click", () => notifyDialog(view));
  card.querySelectorAll("[data-notify-test]").forEach((btn) => {
    btn.addEventListener("click", () => sendTest(view, btn, btn.dataset.notifyTest, btn.dataset.notifyName));
  });
  card.querySelectorAll("[data-notify-edit]").forEach((btn) => {
    btn.addEventListener("click", () =>
      notifyDialog(
        view,
        channels.find((c) => c.id === btn.dataset.notifyEdit),
      ),
    );
  });
  card.querySelectorAll("[data-notify-delete]").forEach((btn) => {
    btn.addEventListener("click", () => deleteNotify(view, btn.dataset.notifyDelete, btn.dataset.notifyName));
  });
}

function channelDestination(channel) {
  if (channel.type === "webhook") return channel.url ?? "";
  if (channel.type === "ntfy") return `${channel.server ?? ""}/${channel.topic ?? ""}`;
  return channel.chatId ?? "";
}

function notifyChannelRow(channel) {
  const kinds =
    channel.events.length === NOTICE_KINDS.length
      ? `<span class="subtle">${esc(t("st.notifyAllKinds"))}</span>`
      : channel.events.map((kind) => `<span class="badge mono">${esc(kind)}</span>`).join(" ");
  const boxes = channel.boxes.length
    ? channel.boxes.map((name) => `<span class="badge mono">${esc(name)}</span>`).join(" ")
    : `<span class="subtle">${esc(t("st.notifyAllBoxes"))}</span>`;
  const paused = channel.enabled ? "" : ` <span class="badge">${esc(t("st.notifyPaused"))}</span>`;
  const name = esc(channel.name);
  return `<tr>
    <td><strong>${name}</strong>
      <div class="help"><span class="mono">${esc(channel.id)}</span> · ${esc(typeLabel(channel.type))}${paused}</div></td>
    <td class="hide-sm"><span class="mono">${esc(channelDestination(channel))}</span></td>
    <td>${kinds}</td>
    <td class="hide-sm">${boxes}</td>
    <td class="nowrap"><div class="actions">
      <button class="btn btn-sm" data-notify-test="${esc(channel.id)}" data-notify-name="${name}">${icon("zap")}${t("st.notifyTest")}</button>
      <button class="btn btn-sm" data-notify-edit="${esc(channel.id)}">${icon("pencil")}${t("st.notifyEdit")}</button>
      <button class="btn btn-sm btn-danger" data-notify-delete="${esc(channel.id)}" data-notify-name="${name}">${icon("trash")}${t("st.notifyDelete")}</button>
    </div></td>
  </tr>`;
}

function deliveryRow(delivery) {
  const when = new Date(delivery.ts).toISOString();
  const result =
    delivery.status === "ok"
      ? `<span class="badge badge-success">${esc(t("st.notifyDeliveryOk"))}</span>`
      : `<span class="badge badge-danger">${esc(t("st.notifyDeliveryFailed"))}</span> <span class="help">${esc(failureText(delivery.error))}</span>`;
  const notice = delivery.notice ? esc(kindLabel(delivery.notice)) : "";
  return `<tr>
    <td class="nowrap subtle" title="${esc(dateTime(when))}">${esc(relTime(when))}</td>
    <td><span class="mono">${esc(delivery.channel ?? "")}</span></td>
    <td><div>${notice}</div><div class="help">${esc(delivery.title ?? "")}</div></td>
    <td>${result}</td>
    <td class="hide-sm">${delivery.attempts ?? ""}</td>
  </tr>`;
}

async function sendTest(view, button, id, name) {
  let result;
  try {
    result = await withBusy(button, () => api(`/api/notify/channels/${enc(id)}/test`, { method: "POST" }));
  } catch (e) {
    toastError(t("st.notifyTestFailed"), e);
    return;
  }
  if (result.ok) toast(t("st.notifyTestOk"), { message: name });
  else toast(t("st.notifyTestFailed"), { type: "error", message: failureText(result.error) });
  loadNotify(view);
}

function secretCopy(type) {
  if (type === "ntfy") return [t("st.notifySecretNtfy"), t("st.notifySecretHelpNtfy")];
  if (type === "telegram") return [t("st.notifySecretTelegram"), t("st.notifySecretHelpTelegram")];
  return [t("st.notifySecretWebhook"), t("st.notifySecretHelpWebhook")];
}

/**
 * Adds a channel, or changes one. A secret is typed once and never read back: an empty field keeps the stored value,
 * and changing the channel's type drops it unless a new one is typed.
 */
function notifyDialog(view, existing = null) {
  const typeOptions = CHANNEL_TYPES.map(
    (type) =>
      `<option value="${type}"${(existing?.type ?? "webhook") === type ? " selected" : ""}>${esc(typeLabel(type))}</option>`,
  ).join("");
  const kindChoices = NOTICE_KINDS.map((kind) => {
    const on = existing ? existing.events.includes(kind) : true;
    return `<label class="checkbox"><input type="checkbox" name="events" value="${kind}"${on ? " checked" : ""} />
      <span>${esc(kindLabel(kind))} <span class="subtle mono">${esc(kind)}</span></span></label>`;
  }).join("");
  const { root, close } = openDialog({
    title: existing ? t("st.notifyEditTitle", { name: existing.name }) : t("st.notifyAddTitle"),
    description: t("st.notifyDialogHelp"),
    iconName: "zap",
    wide: true,
    body: `
      <form id="stNotifyForm" class="stack" autocomplete="off">
        <div class="grid grid-2 form-grid">
          <label class="field">${t("st.notifyName")}<input class="input" name="name" maxlength="64" required value="${esc(existing?.name ?? "")}" /></label>
          <label class="field">${t("st.notifyId")}<input class="input mono" name="id" pattern="[a-z][a-z0-9\\-]{0,31}" maxlength="32" required value="${esc(existing?.id ?? "")}"${existing ? " readonly" : ""} /><span class="help">${t("st.notifyIdHelp")}</span></label>
        </div>
        <label class="field">${t("st.notifyType")}<select class="select" name="type">${typeOptions}</select></label>
        <div data-notify-panel="webhook">
          <label class="field">${t("st.notifyUrl")}<input class="input mono" name="url" inputmode="url" placeholder="https://hooks.example.com/minibox" value="${esc(existing?.url ?? "")}" /><span class="help">${t("st.notifyUrlHelp")}</span></label>
        </div>
        <div data-notify-panel="ntfy"><div class="grid grid-2 form-grid">
          <label class="field">${t("st.notifyServer")}<input class="input mono" name="server" placeholder="https://ntfy.sh" value="${esc(existing?.server ?? "")}" /><span class="help">${t("st.notifyServerHelp")}</span></label>
          <label class="field">${t("st.notifyTopic")}<input class="input mono" name="topic" maxlength="64" value="${esc(existing?.topic ?? "")}" /><span class="help">${t("st.notifyTopicHelp")}</span></label>
        </div></div>
        <div data-notify-panel="telegram">
          <label class="field">${t("st.notifyChatId")}<input class="input mono" name="chatId" maxlength="64" placeholder="-1001234567890" value="${esc(existing?.chatId ?? "")}" /><span class="help">${t("st.notifyChatHelp")}</span></label>
        </div>
        <label class="field"><span data-notify-secret-label></span>
          <input class="input mono" name="secret" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" />
          <span class="help" data-notify-secret-help></span></label>
        <div data-notify-clear hidden><label class="checkbox"><input type="checkbox" name="clearSecret" /> <span>${t("st.notifySecretClear")}</span></label></div>
        <div class="field"><strong>${t("st.notifyEvents")}</strong><div class="stack">${kindChoices}</div></div>
        <label class="field">${t("st.notifyBoxes")}<textarea class="textarea mono" name="boxes" rows="2" spellcheck="false">${esc((existing?.boxes ?? []).join("\n"))}</textarea><span class="help">${t("st.notifyBoxesHelp")}</span></label>
        <label class="checkbox"><input type="checkbox" name="enabled"${existing?.enabled === false ? "" : " checked"} /> <span>${t("st.notifyEnabledLabel")} <span class="help">${t("st.notifyEnabledHelp")}</span></span></label>
        <div class="error-text" id="stNotifyErr"></div>
      </form>`,
    footer: `<button class="btn" data-close type="button">${t("common.cancel")}</button><button class="btn btn-primary" id="stNotifySave" type="button">${t("st.notifySave")}</button>`,
  });
  const form = root.querySelector("#stNotifyForm");
  const typeSelect = form.elements.namedItem("type");
  const secretInput = form.elements.namedItem("secret");
  const clearSecret = form.elements.namedItem("clearSecret");
  const clearRow = root.querySelector("[data-notify-clear]");
  const syncType = () => {
    const type = typeSelect.value;
    for (const panel of form.querySelectorAll("[data-notify-panel]")) panel.hidden = panel.dataset.notifyPanel !== type;
    const [label, help] = secretCopy(type);
    const dropped = existing?.hasSecret === true && existing.type !== type;
    root.querySelector("[data-notify-secret-label]").textContent = label;
    root.querySelector("[data-notify-secret-help]").textContent = dropped
      ? `${help} ${t("st.notifySecretDropped")}`
      : help;
    const stored = existing?.hasSecret === true && existing.type === type;
    clearRow.hidden = !stored;
    secretInput.placeholder = stored ? t("st.notifySecretStored") : "";
    if (!stored) clearSecret.checked = false;
    secretInput.disabled = clearSecret.checked;
  };
  typeSelect.addEventListener("change", syncType);
  clearSecret.addEventListener("change", syncType);
  syncType();
  root
    .querySelector("#stNotifySave")
    .addEventListener("click", (event) => saveNotify(view, root, existing, close, event.currentTarget));
}

async function saveNotify(view, root, existing, close, button) {
  const form = root.querySelector("#stNotifyForm");
  const error = root.querySelector("#stNotifyErr");
  error.textContent = "";
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const events = data.getAll("events").map(String);
  if (events.length === 0) {
    error.textContent = t("st.notifyEventsRequired");
    return;
  }
  const id = existing ? existing.id : String(data.get("id") ?? "").trim();
  const body = channelBody({
    type: String(data.get("type")),
    name: String(data.get("name") ?? ""),
    enabled: form.elements.namedItem("enabled").checked,
    events,
    boxes: data.get("boxes"),
    url: data.get("url"),
    server: data.get("server"),
    topic: data.get("topic"),
    chatId: data.get("chatId"),
    secret: data.get("secret"),
    clearSecret: form.elements.namedItem("clearSecret")?.checked === true,
  });
  try {
    await withBusy(button, () => api(`/api/notify/channels/${enc(id)}`, { method: "PUT", body }));
  } catch (e) {
    error.textContent = e.message;
    return;
  }
  close();
  toast(t("st.notifySaved"), { message: body.name });
  loadNotify(view);
}

async function deleteNotify(view, id, name) {
  const ok = await confirmDialog({
    title: t("st.notifyDeleteTitle", { name }),
    message: t("st.notifyDeleteMessage"),
    confirmText: t("st.notifyDelete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/notify/channels/${enc(id)}`, { method: "DELETE" });
  } catch (e) {
    toastError(t("st.notifyDeleteFailed"), e);
    return;
  }
  toast(t("st.notifyDeleted"), { message: name });
  loadNotify(view);
}
