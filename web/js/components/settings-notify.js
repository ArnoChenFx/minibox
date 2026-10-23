import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime, relTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { failureOf, NOTICE_KINDS, CHANNEL_TYPES, channelBody } from "../lib/notify-state.js";
import { emptyState, withBusy, toastError, toast, openDialog, confirmDialog } from "../lib/ui.js";
import { bindToggles, limitList } from "./list-toggle.js";

const NOTIFY_DELIVERIES = 20;

const kindLabel = (kind) => t(`st.notifyKind.${kind}`);

const typeLabel = (type) => t(`st.notifyType.${type}`);

function failureText(code) {
  const failure = failureOf(code);
  return failure ? t(failure.key, failure.params) : "";
}

/** The notification channels, and the latest sends to them: each attempt, and why a failed one failed. */
export async function loadNotify(view) {
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
  const channelList = limitList(view, "channels", channels);
  const deliveryList = limitList(view, "deliveries", deliveries);
  const channelRows = channels.length
    ? channelList.shown.map(notifyChannelRow).join("")
    : `<tr><td colspan="5">${emptyState({ iconName: "zap", title: t("st.notifyNone") })}</td></tr>`;
  const deliveryRows = deliveries.length
    ? deliveryList.shown.map(deliveryRow).join("")
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
    <div class="list-more">${channelList.toggle}</div>
    <div class="card-note"><strong>${t("st.notifyDeliveries")}</strong><p class="help">${t("st.notifyDeliveriesHelp")}</p></div>
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>${t("st.notifyColWhen")}</th><th>${t("st.notifyColChannel")}</th><th>${t("st.notifyColNotice")}</th>
        <th>${t("st.notifyColResult")}</th><th class="hide-sm">${t("st.notifyColAttempts")}</th>
      </tr></thead>
      <tbody>${deliveryRows}</tbody>
    </table></div>
    <div class="list-more">${deliveryList.toggle}</div>`;
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
  bindToggles(view, card, () => loadNotify(view));
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
          <label class="field">${t("st.notifyUrl")}<input class="input mono" name="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="${esc(existing?.type === "webhook" && existing.url ? existing.url : "https://hooks.example.com/minibox")}" /><span class="help">${existing?.type === "webhook" && existing.url ? t("st.notifyUrlKept") : t("st.notifyUrlHelp")}</span></label>
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
