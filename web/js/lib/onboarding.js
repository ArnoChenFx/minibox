/**
 * The console's first-run guide: which of its three steps is open, what each one says it needs, and the MCP snippet the
 * last one hands over. Pure apart from the storage that remembers a dismissal, so a test loads it without a browser.
 *
 * The guide is shown only while the console has no box at all. A dismissal and a finished guide are remembered in this
 * browser, but neither is the judge: a console with a box never shows the guide, whatever this browser saved.
 */

const STORAGE_KEY = "minibox.onboarding.v1";

/** The three steps, in the order the guide lists them: the base template, a first box, then the agent. */
export const ONBOARDING_STEPS = Object.freeze(["template", "box", "agent"]);

/**
 * The clients the agent step writes a snippet for. `other` is the plain MCP configuration that most clients read, so a
 * client this list does not know still has something to paste.
 */
export const CLIENT_IDS = Object.freeze(["claude-code", "codex", "other"]);

/** The token preset each client starts with, when the server's catalog offers it. */
const CLIENT_PRESET = Object.freeze({
  "claude-code": "sandboxed-agent",
  codex: "sandboxed-agent",
  other: "readonly",
});

/** The name MiniBox gives the server in every client's configuration. */
export const SERVER_NAME = "minibox";

/**
 * Whether the guide belongs on the page: the console has no box, and this browser has neither dismissed it nor finished
 * it. `boxes` is the list the overview read, and `state` what this browser saved.
 *
 * `inProgress` is what keeps the last step reachable: a page that opened the guide while there was no box goes on
 * showing it when the first box appears, so the checklist can be finished. A page that opens with a box never draws it,
 * so a console that already has boxes shows no guide at all.
 */
export function onboardingShown({ boxes, state, inProgress = false }) {
  if (!Array.isArray(boxes)) return false;
  if (state?.dismissed || state?.done) return false;
  return boxes.length === 0 || inProgress === true;
}

/**
 * The steps of the guide, each with whether it is done and which one is open. The first step that is not done is the
 * open one, and a later step stays shut until the steps before it are done. `templates` is what GET /api/templates
 * answered, or null before it does, and `agentDone` whether the agent step has created a token this time.
 */
export function onboardingSteps({ templates, boxes, agentDone = false }) {
  const done = {
    template: isBaseBuilt(templates),
    box: Array.isArray(boxes) && boxes.length > 0,
    agent: agentDone === true,
  };
  const open = ONBOARDING_STEPS.find((id) => !done[id]) ?? "";
  return ONBOARDING_STEPS.map((id) => ({
    id,
    done: done[id],
    open: id === open,
    locked: !done[id] && id !== open,
  }));
}

/**
 * What the base template's step shows. `templates` is GET /api/templates, or null before it answers: the guide then says
 * it is still reading rather than judging a step it cannot see.
 */
export function baseTemplateState(templates) {
  if (!templates) return { status: "unknown", ref: "", hosts: [], buildable: false, reason: "reading" };
  const ref = templates.baseTemplate ?? "";
  const rows = Array.isArray(templates.templates) ? templates.templates : [];
  const hosts = rows.filter((row) => row.ref === ref).map((row) => row.hostId);
  if (hosts.length > 0) return { status: "built", ref, hosts, buildable: false, reason: "" };
  return { status: "missing", ref, hosts, buildable: true, reason: "" };
}

/** Whether a host holds the base template, which is what finishes the first step. */
export function isBaseBuilt(templates) {
  return baseTemplateState(templates).status === "built";
}

/**
 * The preset the agent step starts with: the one its client prefers when the catalog offers it, and the catalog's first
 * preset otherwise, so the select always names a preset the server has.
 */
export function defaultPreset(client, catalog) {
  const names = (Array.isArray(catalog?.presets) ? catalog.presets : []).map((item) => item.name);
  const wanted = CLIENT_PRESET[client] ?? CLIENT_PRESET.other;
  return names.includes(wanted) ? wanted : (names[0] ?? wanted);
}

/** The longest token name the server takes, from its own `NAME_RE`. */
export const TOKEN_NAME_MAX = 63;

/**
 * The name of the token the guide creates: one per client, so a second run reads as its own in Settings. `taken` holds
 * the names the console already has, so a guide that runs again after every box was deleted picks `first-codex-2`
 * instead of asking for a name the server refuses.
 */
export function tokenName(client, taken = []) {
  const base = `first-${CLIENT_IDS.includes(client) ? client : "agent"}`;
  const used = new Set([...taken].map((name) => String(name ?? "").toLowerCase()));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, Math.max(1, TOKEN_NAME_MAX - suffix.length))}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * The `POST /api/tokens` body for the agent step: the token's name and its preset. The guide grants no volumes, so the
 * preset alone is the whole scope, and the server adds nothing else to it. `taken` names the tokens the console has, so
 * the name it sends is free.
 */
export function tokenRequest({ client, preset, taken = [] }) {
  return { name: tokenName(client, taken), preset };
}

/**
 * The MCP configuration to paste into `client`, at `origin`, with `secret` as the bearer token. Each client reads its own
 * shape: Claude Code a `.mcp.json` entry with a `type`, Codex a `config.toml` table with a plain header, and any other
 * client the plain JSON that the console's token dialog shows too.
 */
export function mcpSnippet({ client, origin, secret }) {
  const base = String(origin ?? "").replace(/\/+$/, "");
  const url = `${base}/mcp`;
  const authorization = `Bearer ${secret ?? ""}`;
  if (client === "codex") {
    return {
      kind: "toml",
      path: "~/.codex/config.toml",
      text: [
        `[mcp_servers.${SERVER_NAME}]`,
        `url = ${JSON.stringify(url)}`,
        `http_headers = { "Authorization" = ${JSON.stringify(authorization)} }`,
      ].join("\n"),
    };
  }
  const server =
    client === "claude-code"
      ? { type: "http", url, headers: { Authorization: authorization } }
      : { url, headers: { Authorization: authorization } };
  return {
    kind: "json",
    path: client === "claude-code" ? ".mcp.json" : "mcpServers",
    text: JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, null, 2),
  };
}

/** The state this browser saved, or nothing saved when the storage is unavailable or holds something else. */
export function loadOnboardingState() {
  const empty = { dismissed: false, done: false, client: "" };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return empty;
    return {
      dismissed: saved.dismissed === true,
      done: saved.done === true,
      client: typeof saved.client === "string" && CLIENT_IDS.includes(saved.client) ? saved.client : "",
    };
  } catch {
    return empty;
  }
}

/** Saves part of the state, keeping the rest. Storage may be disabled; the guide then works for this page view only. */
export function saveOnboardingState(patch) {
  const next = { ...loadOnboardingState(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be disabled. The choice still holds while the page is open.
  }
  return next;
}

/** The key this browser's state is saved under, so a test and a person can find it. */
export const ONBOARDING_STORAGE_KEY = STORAGE_KEY;
