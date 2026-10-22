import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { emptyState, promptDialog, toast, toastError, confirmDialog } from "../lib/ui.js";

export function mountPorts(root, { box }) {
  const draw = async () => {
    const b = box();
    root.innerHTML = `<div class="card"><div class="card-body"><span class="spinner"></span> ${esc(t("bd.portsLoading"))}</div></div>`;
    let ports = [];
    try {
      ports = (await api(`/api/boxes/${enc(b.id)}/ports`)).ports;
    } catch (e) {
      root.innerHTML = emptyState({ iconName: "alert", title: t("bd.portsLoadFailed"), text: esc(e.message) });
      return;
    }
    const rows = ports
      .map((p) => {
        const source = p.source === "listening" ? t("bd.portsListening") : t("bd.portsManual");
        const remove =
          p.source === "manual"
            ? `<button class="btn btn-sm" data-action="port-remove" data-port="${p.port}">${t("bd.portsRemove")}</button>`
            : "";
        return `<tr>
            <td class="mono">${p.port}</td>
            <td>${esc(source)}</td>
            <td class="mono"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a></td>
            <td class="actions">
              <a class="btn btn-sm btn-primary" href="${esc(p.url)}" target="_blank" rel="noopener">${icon("externalLink")}${t("bd.portsOpen")}</a>
              ${remove}
            </td>
          </tr>`;
      })
      .join("");
    const body = ports.length
      ? `<div class="table-wrap"><table class="table"><thead><tr>
            <th>${t("bd.portsColPort")}</th><th>${t("bd.portsColSource")}</th><th>${t("bd.portsColUrl")}</th><th></th>
          </tr></thead><tbody>${rows}</tbody></table></div>`
      : emptyState({
          iconName: "externalLink",
          title: t("bd.portsEmpty"),
          text: b.running ? t("bd.portsEmptyText") : t("bd.portsNotRunning"),
        });
    root.innerHTML = `<div class="card"><div class="card-head"><h3>${t("bd.portsTitle")}</h3>
        <div class="actions">
          <button class="btn btn-sm" data-action="port-refresh">${icon("refresh")}${t("bd.portsRefresh")}</button>
          <button class="btn btn-sm btn-primary" data-action="port-add">${icon("plus")}${t("bd.portsAdd")}</button>
        </div></div>
        <div class="card-body"><p class="help">${t("bd.portsHelp")}</p></div>
        ${body}</div>`;
  };
  root.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const b = box();
    if (btn.dataset.action === "port-refresh") void draw();
    if (btn.dataset.action === "port-add") {
      void (async () => {
        const value = await promptDialog({
          title: t("bd.portsAddTitle"),
          description: t("bd.portsAddText"),
          iconName: "externalLink",
          label: t("bd.portsPort"),
          value: "3000",
          confirmText: t("bd.portsAdd"),
          validate: (v) => {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 1 || n > 65535) return t("err.preview_port_invalid");
            return "";
          },
        });
        if (value === null) return;
        try {
          await api(`/api/boxes/${enc(b.id)}/ports`, { method: "POST", body: { port: Number(value) } });
          toast(t("bd.portsAdded"));
          await draw();
        } catch (e) {
          toastError(t("bd.portsAddFailed"), e);
        }
      })();
    }
    if (btn.dataset.action === "port-remove") {
      const port = Number(btn.dataset.port);
      void (async () => {
        const ok = await confirmDialog({
          title: t("bd.portsRemove"),
          message: String(port),
          confirmText: t("bd.portsRemove"),
          danger: true,
        });
        if (!ok) return;
        try {
          await api(`/api/boxes/${enc(b.id)}/ports/${port}`, { method: "DELETE" });
          toast(t("bd.portsRemoved"));
          await draw();
        } catch (e) {
          toastError(t("bd.portsRemoveFailed"), e);
        }
      })();
    }
  });
  void draw();
  return () => {};
}
