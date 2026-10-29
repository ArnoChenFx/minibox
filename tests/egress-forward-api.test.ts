import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostForwardCheck } from "../src/runtime";
import { silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { call, mint, startHarness, type Harness } from "./support/tokens";

const DROPPED: HostForwardCheck = { forwarding: false, detail: "iptables FORWARD policy is DROP" };
const FORWARDING: HostForwardCheck = { forwarding: true, detail: "iptables accepts the uplink" };

interface StateJson {
  bridge: string;
  forwarding: boolean;
  detail: string;
  boxes: string[];
  at: string;
  repaired: boolean;
  skipped: string | null;
}

let harness: Harness;
let app: App;
let runtime: FakeRuntime;
let base: string;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  harness = startHarness();
  ({ app, runtime, base } = harness);
});

afterEach(() => harness.stop());

const proxyOnlyBox = (name: string) =>
  call(base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256, egress: { mode: "proxy-only" } } });

/** A host with a proxy-only box whose forwarding is blocked, which is the state the overview's button acts on. */
async function blocked() {
  const created = await proxyOnlyBox("agent");
  expect(created.status).toBe(201);
  runtime.forwardVerdict = DROPPED;
  await app.egressForward.tick();
}

const repair = (id = "local", token?: string) =>
  call(base, `/api/hosts/${id}/forward`, { method: "POST", body: {}, token });

const attention = async () =>
  ((await call(base, "/api/overview")).json as unknown as { attention: { kind: string }[] }).attention;

describe("the owner's repair over HTTP", () => {
  test("a blocked host is listed, and the repair adds the rule for the bridge the check read", async () => {
    await blocked();
    expect((await attention()).map((item) => item.kind)).toEqual(["host.forward_blocked"]);

    // The rule takes effect, which the repair's own re-read sees.
    runtime.forwardVerdict = FORWARDING;
    const reply = await repair();
    expect(reply.status).toBe(200);
    const state = (reply.json as unknown as { host: StateJson }).host;
    expect(state).toMatchObject({ forwarding: true, repaired: true, boxes: ["agent"] });
    expect(runtime.callsTo("allowHostForward")[0]?.args).toEqual(["mbtest", state.bridge]);
    // The reading the repair answered with is the one the overview now lists, so the item is gone.
    expect(await attention()).toEqual([]);
  });

  test("a repair that did not work answers forwarding false, so the item stays", async () => {
    await blocked();
    const reply = await repair();
    expect((reply.json as unknown as { host: StateJson }).host.forwarding).toBe(false);
    expect((await attention()).map((item) => item.kind)).toEqual(["host.forward_blocked"]);
  });

  test("nothing is written before the call: a pass alone never touches the host's firewall", async () => {
    await blocked();
    expect(runtime.callsTo("allowHostForward")).toEqual([]);
  });

  test("a token cannot reach the repair, whatever it holds", async () => {
    await blocked();
    const admin = mint(app, { name: "admin", preset: "admin" });
    const reply = await repair("local", admin.secret);
    expect(reply.status).toBe(403);
    expect(runtime.callsTo("allowHostForward")).toEqual([]);
  });

  test("a host with no proxy-only box is refused, and the firewall is left alone", async () => {
    const reply = await repair();
    expect(reply.status).toBe(409);
    expect((reply.json as unknown as { error: { key: string } }).error.key).toBe("egress_forward_no_boxes");
    expect(runtime.callsTo("allowHostForward")).toEqual([]);
  });

  test("a host id no host carries is a 404", async () => {
    const reply = await repair("nowhere");
    expect(reply.status).toBe(404);
  });

  test("an agent host is refused with the reason the check gave, since it cannot run the check", async () => {
    app.hosts.get().host.transport = "agent";
    await proxyOnlyBox("agent");
    await app.egressForward.tick();
    const reply = await repair();
    expect(reply.status).toBe(409);
    expect((reply.json as unknown as { error: { key: string } }).error.key).toBe("egress_forward_unsupported");
  });

  test("a host whose rules were never read is refused, since the bridge to allow is not known", async () => {
    await proxyOnlyBox("agent");
    const reply = await repair();
    expect(reply.status).toBe(409);
    expect((reply.json as unknown as { error: { key: string } }).error.key).toBe("egress_forward_unchecked");
    expect(runtime.callsTo("allowHostForward")).toEqual([]);
  });

  test("the repair is recorded as an activity entry naming the host and the bridge", async () => {
    await blocked();
    const reply = await repair();
    const state = (reply.json as unknown as { host: StateJson }).host;
    const entry = app.activity.list().find((item) => item.action === "host.forward.repair");
    expect(entry).toMatchObject({ target: "local", ok: true });
    expect(JSON.stringify(app.events.list({ op: "host.forward.repair" }, { limit: 10 }).events)).toContain(
      state.bridge,
    );
  });

  test("a repair that leaves the rules right is quiet on the next pass, which finds nothing to report", async () => {
    await blocked();
    await repair();
    runtime.forwardVerdict = FORWARDING;
    app.egressForward.hostOnline("local");
    await app.egressForward.tick();
    expect(await attention()).toEqual([]);
  });
});
