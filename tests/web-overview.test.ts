import { describe, expect, test } from "bun:test";

import { toJsonSchema } from "../src/operations/jsonschema";
import { OPERATIONS } from "../src/operations/registry";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import {
  ATTENTION_LABEL,
  activityByBox,
  type AttentionItem,
  attentionHref,
  attentionText,
  canRepair,
  type OverviewRow,
  pollDelay,
  scopeToHost,
} from "../web/js/lib/overview.js";
import { resolveRoute } from "../web/js/lib/routes.js";

const MB = 1024 ** 2;

/** The params the server sends with each kind, as `overview.get` describes them. */
const SERVER_PARAMS: Record<string, Record<string, string | number>> = {
  "box.oom": {},
  "box.checkpoint_failed": {},
  "box.drift": { fields: "cpus, memory" },
  "box.rollback_pending": { checkpoint: "before the refactor" },
  "volume.over_limit": { used: 5 * MB, limit: 4 * MB, action: "stop" },
  "pool.unreachable": {},
  "host.offline": {},
  "host.disk_low": { free: 5, min: 10 },
  "host.cpu_overcommit": { booked: 3, limit: 2 },
  "host.memory_overcommit": { booked: 6 * MB, limit: 4 * MB },
  "host.forward_blocked": {
    bridge: "br-1a2b3c4d5e6f",
    boxes: "agent",
    count: 1,
    detail: "iptables FORWARD policy is DROP",
    cause: "policy",
  },
};

function itemOf(
  kind: string,
  params: Record<string, string | number> = {},
  fields: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    kind,
    severity: "error",
    hostId: "local",
    at: null,
    subject: "alpha",
    box: { id: "bx_1", name: "alpha" },
    params,
    ...fields,
  };
}

function rowOf(fields: Partial<OverviewRow> = {}): OverviewRow {
  return {
    box: { id: "bx_1", name: "alpha", hostId: "local" },
    principal: { type: "token", id: "tok_1", name: "builder" },
    lastAt: "2026-10-23T08:00:00.000Z",
    lastOp: "exec.start",
    command: null,
    session: null,
    note: null,
    ...fields,
  };
}

const RUNNING = { text: "npm run dev", execId: "exec-1", running: true, output: [] };

/** The kinds the server can send, read from the output schema the operation publishes. */
function serverKinds(): string[] {
  const op = OPERATIONS.find((candidate) => candidate.name === "overview.get");
  if (!op) throw new Error("overview.get is not registered");
  const schema = toJsonSchema(op.output, "output") as {
    properties: { attention: { items: { properties: { kind: { enum: string[] } } } } };
  };
  return schema.properties.attention.items.properties.kind.enum;
}

const CJK = /[\u4e00-\u9fff]/;

describe("attention kinds", () => {
  test("the console words every kind the server can send, and no other", () => {
    expect(Object.keys(ATTENTION_LABEL).toSorted()).toEqual(serverKinds().toSorted());
  });

  test("each kind has a label and a sentence, in both languages, and the Chinese is Chinese", () => {
    for (const kind of serverKinds()) {
      const label = ATTENTION_LABEL[kind] ?? "";
      const text = attentionText(itemOf(kind, SERVER_PARAMS[kind]));
      expect([kind, text !== null && text.key in en && text.key in zh]).toEqual([kind, true]);
      for (const key of [label, text?.key ?? ""]) {
        expect([key, key in en && key in zh && en[key] !== zh[key]]).toEqual([key, true]);
        expect([key, CJK.test(zh[key] ?? "")]).toEqual([key, true]);
      }
    }
  });
});

describe("attentionText", () => {
  test("a volume's byte counts are formatted by the page's formatter", () => {
    const text = attentionText(itemOf("volume.over_limit", { used: 5 * MB, limit: 4 * MB, action: "stop" }), {
      bytes: (count) => `${count / MB} MB`,
    });
    expect(text).toEqual({ key: "ov.text.over_limit_stop", params: { used: "5 MB", limit: "4 MB" } });
  });

  test("a volume with a warn action says it only warns", () => {
    expect(attentionText(itemOf("volume.over_limit", { used: 1, limit: 1, action: "warn" }))?.key).toBe(
      "ov.text.over_limit_warn",
    );
  });

  test("a failure that carries the engine's message names it, and one that does not stays plain", () => {
    expect(attentionText(itemOf("box.checkpoint_failed", { detail: "disk full" }))).toEqual({
      key: "ov.text.checkpoint_failed_detail",
      params: { detail: "disk full" },
    });
    expect(attentionText(itemOf("box.checkpoint_failed"))).toEqual({ key: "ov.text.checkpoint_failed", params: {} });
    expect(attentionText(itemOf("pool.unreachable", { detail: "timeout" }))?.key).toBe(
      "ov.text.pool_unreachable_detail",
    );
    expect(attentionText(itemOf("pool.unreachable", {}))?.key).toBe("ov.text.pool_unreachable");
  });

  test("the fields, the checkpoint, the disk percentages and a host's booked totals reach the sentence", () => {
    expect(attentionText(itemOf("box.drift", { fields: "cpus" }))).toEqual({
      key: "ov.text.drift",
      params: { fields: "cpus" },
    });
    expect(attentionText(itemOf("box.rollback_pending", { checkpoint: "v2" }))).toEqual({
      key: "ov.text.rollback_pending",
      params: { checkpoint: "v2" },
    });
    expect(attentionText(itemOf("host.disk_low", { free: 5, min: 10 }))).toEqual({
      key: "ov.text.disk_low",
      params: { free: 5, min: 10 },
    });
  });

  test("a host's overcommitted CPU reads in cores and its memory in bytes, each by the page's formatter", () => {
    expect(
      attentionText(itemOf("host.cpu_overcommit", { booked: 3, limit: 2 }), { cpus: (n) => `${n} cores` }),
    ).toEqual({ key: "ov.text.cpu_overcommit", params: { booked: "3 cores", limit: "2 cores" } });
    expect(
      attentionText(itemOf("host.memory_overcommit", { booked: 6 * MB, limit: 4 * MB }), {
        bytes: (n) => `${n / MB} MB`,
      }),
    ).toEqual({ key: "ov.text.memory_overcommit", params: { booked: "6 MB", limit: "4 MB" } });
  });

  test("the forwarding warning names the host's boxes and says open boxes are unaffected", () => {
    const text = attentionText(itemOf("host.forward_blocked", SERVER_PARAMS["host.forward_blocked"]));
    expect(text).toEqual({
      key: "ov.text.forward_blocked",
      params: { count: 1, boxes: "agent", bridge: "br-1a2b3c4d5e6f" },
    });
    expect(en["ov.text.forward_blocked"]).toContain("Open boxes are unaffected");
    expect(zh["ov.text.forward_blocked"]).toContain("开放出站的 Box 不受影响");
  });

  test("a drop the host's own rules make, and an unclear one, read differently and promise no fix", () => {
    // Only the policy case is an accident. Saying "confirm to let MiniBox add the rule" for a deliberate DROP would be
    // asking the owner to undo their own decision.
    const params = SERVER_PARAMS["host.forward_blocked"];
    expect(attentionText(itemOf("host.forward_blocked", { ...params, cause: "rule" }))?.key).toBe(
      "ov.text.forward_blocked_rule",
    );
    expect(attentionText(itemOf("host.forward_blocked", { ...params, cause: "unclear" }))?.key).toBe(
      "ov.text.forward_blocked_unclear",
    );
    expect(attentionText(itemOf("host.forward_blocked", { ...params, cause: "unreachable" }))?.key).toBe(
      "ov.text.forward_blocked_unreachable",
    );
    for (const key of [
      "ov.text.forward_blocked_rule",
      "ov.text.forward_blocked_unclear",
      "ov.text.forward_blocked_unreachable",
    ]) {
      expect(en[key]).not.toContain("Confirm to let MiniBox");
      expect(zh[key]).not.toContain("确认后由 MiniBox");
      // i18n.test.ts checks that both languages exist; this checks the words differ from each other.
      expect(en[key]).not.toBe(zh[key]);
    }
  });

  test("a kind the console does not know has no sentence", () => {
    expect(attentionText(itemOf("container.restarted"))).toBeNull();
  });
});

describe("where an attention item leads", () => {
  test("a volume or a pool opens the Volumes tab, and a host opens its settings", () => {
    expect(attentionHref(itemOf("volume.over_limit", {}, { box: null }))).toBe("#/storage/volumes");
    expect(attentionHref(itemOf("pool.unreachable", {}, { box: null }))).toBe("#/storage/volumes");
    expect(attentionHref(itemOf("host.offline", {}, { box: null }))).toBe("#/settings/hosts");
    expect(attentionHref(itemOf("host.disk_low", {}, { box: null }))).toBe("#/settings/hosts");
    expect(attentionHref(itemOf("host.cpu_overcommit", {}, { box: null }))).toBe("#/settings/hosts");
    expect(attentionHref(itemOf("host.memory_overcommit", {}, { box: null }))).toBe("#/settings/hosts");
  });

  test("a box condition opens the box tab that shows it", () => {
    expect(attentionHref(itemOf("box.oom"))).toBe("#/boxes/bx_1/activity");
    expect(attentionHref(itemOf("box.checkpoint_failed"))).toBe("#/boxes/bx_1/settings/checkpoints");
    expect(attentionHref(itemOf("box.rollback_pending"))).toBe("#/boxes/bx_1/settings/checkpoints");
    expect(attentionHref(itemOf("box.drift"))).toBe("#/boxes/bx_1/settings/resources");
  });

  test("a host whose forwarding is blocked opens its settings, and is the one kind with a button of its own", () => {
    expect(attentionHref(itemOf("host.forward_blocked", SERVER_PARAMS["host.forward_blocked"], { box: null }))).toBe(
      "#/settings/hosts",
    );
    for (const kind of serverKinds()) {
      expect([kind, canRepair(itemOf(kind, SERVER_PARAMS[kind]))]).toEqual([kind, kind === "host.forward_blocked"]);
    }
  });

  test("the button is offered only for a drop the policy made, never for one the host's rules asked for", () => {
    const params = SERVER_PARAMS["host.forward_blocked"];
    expect(canRepair(itemOf("host.forward_blocked", { ...params, cause: "policy" }))).toBe(true);
    expect(canRepair(itemOf("host.forward_blocked", { ...params, cause: "rule" }))).toBe(false);
    expect(canRepair(itemOf("host.forward_blocked", { ...params, cause: "unclear" }))).toBe(false);
    expect(canRepair(itemOf("host.forward_blocked", { ...params, cause: "unreachable" }))).toBe(false);
    // A view that carries no cause at all must not offer a button either: without one nothing is certain.
    const { cause: _cause, ...withoutCause } = params as Record<string, string | number>;
    expect(canRepair(itemOf("host.forward_blocked", withoutCause))).toBe(false);
  });

  test("a box condition whose box is gone opens the Boxes list", () => {
    expect(attentionHref(itemOf("box.oom", {}, { box: null }))).toBe("#/boxes");
  });

  test("a box id reaches the address encoded", () => {
    expect(attentionHref(itemOf("box.oom", {}, { box: { id: "bx one", name: "one" } }))).toBe(
      "#/boxes/bx%20one/activity",
    );
  });

  test("every kind's link opens a page directly, without a redirect", () => {
    for (const kind of serverKinds()) {
      const href = attentionHref(itemOf(kind, SERVER_PARAMS[kind]));
      const hit = resolveRoute(href.slice(1));
      expect([kind, hit !== null && "page" in hit]).toEqual([kind, true]);
    }
  });
});

describe("how often the page reads again", () => {
  test("a running command is read every three seconds", () => {
    expect(pollDelay({ inProgress: [rowOf({ command: RUNNING })] })).toBe(3000);
    expect(pollDelay({ inProgress: [rowOf(), rowOf({ command: RUNNING })] })).toBe(3000);
  });

  test("agent activity with no running command is read every ten seconds", () => {
    expect(pollDelay({ inProgress: [rowOf()] })).toBe(10_000);
    expect(pollDelay({ inProgress: [rowOf({ command: { ...RUNNING, running: false } })] })).toBe(10_000);
  });

  test("an idle server is read every fifteen seconds", () => {
    expect(pollDelay({ inProgress: [] })).toBe(15_000);
  });
});

describe("the box list's indicator", () => {
  test("each box has its own row, found by its id", () => {
    const alpha = rowOf();
    const beta = rowOf({ box: { id: "bx_2", name: "beta", hostId: "local" } });
    const byBox = activityByBox([alpha, beta]);
    expect([...byBox.keys()]).toEqual(["bx_1", "bx_2"]);
    expect(byBox.get("bx_2")).toBe(beta);
  });

  test("no activity leaves nothing to mark", () => {
    expect(activityByBox([]).size).toBe(0);
  });
});

const hostOf = (item: { host: string }) => item.host;

describe("the host filter", () => {
  const items = [
    { id: "a", host: "local" },
    { id: "b", host: "lab" },
    { id: "c", host: "local" },
  ];

  test("an empty filter keeps every item", () => {
    expect(scopeToHost(items, "", hostOf)).toEqual(items);
  });

  test("a host keeps only its own items, in their order", () => {
    expect(scopeToHost(items, "local", hostOf).map((item) => item.id)).toEqual(["a", "c"]);
  });

  test("a host with no items keeps none", () => {
    expect(scopeToHost(items, "nowhere", hostOf)).toEqual([]);
  });
});
