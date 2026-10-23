import { api } from "../lib/api.js";
import { applyBoxFrame, boxesOfSync } from "../lib/box-state.js";
import { delegate, esc } from "../lib/dom.js";
import { boxesOnHost, hostOfBox } from "../lib/host-list.js";
import { hostFilter, hostName, multiHost, onHosts } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { subscribe } from "../lib/live.js";
import { tabHash } from "../lib/routes.js";
import { emptyState } from "../lib/ui.js";
import { openCreateBox } from "./create-box.js";

const LOADING = `<div class="card"><div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div></div>`;

const labelOf = (box) => (multiHost() ? `${box.name} · ${hostName(hostOfBox(box))}` : box.name);

const noBoxesState = () =>
  emptyState({
    iconName: "box",
    title: t("ov.noBoxes"),
    text: t("ov.noBoxesText"),
    action: `<button class="btn btn-primary" data-action="create">${icon("plus")}${t("box.create")}</button>`,
  });

const hostEmptyState = () =>
  emptyState({
    iconName: "box",
    title: t("bx.noHostBoxes"),
    text: t("bx.noHostBoxesText", { host: esc(hostName(hostFilter())) }),
  });

/**
 * A section tab that works on one box: a picker for the box, then what `mount` draws for it. The address names the box
 * by its `boxId`, which survives a rebuild (a rebuild changes the container id). The picker lists the boxes that the
 * top bar's host filter lets through, and the address follows the box on screen. `mount(root, { box, refreshBox })`
 * draws into a fresh element and returns its cleanup.
 */
export function mountBoxTab(root, { section, tab, arg = "", mount }) {
  root.innerHTML = `<div class="page-head"><div class="page-actions">
      <div class="box-pick" hidden><label for="boxPick">${esc(t("pick.box"))}</label><select class="select" id="boxPick"></select></div>
    </div></div>
    <div id="boxTabBody">${LOADING}</div>`;
  const pick = root.querySelector(".box-pick");
  const select = root.querySelector("#boxPick");
  const body = root.querySelector("#boxTabBody");

  let disposed = false;
  let boxes = null;
  let failure = null;
  let selected = null;
  let shownKey = "";
  let shownOptions = "";
  let unmount = null;

  const addressOf = (box) => tabHash(section, tab, box.boxId);
  const scoped = () => boxesOnHost(boxes ?? [], hostFilter());

  const show = (box) => {
    selected = box;
    const key = box ? `${box.boxId}/${box.id}` : "";
    if (key === shownKey) return;
    shownKey = key;
    unmount?.();
    unmount = null;
    body.replaceChildren();
    if (!box) return;
    const slot = document.createElement("div");
    body.append(slot);
    unmount = mount(slot, { box: () => selected, refreshBox: load }) ?? null;
  };

  const drawOptions = (list) => {
    const html = list.map((box) => `<option value="${esc(box.boxId)}">${esc(labelOf(box))}</option>`).join("");
    if (html === shownOptions) return;
    shownOptions = html;
    select.innerHTML = html;
  };

  const reconcile = () => {
    if (disposed) return;
    if (boxes === null) {
      if (failure) {
        pick.hidden = true;
        body.innerHTML = emptyState({ iconName: "alert", title: t("bd.loadFailed"), text: esc(failure.message) });
      }
      return;
    }
    const list = scoped();
    if (!list.length) {
      pick.hidden = true;
      shownOptions = "";
      select.innerHTML = "";
      show(null);
      body.innerHTML = boxes.length ? hostEmptyState() : noBoxesState();
      return;
    }
    const next = list.find((box) => box.boxId === selected?.boxId) ?? list.find((box) => box.boxId === arg) ?? list[0];
    pick.hidden = false;
    drawOptions(list);
    select.value = next.boxId;
    show(next);
    if (location.hash !== addressOf(next)) history.replaceState(null, "", addressOf(next));
  };

  async function load() {
    try {
      boxes = (await api("/api/boxes?stats=false")).boxes;
      failure = null;
    } catch (err) {
      failure = err;
    }
    reconcile();
  }

  select.addEventListener("change", () => {
    const next = scoped().find((box) => box.boxId === select.value);
    if (next) location.hash = addressOf(next);
  });
  delegate(body, {
    create: () => openCreateBox({ onCreated: (box) => (location.hash = addressOf(box)) }),
  });

  const offs = [
    onHosts(reconcile),
    subscribe("sync", (frame) => {
      const next = boxesOfSync(frame);
      if (!next) return;
      boxes = next;
      reconcile();
    }),
    subscribe("box", (frame) => {
      if (boxes === null) return;
      boxes = applyBoxFrame(boxes, frame);
      reconcile();
    }),
  ];
  void load();
  return () => {
    disposed = true;
    for (const off of offs) off();
    unmount?.();
    unmount = null;
  };
}
