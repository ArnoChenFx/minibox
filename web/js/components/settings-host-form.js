import {
  agentBashCommand,
  agentImage,
  agentImageTag,
  agentPowerShellCommand,
  insecureConsole,
} from "../lib/agent-command.js";
import { api, errorText } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime, mem } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { systemVersion } from "../lib/system.js";
import { confirmDialog } from "../lib/ui.js";

const HOST_CREDENTIALS = { tcp: ["ca", "cert", "key"], ssh: ["privateKey"] };

export function schemeOf(endpoint) {
  return endpoint.trim().split("://")[0].toLowerCase();
}

export function hostBody(form) {
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
 * Why the command runs the image at the tag it does: the server's own version, or `latest` with the reason a dev build
 * or an unread version has no tag of its own.
 */
export function imageNote(version) {
  const tag = agentImageTag(version);
  if (tag !== "latest") return t("st.agentImagePinned", { tag });
  const clean = String(version ?? "").trim();
  return clean ? t("st.agentImageLatest", { version: clean }) : t("st.agentImageLatestUnknown");
}

/**
 * The pairing code and the two commands that start the agent, shown until it connects or the code runs out. The address,
 * its protocol and the server's version are passed in so a test can render the fragment without a browser.
 */
export function pairingView(
  { code, expiresAt },
  { origin = location.origin, protocol = location.protocol, version = systemVersion() } = {},
) {
  const insecure = insecureConsole(protocol);
  return `<div class="stack">
    ${insecure ? `<div class="callout warn agent-insecure">${icon("alert")}<span>${esc(t("st.agentInsecure"))}</span></div>` : ""}
    <p class="help">${esc(t("st.agentPairHelp"))}</p>
    <div class="agent-code-box">
      <div><div class="help">${esc(t("st.agentCode"))}</div><span class="agent-code mono">${esc(code)}</span></div>
      <button class="btn btn-sm" type="button" data-copy="${esc(code)}">${icon("copy")}${esc(t("st.agentCopyCode"))}</button>
    </div>
    <div class="help">${esc(t("st.agentExpires", { time: dateTime(expiresAt) }))}</div>
    <div class="help">${esc(t("st.agentServer", { server: origin }))}</div>
    <div class="help agent-image" data-agent-image="${esc(agentImage(version))}">${esc(t("st.agentImage", { image: agentImage(version) }))} ${esc(imageNote(version))}</div>
    ${commandBlock(t("st.agentBash"), agentBashCommand(origin, code, version))}
    ${commandBlock(t("st.agentPowerShell"), agentPowerShellCommand(origin, code, version))}
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

export function expiredLine() {
  return `<div class="callout warn agent-expired" role="status" data-agent-wait>${icon("alert")}<span>${esc(t("st.agentExpired"))}</span>
    <button class="btn btn-sm" type="button" data-agent-new>${icon("refresh")}${esc(t("st.agentNewCode"))}</button></div>`;
}

/**
 * Checks the host list until the agent that paired with `hostId` is connected. When the code runs out with no host
 * created, `onExpired` runs instead. Returns a function that stops the checks.
 */
export function watchAgent(hostId, expiresAt, { onConnected, onExpired }) {
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

export async function withBusyHost(btn, fn) {
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
  }
}

export function trustHostKey(fingerprint, confirmText = t("st.hostTrust")) {
  return confirmDialog({
    title: t("st.hostTrustTitle"),
    message: esc(t("st.hostTrustMessage", { fingerprint })),
    confirmText,
  });
}

export async function testHost(form, result, fingerprint) {
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
