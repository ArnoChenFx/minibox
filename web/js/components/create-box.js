import { api, enc } from "../lib/api.js";
import { $$, esc } from "../lib/dom.js";
import {
  EGRESS_PRESETS,
  EGRESS_TIERS,
  egressRequestOf,
  presetHintKey,
  presetKey,
  tierHintKey,
  tierKey,
} from "../lib/egress.js";
import { checkEnvRows, isEnvErrorKey } from "../lib/env.js";
import { bytes, gbOrMb } from "../lib/format.js";
import { hostFilter, hostsNow, multiHost } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import {
  checkMountRows,
  createMountChoices,
  DEFAULT_MOUNTS,
  isVolumeErrorKey,
  MOUNT_MAX,
  roleOfValue,
  roleValue,
  sharedToolsChoice,
  volumeChoices,
} from "../lib/mounts.js";
import { filterBySearch, searchTerms } from "../lib/search.js";
import { chosenSummary, loadFolded, saveFolded } from "../lib/section-fold.js";
import { STARTUP_COMMAND_MAX_BYTES, startupProblem, startupProblemKey } from "../lib/startup.js";
import { getTemplates, hostNow, invalidateTemplates, refreshHost } from "../lib/store.js";
import {
  isUnbuilt,
  needsSync,
  syncSizeMb,
  templateCards,
  templateSearchFields,
  withOfficialCards,
} from "../lib/template-list.js";
import { cloneRepo } from "../lib/template-source.js";
import { pickerView } from "../lib/tool-list.js";
import { emptyState, nameError, openDialog, toast } from "../lib/ui.js";
import { bindEnvRows, envProblemText, envRow, readEnvRows, secretChoicesHtml, secretNames } from "./env-editor.js";
import { bindFoldSections, foldSectionHtml, setFoldOpen } from "./fold-section.js";
import { bindToggles, isToggled, limitList, listToggleHtml } from "./list-toggle.js";
import { mountRow, readMountRows, roleLabel } from "./mount-editor.js";
import { bindSearchBox, searchBoxHtml } from "./search-box.js";
import { openTasks, taskErrorText, waitTask } from "./tasks.js";

const PRESETS = [
  { id: "small", label: "cb.small", cpus: 2, memoryMb: 4096 },
  { id: "medium", label: "cb.medium", cpus: 4, memoryMb: 8192 },
  { id: "large", label: "cb.large", cpus: 8, memoryMb: 16384 },
  { id: "custom", label: "cb.custom" },
];

const PROFILES = ["standard", "strict", "relaxed"];

/** The host value that lets the control plane pick the host for the box. */
const AUTO_HOST = "auto";

const agentHost = (id) => hostsNow().find((h) => h.id === id)?.transport === "agent";

/** The text for a custom row the dialog refuses before sending. The server's own messages name the path or the role. */
function problemText(problem) {
  if (problem.code === "volume") return t("cb.mountVolumeRequired");
  if (problem.code === "mount_create_role_duplicate") {
    return t(`err.${problem.code}`, { role: roleLabel(problem.role) });
  }
  if (problem.code === "mount_create_role_path") {
    return t(`err.${problem.code}`, { ...problem, role: roleLabel(problem.role) });
  }
  return t(`err.${problem.code}`, { path: problem.path });
}

const categoryLabel = (id) => t(`tool.cat.${id}`);

/** The native checkbox stays for keyboard and screen-reader use; the row draws its own box and check mark. */
function toolCheckHtml(tool, selected) {
  const blocked = tool.needsRoot;
  return `<label class="check-row${blocked ? " is-disabled" : ""}">
    <input class="sr-only" type="checkbox" value="${esc(tool.id)}"${selected ? " checked" : ""}${blocked ? " disabled" : ""} />
    <span class="check-mark" aria-hidden="true">${icon("check")}</span>
    <span class="check-body">
      <span class="check-title"><strong>${esc(tool.name)}</strong>${blocked ? `<span class="badge badge-warning" title="${esc(t("tool.needsRootHelp"))}">${esc(t("tool.needsRoot"))}</span>` : ""}</span>
      <span class="subtle">${esc(tool.source)}${tool.requires ? ` · ${esc(tool.requires)}` : ""} · ~${esc(String(tool.estimatedMb))} MB</span>
      <span class="help">${esc(tool.description)}</span>
    </span></label>`;
}

/** A category's rows, under a header that folds them. A folded group keeps only its selected rows, which `pickerView` filtered. */
function toolGroupHtml(group, selected) {
  const label = esc(categoryLabel(group.category));
  return `<section class="tool-group" aria-label="${label}">
    <button type="button" class="tool-group-head" data-toggle="${esc(group.id)}" aria-expanded="${!group.folded}">${icon("chevron")}<strong>${label}</strong><span class="badge">${group.count}</span></button>
    <div class="tool-checks">${group.rows.map((tool) => toolCheckHtml(tool, selected.has(tool.id))).join("")}</div>
  </section>`;
}

function templateOptionHtml(template, selectedRef) {
  return `<div class="option" role="radio" tabindex="0" aria-checked="${template.ref === selectedRef}" data-ref="${esc(template.ref)}">
    <span class="avatar">${icon("layers")}</span>
    <span class="meta"><strong>${esc(template.name)}</strong><span>${esc(template.description ?? template.ref)}</span></span>
    <span class="subtle num">${isUnbuilt(template) ? esc(t("tp.buildsOnUse")) : bytes(template.size)}</span></div>`;
}

/** The volumes a custom row can pick, with the ones another live box owns marked unavailable. */
async function loadChoices() {
  const [volumeBody, boxBody] = await Promise.all([api("/api/volumes"), api("/api/boxes?stats=false")]);
  return volumeChoices(volumeBody.volumes, new Set(boxBody.boxes.map((box) => box.boxId)));
}

/**
 * The volume list a custom row offers: the roles MiniBox can create, then the volumes that exist. `sharedTools` is the
 * host's shared tools volume, which the tools role mounts instead of making a second one.
 */
function mountChoicesOf(choices) {
  return createMountChoices(choices, sharedToolsChoice(choices) !== null);
}

/**
 * Copies a template to the host the box will be created on. The copy runs as a task, which the drawer shows with its
 * progress, and the create waits for it, so the box starts from the image it names. A copy already running for the same
 * template is joined.
 */
async function syncTemplateTo(ref, hostId) {
  let taskId;
  try {
    ({ taskId } = await api(`/api/templates/${enc(ref)}/sync`, { method: "POST", body: { host: hostId } }));
  } catch (e) {
    if (!e.details?.taskId) throw e;
    taskId = e.details.taskId;
  }
  const task = await waitTask(taskId);
  invalidateTemplates();
  if (task.status === "running") throw new Error(t("cb.syncStillRunning"));
  if (task.status !== "succeeded") throw new Error(taskErrorText(task.error) || t("cb.syncFailed"));
}

/**
 * Builds an official template on the host the box will be created on, when no host holds it yet. The build runs as a
 * task the drawer shows, and the create waits for it. Without a host, the build goes to the local host, as the server's
 * default does.
 */
async function buildOfficialTo(name, hostId) {
  const query = hostId ? `?host=${enc(hostId)}` : "";
  let taskId;
  try {
    ({ taskId } = await api(`/api/templates/official/${enc(name)}/build${query}`, { method: "POST" }));
  } catch (e) {
    if (!e.details?.taskId) throw e;
    taskId = e.details.taskId;
  }
  const task = await waitTask(taskId);
  invalidateTemplates();
  if (task.status === "running") throw new Error(t("cb.buildStillRunning"));
  if (task.status !== "succeeded") throw new Error(taskErrorText(task.error) || t("cb.buildFailed"));
}

/**
 * Create-box dialog. When `snapshot` is given the image is fixed and the box is created from it.
 * `onCreated(box)` runs after success.
 */
export async function openCreateBox({ snapshot, template, onCreated } = {}) {
  if (!hostNow()) await refreshHost();
  const host = hostNow();
  const maxCpu = host?.cpu.cores ?? 16;
  const maxMem = host ? Math.floor(host.memory.total / 1024 / 1024) : 32768;
  let templates = [];
  if (!snapshot) {
    try {
      const [rows, official] = await Promise.all([
        getTemplates(true),
        api("/api/templates/official").then(
          (body) => body.templates,
          () => [],
        ),
      ]);
      templates = withOfficialCards(templateCards(rows), official);
    } catch {
      templates = [];
    }
  }
  const usageById = new Map();
  if (multiHost() && !snapshot) {
    try {
      for (const host of (await api("/api/hosts/usage")).hosts) usageById.set(host.id, host);
    } catch {
      /* without the figures, the capacity note stays hidden for a remote host */
    }
  }
  const system = await api("/api/system").catch(() => null);
  const defaultProfile = PROFILES.includes(system?.config?.boxProfile) ? system.config.boxProfile : "standard";
  const fits = (p) => p.cpus <= maxCpu && p.memoryMb <= maxMem;
  const initial = PRESETS.find((p) => p.id !== "custom" && fits(p)) ?? PRESETS[3];
  const state = {
    cpus: initial.cpus ?? Math.min(2, maxCpu),
    memoryMb: initial.memoryMb ?? 2048,
    preset: initial.id,
    template: templates.find((tp) => tp.ref === template)?.ref ?? templates[0]?.ref ?? "",
    profile: defaultProfile,
    volumesMode: "default",
    egressMode: "open",
  };
  let choices = null;
  let seeded = false;
  /** The shared tools volume the host has, as the volume list holds it. Null when the host has none yet. */
  let toolsShared = null;

  let catalog = [];
  try {
    catalog = (await api("/api/tools/catalog")).tools;
  } catch {
    catalog = [];
  }
  const secrets = snapshot ? [] : await secretNames();
  const picker = !snapshot && catalog.length > 0;
  const folded = loadFolded();
  const toolsSection = picker
    ? foldSectionHtml({
        id: "cbToolsField",
        title: t("cb.tools"),
        open: !folded.has("tools"),
        extraHtml: searchBoxHtml({
          id: "cbToolSearch",
          placeholder: t("tool.searchPlaceholder"),
          label: t("tool.search"),
        }),
        body: `<div class="help">${t("cb.toolsHelp")}</div>
          <div class="tool-groups" id="cbTools"></div>
          <div class="list-more" id="cbToolsMore"></div>`,
      })
    : "";

  const templateSection = snapshot
    ? `<div class="field"><span class="label">${t("cb.sourceSnapshot")}</span><div class="option" aria-checked="true"><span class="avatar">${icon("camera")}</span><span class="meta"><strong>${esc(snapshot)}</strong><span>${t("cb.fromSnapshotHint")}</span></span></div></div>`
    : templates.length
      ? foldSectionHtml({
          id: "cbTemplatesField",
          title: t("cb.template"),
          open: !folded.has("templates"),
          extraHtml: searchBoxHtml({
            id: "cbTemplateSearch",
            placeholder: t("tp.searchPlaceholder"),
            label: t("tp.search"),
          }),
          body: `<div class="option-list" role="radiogroup" aria-label="${esc(t("cb.template"))}" id="cbTemplates"></div>
          <div id="cbTemplatesEmpty" hidden></div>
          <div class="list-more" id="cbTemplatesMore"></div>
          <div class="callout info" id="cbBuildNote" hidden>${icon("info")}<span>${t("cb.buildHint")}</span></div>`,
        })
      : `<div class="field"><span class="label">${t("cb.template")}</span><div class="callout warn">${icon("alert")}<span>${t("cb.noTemplates")}</span></div></div>`;

  const initialHost = hostFilter() || "local";
  const hostField =
    !snapshot && multiHost()
      ? `<div class="field"><label class="label" for="cbHost">${t("cb.host")}</label>
          <select class="select" id="cbHost"><option value="${AUTO_HOST}">${t("cb.hostAuto")}</option>${hostsNow()
            .map(
              (h) => `<option value="${esc(h.id)}"${h.id === initialHost ? " selected" : ""}>${esc(h.name)}</option>`,
            )
            .join("")}</select>
          <div class="help" id="cbHostHelp">${t("cb.hostHelp")}</div>
          <div class="callout info" id="cbSync" hidden>${icon("info")}<span id="cbSyncText"></span></div></div>`
      : "";

  const volumesSection = snapshot
    ? ""
    : foldSectionHtml({
        id: "cbVolumes",
        title: t("cb.volumesSummary", { mode: t("cb.volumesModeDefault") }),
        body: `<div class="field"><span class="label">${t("vol.mounts")}</span>
          <div class="segmented segmented-2" id="cbVolMode">
            <button type="button" class="seg" data-vol-mode="default" aria-pressed="true"><strong>${t("cb.volumesDefault")}</strong><span>${t("cb.volumesDefaultHint")}</span></button>
            <button type="button" class="seg" data-vol-mode="custom" aria-pressed="false"><strong>${t("cb.volumesCustom")}</strong><span>${t("cb.volumesCustomHint")}</span></button>
          </div>
          <div class="help" id="cbVolHelp">${t("cb.volumesDefaultHelp")}</div></div>
        <div class="row-editor" id="cbVolCustom" hidden>
          <div class="callout warn">${icon("alert")}<span>${t("cb.volumesReplace")}</span></div>
          <div class="rebuild-mounts" id="cbMountRows"></div>
          <button type="button" class="btn" id="cbAddMount">${t("mount.add")}</button>
          <div class="help" id="cbMountsNote" hidden></div>
          <div class="help" id="cbMountsOwned" hidden>${t("cb.mountsOwned")}</div>
          <div id="cbSharedNote" hidden></div>
        </div>
        <div class="error-text" id="cbVolErr"></div>`,
      });

  const envSection = snapshot
    ? ""
    : foldSectionHtml({
        id: "cbEnv",
        title: t("env.section"),
        body: `<div class="stack">
          <div class="help">${t("env.createHelp")}</div>
          <div class="row-editor">
            <div class="env-rows" id="cbEnvRows"></div>
            <button type="button" class="btn" id="cbAddEnv">${icon("plus")}${t("env.add")}</button>
          </div>
          <div class="error-text" id="cbEnvErr"></div>
        </div>`,
      });

  const startupSection = `<div class="field" id="cbStartupField">
          <label class="label" for="cbStartup">${t("cb.startup")}</label>
          <textarea class="textarea command-input" id="cbStartup" rows="2" spellcheck="false" placeholder="${esc(t("cb.startupPlaceholder"))}"></textarea>
          <div class="help">${t("cb.startupHelp")}</div>
          <div class="error-text" id="cbStartupErr"></div></div>`;
  const egressField = `<div class="field" id="cbEgressField">
          <span class="label">${t("cb.egress")}</span>
          <div class="segmented segmented-3" id="cbEgressTiers">${EGRESS_TIERS.map(
            (mode) =>
              `<button type="button" class="seg" data-egress="${mode}" aria-pressed="${mode === state.egressMode}"><strong>${t(tierKey(mode))}</strong><span>${t(tierHintKey(mode))}</span></button>`,
          ).join("")}</div>
          <div class="help">${t("cb.egressHelp")}</div>
          <div id="cbEgressProxy" hidden>
            <div class="field"><span class="label">${t("egress.presets")}</span>
              <div class="tool-checks" id="cbEgressPresets">${EGRESS_PRESETS.map(
                (preset) => `<label class="check-row">
                  <input class="sr-only" type="checkbox" value="${preset}" />
                  <span class="check-mark" aria-hidden="true">${icon("check")}</span>
                  <span class="check-body"><span class="check-title"><strong>${t(presetKey(preset))}</strong></span><span class="help">${t(presetHintKey(preset))}</span></span></label>`,
              ).join("")}</div></div>
            <div class="field"><label class="label" for="cbEgressDomains">${t("egress.domains")}</label>
              <textarea class="textarea mono" id="cbEgressDomains" rows="2" spellcheck="false" autocapitalize="off" placeholder="pypi.org, *.example.com"></textarea>
              <div class="help">${t("egress.domainsHelp")}</div></div>
          </div>
          <div class="error-text" id="cbEgressErr"></div></div>`;
  const selfTokenSection = snapshot
    ? ""
    : `<label class="check-row" id="cbSelfTokenRow">
        <input class="sr-only" type="checkbox" id="cbSelfToken" />
        <span class="check-mark" aria-hidden="true">${icon("check")}</span>
        <span class="check-body"><span class="check-title"><strong>${t("cb.selfToken")}</strong></span><span class="help">${t("cb.selfTokenHelp")}</span></span>
      </label>`;
  const repoSection = snapshot
    ? ""
    : foldSectionHtml({
        id: "cbRepo",
        title: t("cb.repoSummary"),
        body: `<div class="stack">
          <div class="help">${t("cb.repoHelp")}</div>
          <div class="field"><label class="label" for="cbRepoUrl">${t("src.url")}</label>
            <input class="input mono" id="cbRepoUrl" placeholder="https://github.com/org/app.git" autocomplete="off" autocapitalize="off" spellcheck="false" />
            <div class="help">${t("src.urlHelp")}</div></div>
          <div class="grid grid-2 form-grid">
            <div class="field"><label class="label" for="cbRepoBranch">${t("src.branch")}</label>
              <input class="input mono" id="cbRepoBranch" placeholder="${esc(t("src.branchPlaceholder"))}" autocomplete="off" autocapitalize="off" spellcheck="false" /></div>
            <div class="field"><label class="label" for="cbRepoSecret">${t("src.secret")}</label>
              <select class="select" id="cbRepoSecret">${secretChoicesHtml(secrets, t("src.secretNone"))}</select>
              <div class="help">${secrets === null ? t("env.secretsUnavailable") : t("src.secretHelp")}</div></div>
          </div>
          <div class="error-text" id="cbRepoErr"></div>
        </div>`,
      });

  const { root, close } = openDialog({
    title: snapshot ? t("cb.titleSnapshot") : t("cb.title"),
    description: t("cb.desc"),
    iconName: "box",
    wide: true,
    body: `
      <div class="field"><label class="label" for="cbName">${t("cb.name")}</label>
        <input class="input" id="cbName" placeholder="${t("cb.namePlaceholder")}" autocomplete="off" autofocus />
        <div class="help">${t("cb.nameHelp")}</div>
        <div class="error-text" id="cbNameErr"></div></div>
      ${hostField}
      <div class="field"><span class="label">${t("cb.size")} <span class="subtle">${t("cb.hostCap", { cores: maxCpu, mem: gbOrMb(maxMem * 1024 * 1024) })}</span></span>
        <div class="segmented" id="cbPresets">${PRESETS.map(
          (
            p,
          ) => `<button type="button" class="seg" data-preset="${p.id}" aria-pressed="${p.id === state.preset}" ${p.id !== "custom" && !fits(p) ? `disabled title="${t("cb.overHost")}"` : ""}>
            <strong>${t(p.label)}</strong><span>${p.id === "custom" ? t("cb.customHint") : t("cb.presetSpec", { cpus: p.cpus, gb: p.memoryMb / 1024 })}</span></button>`,
        ).join("")}</div></div>
      <div class="field"><span class="label">CPU <span class="subtle">${t("unit.coresShort")}</span></span>
        <div class="slider-row"><input type="range" id="cbCpuR" min="0.5" max="${maxCpu}" step="0.5" /><input class="input" id="cbCpu" type="number" min="0.1" max="${maxCpu}" step="0.1" /></div></div>
      <div class="field"><span class="label">${t("cb.memory")} <span class="subtle">MB</span></span>
        <div class="slider-row"><input type="range" id="cbMemR" min="256" max="${maxMem}" step="256" /><input class="input" id="cbMem" type="number" min="128" max="${maxMem}" step="128" /></div>
        <div class="error-text" id="cbResErr"></div></div>
      <div id="cbCapacity"></div>
      ${templateSection}
      ${selfTokenSection}
      ${foldSectionHtml({
        id: "cbAdvanced",
        title: t("cb.advancedSummary", { profile: t(`profile.${state.profile}`) }),
        body: `<div class="field"><span class="label">${t("cb.profile")}</span>
          <div class="segmented segmented-3" id="cbProfiles">${PROFILES.map(
            (p) =>
              `<button type="button" class="seg" data-profile="${p}" aria-pressed="${p === state.profile}"><strong>${t(`profile.${p}`)}</strong><span>${t(`profile.${p}Hint`)}</span></button>`,
          ).join("")}</div>
          <div class="help">${t("cb.profileHelp")}</div></div>
        ${egressField}
        ${startupSection}`,
      })}${repoSection}${toolsSection}${volumesSection}${envSection}`,
    footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="cbSubmit">${icon("play")}${t("cb.submit")}</button>`,
  });

  const q = (s) => root.querySelector(s);
  const sync = () => {
    q("#cbCpuR").value = state.cpus;
    q("#cbCpu").value = state.cpus;
    q("#cbMemR").value = state.memoryMb;
    q("#cbMem").value = state.memoryMb;
    $$("#cbPresets .seg", root).forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.preset === state.preset)),
    );
    validateRes();
  };
  /** The capacity of the host a box would go to and what its running boxes already book there. Null when unknown. */
  const figuresOf = (id) => {
    if (!multiHost() || id === "local") {
      const h = hostNow();
      return h
        ? { cores: h.cpu.cores, total: h.memory.total, cpus: h.boxes.allocatedCpus, memory: h.boxes.allocatedMemory }
        : null;
    }
    const capacity = hostsNow().find((h) => h.id === id)?.capacity;
    const allocated = usageById.get(id)?.allocated;
    if (!capacity?.cpus || !capacity.memoryBytes || !allocated) return null;
    return { cores: capacity.cpus, total: capacity.memoryBytes, cpus: allocated.cpus, memory: allocated.memoryBytes };
  };
  const validateRes = () => {
    let err = "";
    if (!(state.cpus >= 0.1 && state.cpus <= maxCpu)) err = t("cb.cpuRange", { max: maxCpu });
    else if (!(Number.isInteger(state.memoryMb) && state.memoryMb >= 128 && state.memoryMb <= maxMem))
      err = t("cb.memRange", { max: maxMem });
    q("#cbResErr").textContent = err;
    const pick = q("#cbHost")?.value ?? initialHost;
    if (pick === AUTO_HOST) q("#cbCapacity").innerHTML = "";
    else {
      const figures = figuresOf(pick);
      if (figures && !err) {
        const cpuAfter = figures.cpus + state.cpus;
        const memAfter = figures.memory + state.memoryMb * 1024 * 1024;
        const over = cpuAfter > figures.cores || memAfter > figures.total;
        q("#cbCapacity").innerHTML =
          `<div class="callout ${over ? "warn" : "info"}">${icon(over ? "alert" : "info")}<span>
        ${t("cb.capacity", { cpu: +cpuAfter.toFixed(2), cores: figures.cores, mem: gbOrMb(memAfter), total: bytes(figures.total) })}
        ${over ? t("cb.capacityOver") : ""}</span></div>`;
      }
    }
    return !err;
  };
  const setCustom = () => {
    state.preset = "custom";
  };
  /**
   * The template and host of a copy the create must make first: the picked host lacks the template. Automatic placement
   * picks only hosts that hold it, and an agent host takes no copy, so neither needs one.
   */
  const pendingCopy = () => {
    const pick = q("#cbHost")?.value;
    if (!pick || pick === AUTO_HOST || agentHost(pick)) return undefined;
    const card = templates.find((tp) => tp.ref === state.template);
    return needsSync(card, pick) ? { card, host: pick } : undefined;
  };
  /**
   * The unbuilt official template the create builds first, and the host it builds on: undefined means the local host, as
   * a single-host console has no host to pick. Automatic placement builds it inside the create, on the host it picks, and
   * an agent host builds nothing.
   */
  const pendingBuild = () => {
    const card = templates.find((tp) => tp.ref === state.template);
    if (!isUnbuilt(card)) return undefined;
    const pick = q("#cbHost")?.value;
    if (pick === AUTO_HOST || agentHost(pick)) return undefined;
    return { card, host: pick };
  };
  const syncNote = () => {
    const note = q("#cbSync");
    const copy = pendingCopy();
    if (note) {
      note.hidden = !copy;
      if (copy) q("#cbSyncText").textContent = t("cb.syncHint", { mb: syncSizeMb(copy.card) });
    }
    const buildNote = q("#cbBuildNote");
    if (buildNote) buildNote.hidden = !isUnbuilt(templates.find((tp) => tp.ref === state.template));
  };

  q("#cbPresets").addEventListener("click", (e) => {
    const b = e.target.closest(".seg");
    if (!b || b.disabled) return;
    const p = PRESETS.find((x) => x.id === b.dataset.preset);
    state.preset = p.id;
    if (p.cpus) {
      state.cpus = p.cpus;
      state.memoryMb = p.memoryMb;
    }
    sync();
  });
  const bind = (sel, evt, key) =>
    q(sel).addEventListener(evt, (e) => {
      setCustom();
      state[key] = Number(e.target.value);
      sync();
    });
  bind("#cbCpuR", "input", "cpus");
  bind("#cbMemR", "input", "memoryMb");
  bind("#cbCpu", "change", "cpus");
  bind("#cbMem", "change", "memoryMb");
  q("#cbHost")?.addEventListener("change", () => {
    q("#cbHostHelp").textContent = t(q("#cbHost").value === AUTO_HOST ? "cb.hostAutoHelp" : "cb.hostHelp");
    validateRes();
    syncNote();
  });
  q("#cbProfiles").addEventListener("click", (e) => {
    const b = e.target.closest(".seg");
    if (!b) return;
    state.profile = b.dataset.profile;
    $$("#cbProfiles .seg", root).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    q("#cbAdvancedTitle").textContent = t("cb.advancedSummary", { profile: t(`profile.${state.profile}`) });
  });
  q("#cbEgressTiers").addEventListener("click", (e) => {
    const b = e.target.closest(".seg");
    if (!b) return;
    state.egressMode = b.dataset.egress;
    $$("#cbEgressTiers .seg", root).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    q("#cbEgressProxy").hidden = state.egressMode !== "proxy-only";
    q("#cbEgressErr").textContent = "";
  });
  q("#cbEgressDomains").addEventListener("input", () => {
    q("#cbEgressErr").textContent = "";
  });
  q("#cbName").addEventListener("input", () => {
    q("#cbName").classList.remove("invalid");
    q("#cbNameErr").textContent = "";
  });

  const showVolumeError = (message) => {
    if (snapshot) {
      q("#cbResErr").textContent = message;
      return;
    }
    setFoldOpen(root, "cbVolumes", true);
    q("#cbVolErr").textContent = message;
  };

  const showEnvError = (message) => {
    setFoldOpen(root, "cbEnv", true);
    q("#cbEnvErr").textContent = message;
  };

  const showStartupError = (message) => {
    setFoldOpen(root, "cbAdvanced", true);
    q("#cbStartupErr").textContent = message;
  };

  const showEgressError = (message) => {
    setFoldOpen(root, "cbAdvanced", true);
    q("#cbEgressErr").textContent = message;
  };

  q("#cbStartup").addEventListener("input", () => {
    q("#cbStartupErr").textContent = "";
  });

  const showRepoError = (message) => {
    setFoldOpen(root, "cbRepo", true);
    q("#cbRepoErr").textContent = message;
  };

  /** The row list's note: what MiniBox creates for the roles it names, and the volumes it mounts as they are. */
  const refreshMounts = () => {
    if (!choices) return;
    const rows = readMountRows(q("#cbMountRows"));
    const note = q("#cbMountsNote");
    const roles = rows.map((row) => roleOfValue(row.volume)).filter(Boolean);
    const lines = [];
    if (rows.length === 0) lines.push(t("cb.mountsNone"));
    else if (rows.length >= MOUNT_MAX) lines.push(t("cb.mountsLimit", { max: MOUNT_MAX }));
    if (roles.length) lines.push(t("cb.mountsCreated", { roles: roles.map(roleLabel).join(", ") }));
    const names = rows
      .filter((row) => !roleOfValue(row.volume) && row.volume)
      .map((row) => choices.find((choice) => choice.id === row.volume)?.name)
      .filter(Boolean);
    if (names.length) lines.push(t("cb.mountsExisting", { names: names.join(", ") }));
    note.textContent = lines.join(" ");
    note.hidden = lines.length === 0;
    q("#cbAddMount").disabled = rows.length >= MOUNT_MAX;
    const shared = rows
      .filter((row) => row.mode === "rw" && !roleOfValue(row.volume))
      .map((row) => choices.find((choice) => choice.id === row.volume))
      .filter((choice) => choice && choice.rwMounts > 0)
      .map((choice) => `<div>${esc(t("vol.sharedRwMessage", { name: choice.name }))}</div>`);
    q("#cbSharedNote").hidden = shared.length === 0;
    q("#cbSharedNote").innerHTML = shared.length
      ? `<div class="callout warn">${icon("alert")}<div>${shared.join("")}</div></div>`
      : "";
  };

  const chooseVolumesMode = async (mode) => {
    const custom = mode === "custom";
    q("#cbVolErr").textContent = "";
    if (custom && choices === null) {
      const seg = q('#cbVolMode [data-vol-mode="custom"]');
      seg.disabled = true;
      try {
        choices = await loadChoices();
        toolsShared = sharedToolsChoice(choices);
      } catch (e) {
        q("#cbVolErr").textContent = e.message;
        return;
      } finally {
        seg.disabled = false;
      }
    }
    if (custom && !seeded) {
      seeded = true;
      // The four rows the default mode creates, so a custom list starts as the defaults and a removed row is one role less.
      for (const m of DEFAULT_MOUNTS) {
        q("#cbMountRows").append(
          mountRow(
            { volume: roleValue(m.role), path: m.path, mode: m.mode },
            { volumes: choices, create: true, choices: mountChoicesOf(choices) },
          ),
        );
      }
    }
    state.volumesMode = mode;
    $$("#cbVolMode .seg", root).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.volMode === mode)));
    q("#cbVolCustom").hidden = !custom;
    q("#cbVolHelp").textContent = t(
      custom ? "cb.volumesCustomHelp" : toolsShared ? "cb.volumesDefaultHelp" : "cb.volumesDefaultHelpNoTools",
    );
    q("#cbVolumesTitle").textContent = t("cb.volumesSummary", {
      mode: t(custom ? "cb.volumesModeCustom" : "cb.volumesModeDefault"),
    });
    q("#cbMountsOwned").hidden = !custom || !choices?.some((choice) => choice.disabled);
    refreshMounts();
  };

  if (!snapshot) {
    q("#cbVolMode").addEventListener("click", (e) => {
      const b = e.target.closest(".seg");
      if (b && b.dataset.volMode !== state.volumesMode) chooseVolumesMode(b.dataset.volMode);
    });
    q("#cbAddMount").addEventListener("click", () => {
      q("#cbMountRows").append(
        mountRow(
          { volume: "", path: "/data", mode: "rw" },
          { volumes: choices, create: true, choices: mountChoicesOf(choices) },
        ),
      );
      refreshMounts();
    });
    q("#cbMountRows").addEventListener("change", refreshMounts);
    q("#cbMountRows").addEventListener("click", refreshMounts);
  }
  /** Tools and Template remember being folded in this browser. The other sections open folded every time. */
  const savedFolds = { cbToolsField: "tools", cbTemplatesField: "templates" };
  bindFoldSections(root, (id, open) => {
    if (savedFolds[id]) saveFolded(savedFolds[id], !open);
  });
  const selectedTools = new Set();
  if (picker) {
    const paintToolsSummary = () => {
      const names = catalog.filter((tool) => selectedTools.has(tool.id)).map((tool) => tool.name);
      const { count, names: list } = chosenSummary(names);
      q("#cbToolsFieldSummary").textContent = count
        ? t("cb.toolsChosen", { n: count, names: list })
        : t("cb.toolsNone");
    };
    paintToolsSummary();
    let toolQuery = "";
    const drawTools = () => {
      const drawn = pickerView(catalog, {
        query: toolQuery,
        categoryLabel,
        selected: selectedTools,
        expanded: isToggled(root, "tools"),
        isFolded: (id) => isToggled(root, id),
      });
      q("#cbTools").innerHTML = drawn.groups.length
        ? drawn.groups.map((group) => toolGroupHtml(group, selectedTools)).join("")
        : emptyState({
            iconName: "search",
            title: t("tool.noMatch"),
            text: t("tool.noMatchText", { q: esc(toolQuery) }),
            action: `<button class="btn btn-sm" data-action="clear-search">${t("common.clearSearch")}</button>`,
          });
      q("#cbToolsMore").innerHTML = drawn.toggle
        ? listToggleHtml("tools", { expanded: isToggled(root, "tools"), total: drawn.count })
        : "";
      bindToggles(root, q("#cbToolsField"), drawTools);
    };
    const search = bindSearchBox(q("#cbToolSearch"), (text) => {
      toolQuery = text;
      drawTools();
    });
    q("#cbTools").addEventListener("change", (event) => {
      const input = event.target.closest("input[type=checkbox]");
      if (!input) return;
      if (input.checked) selectedTools.add(input.value);
      else selectedTools.delete(input.value);
      paintToolsSummary();
    });
    q("#cbTools").addEventListener("click", (event) => {
      if (event.target.closest('[data-action="clear-search"]')) search.clear();
    });
    drawTools();
  }
  if (!snapshot && templates.length) {
    let templateQuery = "";
    const paintTemplateSummary = () => {
      const chosen = templates.find((tp) => tp.ref === state.template);
      q("#cbTemplatesFieldSummary").textContent = chosen ? t("cb.templateChosen", { name: chosen.name }) : "";
    };
    paintTemplateSummary();
    const chooseTemplate = (option) => {
      state.template = option.dataset.ref;
      $$(".option", root).forEach((x) => x.setAttribute("aria-checked", String(x === option)));
      paintTemplateSummary();
      syncNote();
    };
    const drawTemplates = () => {
      const matches = filterBySearch(templates, templateQuery, (tp) => templateSearchFields(tp, ""));
      const { shown, toggle } = limitList(root, "templates", matches, {
        keep: (tp) => tp.ref === state.template,
        searching: searchTerms(templateQuery).length > 0,
      });
      q("#cbTemplates").innerHTML = shown.map((tp) => templateOptionHtml(tp, state.template)).join("");
      q("#cbTemplatesEmpty").hidden = matches.length > 0;
      q("#cbTemplatesEmpty").innerHTML =
        matches.length === 0
          ? emptyState({
              iconName: "search",
              title: t("tp.noMatch"),
              text: t("tp.noMatchText", { q: esc(templateQuery) }),
              action: `<button class="btn btn-sm" data-action="clear-search">${t("common.clearSearch")}</button>`,
            })
          : "";
      q("#cbTemplatesMore").innerHTML = toggle;
      bindToggles(root, q("#cbTemplatesField"), drawTemplates);
    };
    const search = bindSearchBox(q("#cbTemplateSearch"), (text) => {
      templateQuery = text;
      drawTemplates();
    });
    q("#cbTemplates").addEventListener("click", (event) => {
      const option = event.target.closest(".option");
      if (option) chooseTemplate(option);
    });
    q("#cbTemplates").addEventListener("keydown", (event) => {
      const option = event.target.closest(".option");
      if (!option || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      chooseTemplate(option);
    });
    q("#cbTemplatesField").addEventListener("click", (event) => {
      if (event.target.closest('[data-action="clear-search"]')) search.clear();
    });
    drawTemplates();
  }
  sync();
  syncNote();
  if (!snapshot) {
    const rows = q("#cbEnvRows");
    const refreshEnv = () => {
      q("#cbEnvErr").textContent = "";
      const n = rows.children.length;
      q("#cbEnvTitle").textContent = n ? t("env.sectionCount", { n }) : t("env.section");
    };
    bindEnvRows(rows, refreshEnv);
    q("#cbAddEnv").addEventListener("click", () => {
      rows.append(envRow({ name: "", kind: "value", value: "", secretRef: "" }, secrets));
      refreshEnv();
      rows.lastElementChild.querySelector("[data-env-name]").focus();
    });
    const clearRepoError = () => {
      q("#cbRepoErr").textContent = "";
    };
    q("#cbRepo").addEventListener("input", clearRepoError);
    q("#cbRepo").addEventListener("change", clearRepoError);
  }

  const submit = async () => {
    const name = q("#cbName").value.trim();
    const nErr = nameError(name, "boxName");
    if (nErr) {
      q("#cbName").classList.add("invalid");
      q("#cbNameErr").textContent = nErr;
      q("#cbName").focus();
      return;
    }
    if (!validateRes()) return;
    if (!snapshot && !state.template) return;
    if (!snapshot) q("#cbVolErr").textContent = "";
    let mounts;
    if (!snapshot && state.volumesMode === "custom") {
      const checked = checkMountRows(readMountRows(q("#cbMountRows")));
      if ("problem" in checked) {
        showVolumeError(problemText(checked.problem));
        return;
      }
      mounts = checked.mounts;
    }
    let env;
    if (!snapshot) {
      const checked = checkEnvRows(readEnvRows(q("#cbEnvRows")));
      if ("problem" in checked) {
        showEnvError(envProblemText(checked.problem));
        return;
      }
      env = checked.env;
    }
    const startupCommand = q("#cbStartup").value.trim() === "" ? undefined : q("#cbStartup").value;
    if (startupCommand !== undefined) {
      const problem = startupProblem(startupCommand);
      if (problem) {
        showStartupError(t(startupProblemKey(problem), { max: STARTUP_COMMAND_MAX_BYTES }));
        return;
      }
    }
    let repo = null;
    if (!snapshot) {
      const checked = cloneRepo({
        url: q("#cbRepoUrl").value,
        branch: q("#cbRepoBranch").value,
        secretRef: q("#cbRepoSecret").value,
      });
      if ("problem" in checked) {
        showRepoError(t(checked.key));
        return;
      }
      repo = checked.repo;
    }
    const btn = q("#cbSubmit");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${t("cb.creating")}`;
    try {
      const body = { name, cpus: state.cpus, memoryMb: state.memoryMb, profile: state.profile };
      const hostPick = q("#cbHost");
      if (hostPick) body.host = hostPick.value;
      if (mounts) body.mounts = mounts;
      if (env?.length) body.env = env;
      if (startupCommand !== undefined) body.startupCommand = startupCommand;
      const egress = egressRequestOf({
        mode: state.egressMode,
        presets: $$("#cbEgressPresets input:checked", root).map((input) => input.value),
        domains: q("#cbEgressDomains").value,
      });
      if (egress) body.egress = egress;
      if (repo) body.repo = repo;
      if (q("#cbSelfToken")?.checked) body.selfToken = true;
      const selectedToolIds = [...selectedTools];
      if (selectedToolIds.length) body.tools = selectedToolIds;
      const copy = pendingCopy();
      if (copy) {
        btn.innerHTML = `<span class="spinner"></span>${t("cb.syncing")}`;
        await syncTemplateTo(copy.card.ref, copy.host);
        btn.innerHTML = `<span class="spinner"></span>${t("cb.creating")}`;
      }
      const build = pendingBuild();
      if (build) {
        btn.innerHTML = `<span class="spinner"></span>${t("cb.building")}`;
        await buildOfficialTo(build.card.name, build.host);
        btn.innerHTML = `<span class="spinner"></span>${t("cb.creating")}`;
      }
      const res = snapshot
        ? await api(`/api/snapshots/${enc(snapshot)}/boxes`, { method: "POST", body })
        : await api("/api/boxes", { method: "POST", body: { ...body, template: state.template } });
      close();
      toast(t("cb.created"), { message: t("cb.createdText", { name: res.box.name }) });
      refreshHost();
      if (selectedToolIds.length) {
        try {
          const task = await api(`/api/boxes/${enc(res.box.id)}/tools/reconcile`, { method: "POST" });
          if (task?.taskId) openTasks(task.taskId);
          toast(t("cb.toolsInstalling"), { message: t("cb.toolsInstallingText") });
        } catch (installErr) {
          toast(t("cb.toolsInstallLater"), { message: installErr.message });
        }
      }
      if (res.setup?.taskId) {
        openTasks(res.setup.taskId);
        toast(repo ? t("cb.cloning") : t("cb.settingUp"), {
          message: repo ? t("cb.cloningText") : t("cb.settingUpText"),
        });
      }
      onCreated?.(res.box);
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = `${icon("play")}${t("cb.submit")}`;
      if (isVolumeErrorKey(e.key)) {
        showVolumeError(e.message);
      } else if (!snapshot && (e.details?.field === "env" || isEnvErrorKey(e.key))) {
        showEnvError(`${e.message}${e.hint ? ` ${e.hint}` : ""}`);
      } else if (e.details?.field === "egress" || e.key?.startsWith("egress_")) {
        showEgressError(`${e.message}${e.hint ? ` ${e.hint}` : ""}`);
      } else if (e.details?.field === "startupCommand" || e.key === "startup_command_forbidden") {
        showStartupError(e.message);
      } else if (!snapshot && e.details?.field === "repo") {
        showRepoError(`${e.message}${e.hint ? ` ${e.hint}` : ""}`);
      } else if (e.details?.field === "name") {
        q("#cbName").classList.add("invalid");
        q("#cbNameErr").textContent = e.message;
      } else if (e.code === "conflict") {
        q("#cbName").classList.add("invalid");
        q("#cbNameErr").textContent = e.message;
      } else {
        q("#cbResErr").textContent = e.message;
      }
    }
  };
  q("#cbSubmit").addEventListener("click", submit);
  q("#cbName").addEventListener("keydown", (e) => e.key === "Enter" && submit());
}
