import { esc, copyText } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import {
  installCommands,
  windowsInstallCommands,
  setupCommands,
  windowsSetupCommands,
  connectCommands,
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

export function openSshDialog(box) {
  const origin = location.origin;
  const { root } = openDialog({
    title: t("bd.sshTitle"),
    description: esc(t("bd.sshIntro")),
    iconName: "terminal",
    wide: true,
    body: `<div class="ssh-steps">
      ${sshStep(1, t("bd.sshInstall"), t("bd.sshInstallHelp"), [
        { label: t("bd.sshUnix"), commands: installCommands(origin) },
        { label: t("bd.sshWindows"), commands: windowsInstallCommands(origin), note: t("bd.sshInstallWindowsNote") },
      ])}
      ${sshStep(2, t("bd.sshSetup"), t("bd.sshSetupHelp", { settings: t("nav.settings"), tokens: t("st.tokens") }), [
        { label: t("bd.sshUnix"), commands: setupCommands(origin) },
        { label: t("bd.sshWindows"), commands: windowsSetupCommands(origin), note: t("bd.sshSetupWindowsNote") },
      ])}
      ${sshStep(3, t("bd.sshConnect"), t("bd.sshConnectHelp"), [{ commands: connectCommands(box.name) }])}
    </div>`,
    footer: `<button class="btn" data-close type="button">${t("common.close")}</button>`,
  });
  root.addEventListener("click", async (event) => {
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
