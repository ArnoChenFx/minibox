import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import type { OperationContext, Principal } from "../src/operations/types";
import { startServer } from "../src/server";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };
const NONE = { mode: "none", presets: [], domains: [], allow: [] };

let app: App;
let runtime: FakeRuntime;
let host: HostCtx;
let ctx: OperationContext;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  const created = createTestApp({ labelPrefix: "mbtest" });
  app = created.app;
  runtime = created.runtime;
  host = app.hosts.get();
  runtime.seedImage(app.cfg.baseTemplateTag, {
    [host.keys.template]: "true",
    [host.keys.templateName]: "base",
  });
  ctx = {
    host,
    principal: OWNER,
    source: "rest",
    events: app.events,
    tokens: app.tokens,
    execs: app.execs,
  };
});

const create = (name: string, egress?: unknown) =>
  app.operations.run("box.create", ctx, { name, cpus: 1, memoryMb: 256, ...(egress === undefined ? {} : { egress }) });

const egressNetworks = () =>
  [...runtime.networks.keys()].filter((name) => name.startsWith("mbtest-egress-") && name !== "mbtest-egress-uplink");

describe("egress on box create", () => {
  test("a create names its tier; a create without one is open and reports no egress", async () => {
    const walled = (await create("walled", {
      mode: "proxy-only",
      presets: ["agent-default"],
      domains: ["*.example.org", "example.com"],
    })) as { box: { egress?: unknown; network: string } };

    expect(walled.box.egress).toEqual({
      mode: "proxy-only",
      presets: ["agent-default"],
      domains: ["*.example.org", "example.com"],
      allow: [
        "*.example.org",
        "api.anthropic.com",
        "api.openai.com",
        "api2.cursor.sh",
        "auth.openai.com",
        "chatgpt.com",
        "example.com",
        "generativelanguage.googleapis.com",
      ],
    });
    expect(walled.box.network).toMatch(/^mbtest-egress-/);

    const plain = (await create("plain")) as { box: { egress?: unknown } };
    expect(plain.box.egress).toBeUndefined();
  });

  test("a create whose policy is refused names the field, and makes nothing", async () => {
    const cases: [unknown, string][] = [
      ["none", "egress_mode_invalid"],
      [{ mode: "allow-all" }, "egress_mode_invalid"],
      [{ mode: "proxy-only", presets: ["everything"] }, "egress_preset_invalid"],
      [{ mode: "proxy-only", domains: ["10.0.0.1"] }, "egress_domain_invalid"],
      [{ mode: "none", domains: ["example.com"] }, "egress_options_need_proxy"],
      [{ mode: "none", presets: ["agent-default"] }, "egress_options_need_proxy"],
      [
        { mode: "proxy-only", domains: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`) },
        "egress_domains_too_many",
      ],
    ];
    for (const [egress, key] of cases) {
      const error = await rejectionOf(create("refused", egress));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 400, code: "validation_failed", key, details: { field: "egress" } });
    }
    expect(host.specs.findByName("refused")).toBeNull();
    expect(egressNetworks()).toEqual([]);
    expect(runtime.callsTo("createContainer")).toEqual([]);
  });
});

describe("egress on box update and rebuild", () => {
  test("a tier change through update is previewed and not applied, and the box keeps its tier", async () => {
    const { box } = (await create("sealed", { mode: "none" })) as { box: { boxId: string; revision: number } };
    const creates = runtime.callsTo("createContainer").length;

    const error = await rejectionOf(
      app.operations.run("box.update", ctx, {
        id: box.boxId,
        egress: { mode: "proxy-only", domains: ["example.com"] },
        expectedRevision: String(box.revision),
      }),
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, code: "confirmation_required" });
    const preview = (error as AppError).details as { preview: { changes: unknown[] } };
    expect(preview.preview.changes).toContainEqual({
      field: "egress",
      from: "none",
      to: "proxy-only: example.com",
    });
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(host.specs.read(box.boxId)?.egress?.mode).toBe("none");
  });

  test("a confirmed rebuild moves the box to the tier it names, on its private network", async () => {
    const { box } = (await create("sealed", { mode: "none" })) as { box: { boxId: string; revision: number } };
    const subnet = host.specs.read(box.boxId)?.egress?.subnet;
    expect(subnet).toBeDefined();

    const rebuilt = (await app.operations.run("box.rebuild", ctx, {
      id: box.boxId,
      egress: { mode: "proxy-only", domains: ["example.com"] },
      confirm: true,
      safetyCheckpoint: false,
      expectedRevision: String(box.revision),
    })) as { box: { egress?: unknown; network: string } };

    expect(rebuilt.box.egress).toEqual({
      mode: "proxy-only",
      presets: [],
      domains: ["example.com"],
      allow: ["example.com"],
    });
    expect(rebuilt.box.network).toBe(`mbtest-egress-${box.boxId}`);
    expect(host.specs.read(box.boxId)?.egress).toMatchObject({ mode: "proxy-only", subnet });
  });

  test("a rebuild that names egress and a network is refused, and changes nothing", async () => {
    const { box } = (await create("plain")) as { box: { boxId: string; revision: number } };

    const error = await rejectionOf(
      app.operations.run("box.rebuild", ctx, {
        id: box.boxId,
        egress: { mode: "none" },
        network: "bridge",
        confirm: true,
        safetyCheckpoint: false,
        expectedRevision: String(box.revision),
      }),
    );

    expect(error).toMatchObject({ status: 400, key: "egress_needs_network" });
    expect(host.specs.read(box.boxId)?.egress).toBeUndefined();
    expect(egressNetworks()).toEqual([]);
  });
});

describe("egress over REST", () => {
  test("POST takes the policy, and a PATCH to another tier is previewed with a 409", async () => {
    const server = startServer(app);
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" };
    try {
      const created = await fetch(`${base}/api/boxes`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "sealed", cpus: 1, memoryMb: 256, egress: { mode: "none" } }),
      });
      expect(created.status).toBe(201);
      const { box } = (await created.json()) as { box: { egress: unknown } };
      expect(box.egress).toEqual(NONE);

      const patched = await fetch(`${base}/api/boxes/sealed`, {
        method: "PATCH",
        headers: { ...auth, "if-match": "1" },
        body: JSON.stringify({ egress: { mode: "open" } }),
      });
      expect(patched.status).toBe(409);
      const refusal = (await patched.json()) as {
        error: { code: string; details: { preview: { changes: unknown[] } } };
      };
      expect(refusal.error.code).toBe("confirmation_required");
      expect(refusal.error.details.preview.changes).toContainEqual({ field: "egress", from: "none", to: "open" });
    } finally {
      server.stop(true);
      app.throttle.stop();
    }
  });
});
