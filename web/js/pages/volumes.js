import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { bytes } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { confirmDialog, emptyState, nameError, openDialog, skeletonRows, toast, toastError } from "../lib/ui.js";

const ROLES = [
  ["workspace", "vol.roleWorkspace"],
  ["home", "vol.roleHome"],
  ["tools", "vol.roleTools"],
  ["cache", "vol.roleCache"],
];

const healthBadge = (status, low) => {
  const cls = status === "reachable" ? "badge-success" : status === "unreachable" ? "badge-danger" : "";
  const label =
    status === "reachable" ? t("vol.reachable") : status === "unreachable" ? t("vol.unreachable") : t("vol.unknown");
  const extra = low ? ` <span class="badge badge-warning">${esc(t("vol.lowSpace"))}</span>` : "";
  return `<span class="badge ${cls}">${esc(label)}</span>${extra}`;
};

function field(label, inner) {
  return `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
}

/** What saving the pools would change. `t()` does not escape, so the whole sentence is escaped once here. */
function poolPreviewHtml(preview) {
  const pools = preview.pools
    .map((pool) => `${pool.name} · ${pool.backend}${pool.default ? ` · ${t("vol.defaultYes")}` : ""}`)
    .join("\n");
  return `<p class="help">${esc(t("vol.savePreviewNote"))}</p>
    <div class="field"><span class="label">${esc(t("vol.savePreviewPools"))}</span><pre class="mono">${esc(pools)}</pre></div>
    ${preview.added.length ? `<p>${esc(t("vol.savePreviewAdded", { names: preview.added.join(", ") }))}</p>` : ""}
    ${preview.removed.length ? `<p>${esc(t("vol.savePreviewRemoved", { names: preview.removed.join(", ") }))}</p>` : ""}`;
}

/** Saves the pools. A replacement that would change the pool list is first refused with its preview, and sent again once the user confirms. */
async function putPools(body) {
  try {
    return await api("/api/pools", { method: "PUT", body });
  } catch (err) {
    if (err.code !== "confirmation_required" || !err.details?.preview) throw err;
    const ok = await confirmDialog({
      title: t("vol.savePreviewTitle"),
      body: poolPreviewHtml(err.details.preview),
      confirmText: t("vol.save"),
    });
    if (!ok) return null;
    return api("/api/pools", { method: "PUT", body: { ...body, confirm: true } });
  }
}

function formDialog(title, body) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const { root, close } = openDialog({
      title,
      body,
      onClose: () => finish(null),
      footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="vol-ok">${t("common.confirm")}</button>`,
    });
    root.querySelector("#vol-ok").addEventListener("click", () => {
      finish(root);
      close();
    });
  });
}

export function render(view) {
  let pools = [];
  let roles = { workspace: null, home: null, tools: null, cache: null };
  let health = [];
  let volumes = [];
  view.innerHTML = `
    <div class="page-head">
      <div><h1>${t("nav.volumes")}</h1><p>${t("vol.subtitle")}</p></div>
      <div class="page-actions">
        <button class="btn" data-action="refresh">${icon("refresh")}${t("common.refresh")}</button>
        <button class="btn" data-action="add-nfs">${t("vol.addNfs")}</button>
        <button class="btn" data-action="add-path">${t("vol.addPath")}</button>
        <button class="btn btn-primary" data-action="create">${icon("plus")}${t("vol.create")}</button>
      </div>
    </div>
    <div id="volBody">${skeletonRows(3, 4)}</div>`;

  const healthOf = (name) => health.find((item) => item.pool === name);

  const draw = () => {
    const poolRows = pools
      .map((pool) => {
        const item = healthOf(pool.name);
        const free = item?.freeBytes != null ? bytes(item.freeBytes) : "—";
        const remove =
          pool.name === "local"
            ? ""
            : `<button class="btn btn-sm" data-action="remove-pool" data-name="${esc(pool.name)}">${t("vol.removePool")}</button>`;
        return `<tr>
          <td><strong>${esc(pool.name)}</strong> ${pool.default ? `<span class="badge">${esc(t("vol.defaultYes"))}</span>` : ""}</td>
          <td>${esc(pool.backend)}</td>
          <td>${healthBadge(item?.status ?? "unknown", item?.lowSpace)}</td>
          <td class="num">${esc(free)}</td>
          <td>${item?.message ? `<span class="subtle">${esc(item.message)}</span>` : "—"}</td>
          <td><button class="btn btn-sm" data-action="make-default" data-name="${esc(pool.name)}">${t("vol.defaultYes")}</button> ${remove}</td>
        </tr>`;
      })
      .join("");
    const roleFields = ROLES.map(([role, label]) => {
      const options = [`<option value="">${esc(t("vol.roleRule"))}</option>`]
        .concat(
          pools.map(
            (pool) =>
              `<option value="${esc(pool.name)}" ${roles[role] === pool.name ? "selected" : ""}>${esc(pool.name)}</option>`,
          ),
        )
        .join("");
      return field(t(label), `<select class="select" data-role="${role}">${options}</select>`);
    }).join("");
    const volumeRows = volumes
      .map((volume) => {
        const mounts = volume.mounts
          .map((mount) => `${esc(mount.boxName)}:${esc(mount.path)} (${esc(mount.mode)})`)
          .join(", ");
        return `<tr>
          <td><strong>${esc(volume.name)}</strong><div class="subtle mono">${esc(volume.id)}</div></td>
          <td>${volume.role ? esc(t(ROLES.find(([role]) => role === volume.role)?.[1] ?? "vol.unknown")) : "—"}</td>
          <td>${esc(volume.pool)}${volume.backend && volume.backend !== volume.pool ? ` <span class="subtle">${esc(volume.backend)}</span>` : ""}</td>
          <td>${volume.ownership === "owned" ? esc(t("vol.owned")) : esc(t("vol.independent"))}</td>
          <td>${esc(mounts || "—")}</td>
          <td class="num">${volume.bytes == null ? "—" : esc(bytes(volume.bytes))}</td>
          <td class="actions">
            <button class="btn btn-sm" data-action="measure" data-id="${esc(volume.id)}">${t("vol.measure")}</button>
            <button class="btn btn-sm" data-action="delete" data-id="${esc(volume.id)}" data-name="${esc(volume.name)}">${t("vol.delete")}</button>
          </td>
        </tr>`;
      })
      .join("");
    view.querySelector("#volBody").innerHTML = `
      <div class="card"><div class="card-head"><h3>${t("vol.pools")}</h3>
        <button class="btn btn-primary btn-sm" data-action="save">${t("vol.save")}</button></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>${t("vol.colName")}</th><th>${t("vol.colBackend")}</th><th>${t("vol.colHealth")}</th><th>${t("vol.colFree")}</th><th></th><th></th></tr></thead>
          <tbody>${poolRows}</tbody>
        </table></div>
        <div class="card-body"><h3>${t("vol.roles")}</h3><p class="help">${t("vol.cacheHint")}</p><div class="grid grid-2">${roleFields}</div></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h3>${t("vol.volumes")}</h3></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>${t("vol.colName")}</th><th>${t("vol.colRole")}</th><th>${t("vol.colPool")}</th><th>${t("vol.colOwnership")}</th><th>${t("vol.colMounts")}</th><th>${t("vol.colBytes")}</th><th></th></tr></thead>
          <tbody>${volumeRows || `<tr><td colspan="7">${emptyState({ iconName: "folder", title: t("vol.none"), text: "" })}</td></tr>`}</tbody>
        </table></div>
      </div>`;
  };

  const load = async () => {
    const [poolBody, volumeBody] = await Promise.all([api("/api/pools?refresh=true"), api("/api/volumes")]);
    pools = poolBody.pools;
    roles = { ...roles, ...poolBody.roles };
    health = poolBody.health;
    volumes = volumeBody.volumes;
    draw();
  };

  const readRoles = () => {
    const next = {};
    for (const [role] of ROLES) {
      const value = view.querySelector(`[data-role="${role}"]`)?.value ?? "";
      next[role] = value || null;
    }
    return next;
  };

  const save = async () => {
    const saved = await putPools({
      pools: pools.map((pool) => ({
        name: pool.name,
        backend: pool.backend,
        default: pool.default,
        server: pool.server ?? undefined,
        export: pool.export ?? undefined,
        options: pool.options,
        root: pool.root ?? undefined,
        marker: pool.marker ?? undefined,
      })),
      roles: readRoles(),
    });
    if (!saved) return;
    pools = saved.pools;
    roles = saved.roles;
    health = saved.health;
    toast(t("vol.saved"));
    draw();
  };

  const addPool = (pool) => {
    if (pools.some((item) => item.name === pool.name)) {
      toastError(t("vol.saveFailed"), { message: t("err.pool_duplicate") });
      return;
    }
    if (pool.default) pools = pools.map((item) => ({ ...item, default: false }));
    pools = [...pools, pool];
    draw();
  };

  view.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target || !view.contains(target)) return;
    const action = target.dataset.action;
    try {
      if (action === "refresh") {
        target.disabled = true;
        await load();
        target.disabled = false;
      } else if (action === "save") {
        await save();
      } else if (action === "make-default") {
        pools = pools.map((pool) => ({ ...pool, default: pool.name === target.dataset.name }));
        draw();
      } else if (action === "remove-pool") {
        pools = pools.filter((pool) => pool.name !== target.dataset.name);
        if (!pools.some((pool) => pool.default)) {
          pools = pools.map((pool) => ({ ...pool, default: pool.name === "local" }));
        }
        draw();
      } else if (action === "add-nfs") {
        const body = `
          ${field(t("vol.poolName"), `<input class="input" id="p-name" />`)}
          ${field(t("vol.server"), `<input class="input" id="p-server" placeholder="192.168.1.10" />`)}
          ${field(t("vol.exportPath"), `<input class="input" id="p-export" placeholder="/volume1/minibox" />`)}
          ${field(t("vol.options"), `<input class="input" id="p-options" placeholder="nfsvers=4.1, hard" />`)}
          <p class="help">${t("vol.optionsHelp")}</p>
          <label class="checkbox"><input type="checkbox" id="p-default" /> ${esc(t("vol.makeDefault"))}</label>`;
        const root = await formDialog(t("vol.addNfs"), body);
        if (!root) return;
        const name = root.querySelector("#p-name").value.trim();
        const invalid = nameError(name, "name");
        if (invalid) return toastError(t("vol.saveFailed"), { message: invalid });
        addPool({
          name,
          backend: "nfs",
          default: root.querySelector("#p-default").checked,
          server: root.querySelector("#p-server").value.trim(),
          export: root.querySelector("#p-export").value.trim(),
          options: root
            .querySelector("#p-options")
            .value.split(",")
            .map((part) => part.trim())
            .filter(Boolean),
          root: null,
          marker: null,
          capabilities: { shareable: true, snapshots: false, quota: false, clone: false, crossHost: true },
        });
      } else if (action === "add-path") {
        const body = `
          ${field(t("vol.poolName"), `<input class="input" id="p-name" />`)}
          ${field(t("vol.root"), `<input class="input" id="p-root" placeholder="/mnt/disk" />`)}
          ${field(t("vol.marker"), `<input class="input" id="p-marker" value=".minibox-mounted" />`)}
          <p class="help">${t("vol.markerHelp")}</p>
          <label class="checkbox"><input type="checkbox" id="p-default" /> ${esc(t("vol.makeDefault"))}</label>`;
        const root = await formDialog(t("vol.addPath"), body);
        if (!root) return;
        const name = root.querySelector("#p-name").value.trim();
        const invalid = nameError(name, "name");
        if (invalid) return toastError(t("vol.saveFailed"), { message: invalid });
        addPool({
          name,
          backend: "path",
          default: root.querySelector("#p-default").checked,
          server: null,
          export: null,
          options: [],
          root: root.querySelector("#p-root").value.trim(),
          marker: root.querySelector("#p-marker").value.trim() || ".minibox-mounted",
          capabilities: { shareable: true, snapshots: false, quota: false, clone: false, crossHost: false },
        });
      } else if (action === "create") {
        const options = pools.map((pool) => `<option value="${esc(pool.name)}">${esc(pool.name)}</option>`).join("");
        const roleOptions = [`<option value="">—</option>`]
          .concat(ROLES.map(([role, label]) => `<option value="${role}">${esc(t(label))}</option>`))
          .join("");
        const root = await formDialog(
          t("vol.createTitle"),
          `${field(t("vol.colName"), `<input class="input" id="v-name" />`)}
           ${field(t("vol.colPool"), `<select class="select" id="v-pool">${options}</select>`)}
           ${field(t("vol.colRole"), `<select class="select" id="v-role">${roleOptions}</select>`)}`,
        );
        if (!root) return;
        const name = root.querySelector("#v-name").value.trim();
        const invalid = nameError(name, "name");
        if (invalid) return toastError(t("vol.createFailed"), { message: invalid });
        await api("/api/volumes", {
          method: "POST",
          body: {
            name,
            pool: root.querySelector("#v-pool").value,
            role: root.querySelector("#v-role").value || null,
            confirm: true,
          },
        });
        toast(t("vol.created"));
        await load();
      } else if (action === "delete") {
        const ok = await confirmDialog({
          title: t("vol.deleteTitle"),
          message: esc(t("vol.deleteMessage", { name: target.dataset.name })),
          confirmText: t("vol.delete"),
          danger: true,
        });
        if (!ok) return;
        await api(`/api/volumes/${enc(target.dataset.id)}?confirm=true`, { method: "DELETE" });
        toast(t("vol.deleted"));
        await load();
      } else if (action === "measure") {
        const result = await api(`/api/volumes/${enc(target.dataset.id)}/usage`, { method: "POST" });
        toast(t("vol.measure"), { message: t("vol.measured", { bytes: bytes(result.volume.bytes) }) });
        await load();
      }
    } catch (e) {
      toastError(t("vol.loadingFailed"), e);
      if (action === "refresh") target.disabled = false;
    }
  });

  load().catch((e) => {
    view.querySelector("#volBody").innerHTML = emptyState({
      iconName: "alert",
      title: t("vol.loadingFailed"),
      text: esc(e.message),
    });
  });
}
