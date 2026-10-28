/**
 * The first-run guide on the overview: build the base template, create a first box, connect an agent. It draws only while
 * the console has no box, and each step asks for one thing the console already knows how to do.
 *
 * The guide keeps nothing between page views except the dismissal and the client this browser remembers. The open step
 * follows from what the server reports, so a template built in another tab, or a box created in the create dialog, moves
 * the guide along on the next read.
 */

import { api } from "../lib/api.js";
import { copyText, esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { subscribe } from "../lib/live.js";
import {
  baseTemplateState,
  defaultPreset,
  loadOnboardingState,
  mcpSnippet,
  onboardingShown,
  onboardingSteps,
  saveOnboardingState,
  tokenRequest,
} from "../lib/onboarding.js";
import { toast, toastError, withBusy } from "../lib/ui.js";
import { openCreateBox } from "./create-box.js";
import { trackTask } from "./tasks.js";

/** The clients the agent step offers, in the order it lists them. */
const CLIENTS = [
  { id: "claude-code", key: "ob.client.claudeCode" },
  { id: "codex", key: "ob.client.codex" },
  { id: "other", key: "ob.client.other" },
];

const STEP_KEY = { template: "ob.step.template", box: "ob.step.box", agent: "ob.step.agent" };
const STEP_ICON = { template: "hammer", box: "box", agent: "plug" };
const STEP_NUM = { template: 1, box: 2, agent: 3 };

/**
 * Mounts the guide into `host`, the element that holds it. The guide reads the template list and the token presets itself;
 * the box list comes from `boxesOf()`, which the page keeps current, so a created box moves the guide along without
 * another read. Returns `{ redraw, stop }`: the page redraws it when its box list changes, and stops it on a page change.
 */
export function mountOnboarding(host, { boxesOf, onBoxCreated }) {
  const guide = {
    templates: null,
    loaded: false,
    agentDone: false,
    client: loadOnboardingState().client || "claude-code",
    catalog: null,
    /** The secret a token this guide created handed back. It is shown once and kept nowhere else. */
    secret: "",
    /** Whether this page view has drawn the guide, which keeps the last step reachable once a box exists. */
    shown: false,
  };
  /** Set once the page leaves the guide behind, so a read that answers late draws nothing. */
  let stopped = false;

  const draw = () => {
    if (stopped) return;
    const boxes = boxesOf();
    if (!onboardingShown({ boxes, state: loadOnboardingState(), inProgress: guide.shown })) {
      host.innerHTML = "";
      host.hidden = true;
      return;
    }
    guide.shown = true;
    host.hidden = false;
    host.innerHTML = viewHtml(guide, boxes);
    // The agent step lists the presets the server offers, so its select is read the first time it is drawn.
    if (agentOpen(boxes) && !guide.catalog) void loadCatalog().then(draw);
  };

  /** Whether the agent step is the one asking for something, with no secret shown yet. */
  const agentOpen = (boxes) =>
    !guide.secret &&
    onboardingSteps({ templates: guide.templates, boxes, agentDone: guide.agentDone }).some(
      (step) => step.id === "agent" && step.open,
    );

  const loadTemplates = async () => {
    try {
      guide.templates = await api("/api/templates");
    } catch {
      // A list that cannot be read leaves the first step saying so; the other two steps still show.
      guide.templates = null;
    }
    guide.loaded = true;
    draw();
  };

  const loadCatalog = async () => {
    if (guide.catalog) return guide.catalog;
    try {
      guide.catalog = await api("/api/tokens/presets");
    } catch {
      guide.catalog = { presets: [] };
    }
    return guide.catalog;
  };

  /** Finishes the guide for this browser: the snippet was copied, so it has nothing left to ask. */
  const finish = () => {
    saveOnboardingState({ done: true });
    draw();
  };

  const actions = {
    dismiss: () => {
      saveOnboardingState({ dismissed: true });
      draw();
    },
    build: async (btn) => {
      let started;
      try {
        started = await withBusy(btn, () => api("/api/templates/base/build", { method: "POST" }));
      } catch (e) {
        if (e.details?.taskId) {
          toast(t("task.alreadyRunning"), { type: "info" });
          trackTask(e.details.taskId);
          return;
        }
        toastError(t("tp.buildFailed"), e);
        return;
      }
      toast(t("ob.buildStarted"), { type: "info", message: t("tp.buildStartedText") });
      trackTask(started.taskId);
      draw();
    },
    "create-box": () =>
      openCreateBox({
        onCreated: () => {
          // The create dialog closes first; the page then re-reads its box list, and the guide moves on.
          onBoxCreated?.();
          setTimeout(draw, 0);
        },
      }),
    client: async (btn) => {
      guide.client = btn.dataset.client;
      saveOnboardingState({ client: guide.client });
      await loadCatalog();
      draw();
    },
    "create-token": async (btn) => {
      const catalog = await loadCatalog();
      const preset = host.querySelector("#obPreset")?.value || defaultPreset(guide.client, catalog);
      const taken = await tokenNames();
      let created;
      try {
        created = await withBusy(btn, () =>
          api("/api/tokens", { method: "POST", body: tokenRequest({ client: guide.client, preset, taken }) }),
        );
      } catch (e) {
        toastError(t("st.tokenCreateFailed"), e);
        return;
      }
      guide.secret = created.token;
      guide.agentDone = true;
      draw();
    },
    copy: async () => {
      try {
        await copyText(guide.secret);
        toast(t("st.tokenCopied"));
      } catch (e) {
        toastError(t("st.tokenCopy"), e);
        return;
      }
      finish();
    },
    done: () => finish(),
  };

  const onClick = (event) => {
    const target = event.target.closest("[data-action]");
    if (!target || !host.contains(target)) return;
    const fn = actions[target.dataset.action];
    if (!fn) return;
    event.preventDefault();
    event.stopPropagation();
    void fn(target, event);
  };
  host.addEventListener("click", onClick);

  // A template task that ends is the one change outside this view that the first step waits for.
  const off = subscribe("task", (frame) => {
    if (frame.kind !== "status") return;
    if (frame.status === "succeeded" || frame.status === "failed") void loadTemplates();
  });

  void loadTemplates();

  /** Stops the guide: its task subscription, its clicks, and its markup. */
  const stop = () => {
    stopped = true;
    off();
    host.removeEventListener("click", onClick);
    host.innerHTML = "";
    host.hidden = true;
  };

  return { redraw: draw, stop };
}

/** The tokens the console has, so the name the guide asks for is one the server will take. */
async function tokenNames() {
  try {
    const body = await api("/api/tokens");
    return (body.tokens ?? []).map((token) => token.name);
  } catch {
    // Without the list the guide still asks for its own name, and a taken one comes back as the server's refusal.
    return [];
  }
}

/** The guide's markup. Every string is escaped; the step that is open carries its own controls. */
function viewHtml(guide, boxes) {
  const steps = onboardingSteps({ templates: guide.templates, boxes, agentDone: guide.agentDone });
  const body = guide.loaded
    ? steps.map((step) => stepHtml(step, guide)).join("")
    : `<li class="onboarding-step"><div class="skeleton sk-line"></div></li>`;
  return `<section class="card onboarding" id="onboarding" aria-labelledby="obTitle">
    <div class="card-head with-actions">
      <div><h3 id="obTitle">${t("ob.title")}</h3><p class="help">${t("ob.help")}</p></div>
      <div class="actions"><button class="btn btn-sm btn-ghost" type="button" data-action="dismiss">${icon("x")}${t("ob.dismiss")}</button></div>
    </div>
    <ol class="onboarding-steps">${body}</ol>
  </section>`;
}

function stepHtml(step, guide) {
  const mark = step.done
    ? `<span class="onboarding-mark is-done" role="img" aria-label="${esc(t("ob.done"))}">${icon("check")}</span>`
    : `<span class="onboarding-mark" aria-hidden="true">${icon(STEP_ICON[step.id])}</span>`;
  const badge = step.done
    ? `<span class="badge badge-success">${esc(t("ob.done"))}</span>`
    : step.open
      ? `<span class="badge badge-accent">${esc(t("ob.now"))}</span>`
      : "";
  const body = step.locked ? `<p class="help">${esc(t("ob.locked"))}</p>` : bodyHtml(step, guide, step.done);
  return `<li class="onboarding-step${step.done ? " is-done" : ""}${step.open ? " is-open" : ""}${step.locked ? " is-locked" : ""}" data-step="${step.id}">
    <div class="onboarding-head">${mark}<span class="onboarding-num" aria-hidden="true">${STEP_NUM[step.id]}</span>
      <strong class="onboarding-name">${esc(t(STEP_KEY[step.id]))}</strong>${badge}</div>
    <div class="onboarding-body">${body}</div>
  </li>`;
}

function bodyHtml(step, guide, done) {
  if (step.id === "template") return templateBody(guide);
  if (step.id === "box") {
    // A done step keeps the line that says what it was for, and drops the button: there is nothing left to do.
    const action = done
      ? ""
      : `<div class="onboarding-actions"><button class="btn btn-primary" type="button" data-action="create-box">${icon("plus")}${esc(t("ob.boxAction"))}</button></div>`;
    return `<p class="help">${esc(t("ob.boxText"))}</p>${action}`;
  }
  return agentBody(guide);
}

function templateBody(guide) {
  const base = baseTemplateState(guide.templates);
  if (base.status === "unknown") return `<p class="help">${esc(t("ob.templateUnknown"))}</p>`;
  if (base.status === "built") return `<p class="help">${esc(t("ob.templateBuilt", { ref: base.ref }))}</p>`;
  return `<p class="help">${esc(t("ob.templateMissing"))}</p>
    <p class="onboarding-mono mono">${esc(base.ref)}</p>
    <div class="onboarding-actions"><button class="btn btn-primary" type="button" data-action="build">${icon("hammer")}${esc(t("ob.templateAction"))}</button></div>`;
}

function agentBody(guide) {
  if (guide.secret) return secretBody(guide);
  const catalog = guide.catalog ?? { presets: [] };
  const preset = defaultPreset(guide.client, catalog);
  const options = (catalog.presets ?? [])
    .map(
      (item) =>
        `<option value="${esc(item.name)}"${item.name === preset ? " selected" : ""}>${esc(t(`st.preset.${item.name}`))}</option>`,
    )
    .join("");
  return `<p class="help">${esc(t("ob.agentText"))}</p>
    <div class="onboarding-field">
      <span class="onboarding-label" id="obClientLabel">${esc(t("ob.agentClient"))}</span>
      <div class="segmented segmented-3" role="group" aria-labelledby="obClientLabel">
        ${CLIENTS.map(
          (item) =>
            `<button type="button" class="seg onboarding-client" data-action="client" data-client="${item.id}" aria-pressed="${item.id === guide.client}"><strong>${esc(t(item.key))}</strong></button>`,
        ).join("")}
      </div>
    </div>
    <div class="onboarding-field">
      <label class="onboarding-label" for="obPreset">${esc(t("ob.agentPreset"))}</label>
      <select class="select" id="obPreset">${options}</select>
      <span class="help">${esc(t("ob.agentPresetHelp"))}</span>
    </div>
    <div class="onboarding-actions"><button class="btn btn-primary" type="button" data-action="create-token">${icon("key")}${esc(t("ob.agentAction"))}</button></div>
    <p class="help">${esc(t("ob.agentBoxNote"))}</p>`;
}

function secretBody(guide) {
  const snippet = mcpSnippet({ client: guide.client, origin: location.origin, secret: guide.secret });
  const client = CLIENTS.find((item) => item.id === guide.client) ?? CLIENTS[2];
  return `<div class="onboarding-field">
      <div class="onboarding-label">${esc(t("ob.agentSecret"))}</div>
      <div class="token-secret" id="obSecret">${esc(guide.secret)}</div>
      <div class="callout warn">${icon("alert")}<span>${esc(t("ob.agentSecretOnce"))}</span></div>
    </div>
    <div class="onboarding-field">
      <div class="onboarding-label">${esc(t("ob.agentSnippet", { client: t(client.key) }))}</div>
      <pre class="token-snippet" id="obSnippet">${esc(snippet.text)}</pre>
      <span class="help">${esc(t("ob.agentSnippetWhere", { path: snippet.path }))}</span>
    </div>
    <div class="onboarding-actions">
      <button class="btn" type="button" data-action="copy">${icon("copy")}${esc(t("ob.agentCopy"))}</button>
      <button class="btn btn-ghost" type="button" data-action="done">${esc(t("ob.agentDone"))}</button>
    </div>`;
}
