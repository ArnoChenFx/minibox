import { copyText, esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { openDialog, toast } from "../lib/ui.js";

/** Keep a right click in the browser instead of forwarding it to tmux or an application. */
const onMouseDown = (event) => {
  if (event.button === 2 && !event.shiftKey) event.stopPropagation();
};

/** Clipboard actions stay local to this terminal; pastes retain the session and permission that started them. */
export function mountTerminalClipboard(root, { xterm, screen, getPasteTarget, onPaste }) {
  const copyButton = root.querySelector("#tCopy");
  const pasteButton = root.querySelector("#tPaste");
  const mac = /Mac|iPhone|iPad/.test(navigator.platform ?? "");
  root.querySelector("#tClipboardHint").textContent = t(mac ? "bd.termClipboardMac" : "bd.termClipboardHelp");
  const menu = document.createElement("div");
  menu.className = "term-clipboard-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("bd.termClipboard"));
  menu.hidden = true;
  menu.innerHTML = `<button type="button" role="menuitem" data-clipboard="copy">${esc(t("bd.termCopy"))}</button>
    <button type="button" role="menuitem" data-clipboard="paste">${esc(t("bd.termPaste"))}</button>
    <button type="button" role="menuitem" data-clipboard="select">${esc(t("bd.termSelectAll"))}</button>`;
  document.body.append(menu);
  let disposed = false;
  let busy = false;
  let dialog = null;

  const update = () => {
    copyButton.disabled = !xterm.hasSelection();
    pasteButton.disabled = busy || !getPasteTarget();
    menu.querySelector('[data-clipboard="copy"]').disabled = copyButton.disabled;
    menu.querySelector('[data-clipboard="paste"]').disabled = pasteButton.disabled;
  };
  const hide = (focus = false) => {
    if (menu.hidden) return;
    menu.hidden = true;
    if (focus && !disposed) xterm.focus();
  };
  const copy = async () => {
    const text = xterm.getSelection();
    hide(true);
    if (!text) return;
    xterm.focus();
    try {
      await copyText(text);
    } catch {
      if (!disposed) toast(t("bd.termCopyFailed"), { type: "error" });
    }
  };

  // Native paste into an ordinary field works on HTTP too, and does not need clipboard-read permission.
  const manualPaste = () =>
    new Promise((resolve) => {
      let text = null;
      dialog = openDialog({
        title: t("bd.termPaste"),
        description: esc(t("bd.termPasteHelp")),
        body: `<label class="label" for="tPasteText">${esc(t("bd.termPasteText"))}</label>
        <textarea class="textarea mono" id="tPasteText" rows="6" spellcheck="false" autofocus></textarea>`,
        footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button>
        <button class="btn btn-primary" id="tPasteConfirm">${esc(t("bd.termPaste"))}</button>`,
        onClose: () => {
          dialog = null;
          resolve(text);
        },
      });
      const current = dialog;
      current.root.querySelector("#tPasteConfirm").addEventListener("click", () => {
        text = current.root.querySelector("#tPasteText").value;
        current.close();
      });
    });
  const paste = async () => {
    const target = getPasteTarget();
    hide(true);
    if (busy || !target) return;
    busy = true;
    update();
    try {
      let text;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        if (disposed || !target.isActive()) return;
        text = await manualPaste();
      }
      if (!disposed && text !== null && target.isActive()) target.paste(text);
    } finally {
      busy = false;
      if (!disposed) update();
    }
  };
  const show = (x, y) => {
    update();
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    menu.querySelector("button:not(:disabled)")?.focus();
  };
  const onContext = (event) => {
    // Shift + right click still opens the browser's native menu.
    if (event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = screen.getBoundingClientRect();
    show(event.clientX || rect.left + 12, event.clientY || rect.top + 12);
  };
  const onMenuClick = (event) => {
    const action = event.target.closest("[data-clipboard]")?.dataset.clipboard;
    if (action === "copy") void copy();
    else if (action === "paste") void paste();
    else if (action === "select") {
      hide(true);
      xterm.selectAll();
    }
  };
  const onMenuKey = (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      hide(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = [...menu.querySelectorAll("button:not(:disabled)")];
      const at = items.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  };
  const dismiss = (event) => {
    if (!menu.contains(event.target)) hide();
  };
  const onViewport = () => hide();
  const onNativePaste = () => onPaste();
  xterm.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const rect = screen.getBoundingClientRect();
      show(rect.left + 12, rect.top + 12);
      return false;
    }
    if (event.altKey) return true;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === "c" && (xterm.hasSelection() || event.shiftKey || event.metaKey)) {
      event.preventDefault();
      void copy();
      return false;
    }
    if ((command && event.key.toLowerCase() === "v") || (event.shiftKey && event.key === "Insert")) {
      // Let the browser's trusted paste event reach xterm. Calling readText here would break HTTP and denied permissions.
      if (!getPasteTarget()) event.preventDefault();
      onPaste();
      return false;
    }
    // With no selection, Ctrl+C remains the shell's interrupt.
    return true;
  });
  const selection = xterm.onSelectionChange(update);
  copyButton.addEventListener("click", copy);
  pasteButton.addEventListener("click", paste);
  screen.addEventListener("mousedown", onMouseDown, true);
  screen.addEventListener("contextmenu", onContext, true);
  screen.addEventListener("paste", onNativePaste, true);
  menu.addEventListener("click", onMenuClick);
  menu.addEventListener("keydown", onMenuKey);
  document.addEventListener("pointerdown", dismiss, true);
  window.addEventListener("scroll", onViewport, true);
  window.addEventListener("resize", onViewport);
  update();
  return {
    update,
    dispose() {
      disposed = true;
      dialog?.close();
      selection.dispose();
      copyButton.removeEventListener("click", copy);
      pasteButton.removeEventListener("click", paste);
      screen.removeEventListener("mousedown", onMouseDown, true);
      screen.removeEventListener("contextmenu", onContext, true);
      screen.removeEventListener("paste", onNativePaste, true);
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("scroll", onViewport, true);
      window.removeEventListener("resize", onViewport);
      xterm.attachCustomKeyEventHandler(() => true);
      menu.remove();
    },
  };
}
