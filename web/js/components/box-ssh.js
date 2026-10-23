import { api } from "../lib/api.js";
import { esc, copyText } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import {
  installCommands,
  windowsInstallCommands,
  setupCommands,
  windowsSetupCommands,
  connectCommands,
  directAddress,
  directCommand,
} from "../lib/ssh.js";
import { openDialog, toast, toastError } from "../lib/ui.js";

/**
 * `blocks` are the commands of one step. Each has an optional label (the shell or PowerShell line) and an optional
 * note. The command scrolls sideways instead of breaking inside a word, and its copy button stays beside its label.
 */
function sshStep(number, title, help, blocks) {
  const commands = blocks
    .map(
      ({ label = "", commands: text, note = "" }) => `<div class="ssh-cmd">
      <div class="ssh-cmd-head">
        <span class="ssh-label">${esc(label)}</span>
        <button class="btn btn-sm" type="button" data-copy="${esc(text)}">${icon("copy")}${esc(t("bd.sshCopy"))}</button>
      </div>
      <pre class="token-snippet" tabindex="0">${esc(text)}</pre>
      ${note ? `<p class="help ssh-note">${esc(note)}</p>` : ""}
    </div>`,
    )
    .join("");
  return `<section class="ssh-step">
    <div class="ssh-step-head"><span class="ssh-step-num">${number}</span><strong>${esc(title)}</strong></div>
    <p class="help">${esc(help)}</p>
    ${commands}
  </section>`;
}

/** One login field a client asks for, with a copy button when there is a value to copy. */
function directField(label, value, { copy = true, mono = true } = {}) {
  const button = copy
    ? `<button class="icon-btn" type="button" data-copy="${esc(value)}" title="${esc(t("bd.sshCopy"))}" aria-label="${esc(`${t("bd.sshCopy")} ${label}`)}">${icon("copy")}</button>`
    : "";
  return `<div class="ssh-field"><dt>${esc(label)}</dt><dd class="${mono ? "mono" : ""}">${esc(value)}</dd><span>${button}</span></div>`;
}

/** The fields a GUI client such as Termius asks for, then the same login as one OpenSSH command. */
function directPane(box, address, fingerprint) {
  if (!address) {
    return `<div class="callout">${icon("info")}<span>${esc(t("bd.sshDirectOff"))}</span></div>`;
  }
  return `<div class="ssh-steps">
    <p class="help">${esc(t("bd.sshDirectHelp"))}</p>
    <dl class="ssh-fields">
      ${directField(t("bd.sshDirectHost"), address.host)}
      ${directField(t("bd.sshDirectPort"), String(address.port))}
      ${directField(t("bd.sshDirectUser"), box.name)}
      ${directField(t("bd.sshDirectPassword"), t("bd.sshDirectPasswordValue"), { copy: false, mono: false })}
      ${directField(t("bd.sshDirectKey"), t("bd.sshDirectKeyValue", { settings: t("nav.settings"), keys: t("st.sshKeys") }), { copy: false, mono: false })}
      ${directField(t("bd.sshDirectFingerprint"), fingerprint)}
    </dl>
    <div class="ssh-cmd">
      <div class="ssh-cmd-head">
        <span class="ssh-label">${esc(t("bd.sshDirectCommand"))}</span>
        <button class="btn btn-sm" type="button" data-copy="${esc(directCommand(box.name, address))}">${icon("copy")}${esc(t("bd.sshCopy"))}</button>
      </div>
      <pre class="token-snippet" tabindex="0">${esc(directCommand(box.name, address))}</pre>
      <p class="help ssh-note">${esc(t("bd.sshDirectNote"))}</p>
    </div>
  </div>`;
}

function cliPane(box, origin) {
  return `<div class="ssh-steps">
      ${sshStep(1, t("bd.sshInstall"), t("bd.sshInstallHelp"), [
        { label: t("bd.sshUnix"), commands: installCommands(origin) },
        { label: t("bd.sshWindows"), commands: windowsInstallCommands(origin), note: t("bd.sshInstallWindowsNote") },
      ])}
      ${sshStep(2, t("bd.sshSetup"), t("bd.sshSetupHelp", { settings: t("nav.settings"), tokens: t("st.tokens") }), [
        { label: t("bd.sshUnix"), commands: setupCommands(origin) },
        { label: t("bd.sshWindows"), commands: windowsSetupCommands(origin), note: t("bd.sshSetupWindowsNote") },
      ])}
      ${sshStep(3, t("bd.sshConnect"), t("bd.sshConnectHelp"), [{ commands: connectCommands(box.name) }])}
    </div>`;
}

function modeButton(mode, active, label, hint) {
  return `<button type="button" class="seg" data-ssh-mode="${mode}" aria-pressed="${mode === active}"><strong>${esc(label)}</strong><span>${esc(hint)}</span></button>`;
}

/** The server's direct listener and host key. A failed read shows the CLI steps alone, which need neither. */
async function hostKeyOf() {
  try {
    return await api("/api/ssh/host-key");
  } catch {
    return null;
  }
}

/**
 * Two ways in, one shown at a time: a standard client straight to the server's SSH port, or OpenSSH through the
 * minibox CLI over HTTPS. Direct comes first when the server listens for it.
 */
export async function openSshDialog(box) {
  const origin = location.origin;
  const key = await hostKeyOf();
  const address = directAddress(key?.direct, location.hostname);
  const active = address ? "direct" : "cli";
  const { root } = openDialog({
    title: t("bd.sshTitle"),
    description: esc(t("bd.sshIntro")),
    iconName: "terminal",
    wide: true,
    body: `<div class="ssh-modes">
      <div class="segmented segmented-2" role="group" aria-label="${esc(t("bd.sshMode"))}">
        ${modeButton("direct", active, t("bd.sshModeDirect"), t("bd.sshModeDirectHint"))}
        ${modeButton("cli", active, t("bd.sshModeCli"), t("bd.sshModeCliHint"))}
      </div>
      <div data-ssh-pane="direct"${active === "direct" ? "" : " hidden"}>${directPane(box, address, key?.fingerprint ?? "")}</div>
      <div data-ssh-pane="cli"${active === "cli" ? "" : " hidden"}>${cliPane(box, origin)}</div>
    </div>`,
    footer: `<button class="btn" data-close type="button">${t("common.close")}</button>`,
  });
  root.addEventListener("click", async (event) => {
    const mode = event.target.closest("[data-ssh-mode]");
    if (mode) {
      root.querySelectorAll("[data-ssh-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b === mode)));
      root.querySelectorAll("[data-ssh-pane]").forEach((pane) => {
        pane.hidden = pane.dataset.sshPane !== mode.dataset.sshMode;
      });
      return;
    }
    const button = event.target.closest("[data-copy]");
    if (!button) return;
    try {
      await copyText(button.dataset.copy);
      toast(t("bd.sshCopied"));
    } catch (err) {
      toastError(t("bd.sshCopyFailed"), err);
    }
  });
}
