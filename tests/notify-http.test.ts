import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import type { AppDeps } from "../src/app";
import { silenceLogs, TEST_KEY } from "./support/app";
import { call, type Harness, mint, refused, type Reply, startHarness } from "./support/tokens";

type NotifyDeps = NonNullable<AppDeps["notify"]>;

interface DeliveryJson {
  id: string;
  ts: number;
  status: "ok" | "error";
  channel: string | null;
  type: string | null;
  notice: string | null;
  title: string | null;
  attempts: number | null;
  httpStatus: number | null;
  error: string | null;
}

interface Hit {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: string;
}

interface Receiver {
  readonly url: string;
  readonly hits: Hit[];
  stop(): void;
}

/** A local stand-in for a webhook, an ntfy server or Telegram. `answer` picks the status for each request, or hangs. */
function receiver(answer: (hit: Hit) => number | "hang" = () => 200): Receiver {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const hit: Hit = {
        method: req.method,
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: await req.text(),
      };
      hits.push(hit);
      const status = answer(hit);
      if (status === "hang") return new Promise<Response>(() => {});
      return new Response("", { status });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

const cleanups: (() => void)[] = [];
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
});

afterEach(() => {
  for (const done of cleanups.splice(0).toReversed()) done();
  restoreLogs();
});

/** An app on an ephemeral port. Retries wait nothing, so a test that fails three times stays quick. */
function startApp(options: { allowPrivate?: boolean; notify?: Partial<NotifyDeps> } = {}): Harness {
  const harness = startHarness(
    { notifyAllowPrivate: options.allowPrivate ?? true },
    { notify: { sleep: async () => {}, ...options.notify } },
  );
  cleanups.push(() => {
    harness.app.notify.stop();
    harness.stop();
  });
  return harness;
}

function receiverFor(answer?: (hit: Hit) => number | "hang"): Receiver {
  const hook = receiver(answer);
  cleanups.push(hook.stop);
  return hook;
}

const ROUTES = [
  { method: "GET", path: "/api/notify/channels" },
  {
    method: "PUT",
    path: "/api/notify/channels/ops",
    body: { type: "webhook", name: "Ops", events: ["box.oom"], url: "https://hooks.example.com/minibox" },
  },
  { method: "DELETE", path: "/api/notify/channels/ops" },
  { method: "POST", path: "/api/notify/channels/ops/test" },
  { method: "GET", path: "/api/notify/deliveries" },
] as const;

const put = (base: string, id: string, body: Record<string, unknown>) =>
  call(base, `/api/notify/channels/${id}`, { method: "PUT", body });

const sendTest = (base: string, id: string) => call(base, `/api/notify/channels/${id}/test`, { method: "POST" });

const json = <T>(reply: Reply): T => reply.json as unknown as T;

async function deliveriesOf(base: string): Promise<DeliveryJson[]> {
  return json<{ deliveries: DeliveryJson[] }>(await call(base, "/api/notify/deliveries?limit=50")).deliveries;
}

async function waitFor(ready: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** The signature a receiver computes over the timestamp and the body it got, with the channel's secret. */
function expectedSignature(hit: Hit, secret: string): string {
  const timestamp = hit.headers.get("x-minibox-timestamp") ?? "";
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${hit.body}`).digest("hex")}`;
}

async function createBox(base: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const reply = await call(base, "/api/boxes", { method: "POST", body: { name, cpus: 1, memoryMb: 256, ...extra } });
  return json<{ box: { id: string } }>(reply).box.id;
}

describe("who may manage notification channels", () => {
  test("a request with no credential is refused on every notification route", async () => {
    const { base } = startApp();
    for (const route of ROUTES) {
      const res = await fetch(`${base}${route.path}`, {
        method: route.method,
        headers: "body" in route ? { "content-type": "application/json" } : {},
        body: "body" in route ? JSON.stringify(route.body) : undefined,
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  test("tokens that hold every ordinary scope are refused, because notification channels are the owner's alone", async () => {
    const harness = startApp();
    const subjects = [
      { name: "admin", preset: "admin" },
      { name: "operator", preset: "operator" },
      { name: "readonly", preset: "readonly" },
    ] as const;
    for (const subject of subjects) {
      const minted = mint(harness.app, subject);
      for (const route of ROUTES) {
        const body = "body" in route ? route.body : undefined;
        const reply = await call(harness.base, route.path, { method: route.method, token: minted.secret, body });
        expect(refused(reply), `${subject.name} ${route.method} ${route.path}`).toEqual({
          status: 403,
          key: "operation_forbidden",
        });
      }
    }
  });

  test("the owner's token reaches every route", async () => {
    const harness = startApp();
    expect((await call(harness.base, "/api/notify/channels", { token: TEST_KEY })).status).toBe(200);
    expect((await call(harness.base, "/api/notify/deliveries", { token: TEST_KEY })).status).toBe(200);
  });
});

describe("channel settings and their secrets over HTTP", () => {
  test("a secret is stored by the owner's write, kept or cleared by later writes, and never returned by any answer or event", async () => {
    const harness = startApp();
    const secret = "signing-secret-value-7";
    const settings = { type: "webhook", name: "Ops", events: ["box.oom"], url: "https://hooks.example.com/minibox" };

    const created = await put(harness.base, "ops", { ...settings, secret });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ created: true, valueChange: "set", channel: { id: "ops", hasSecret: true } });

    const kept = await put(harness.base, "ops", settings);
    expect(kept.json).toMatchObject({ created: false, valueChange: "kept", channel: { hasSecret: true } });

    const cleared = await put(harness.base, "ops", { ...settings, secret: null });
    expect(cleared.json).toMatchObject({ valueChange: "cleared", channel: { hasSecret: false } });

    await put(harness.base, "ops", { ...settings, secret });
    const listing = await call(harness.base, "/api/notify/channels");
    const events = await call(harness.base, "/api/events?limit=200");
    for (const reply of [created, kept, cleared, listing, events]) {
      expect(JSON.stringify(reply.json)).not.toContain(secret);
    }
    expect(JSON.stringify(events.json)).toContain("notify.channel.set");
  });

  test("a webhook URL is answered masked, never in full, and a change that omits it keeps the stored one", async () => {
    const harness = startApp();
    const hook = receiverFor();
    const url = `${hook.url}/hook/token-in-path?key=query-token`;
    const created = await put(harness.base, "ops", { type: "webhook", name: "Ops", events: ["box.oom"], url });
    expect(json<{ channel: { url: string } }>(created).channel.url).toBe(`${hook.url}/…`);

    const renamed = await put(harness.base, "ops", { type: "webhook", name: "Renamed", events: ["box.oom"] });
    expect(renamed.status).toBe(200);
    expect(json<{ channel: { name: string; url: string } }>(renamed).channel).toMatchObject({
      name: "Renamed",
      url: `${hook.url}/…`,
    });

    expect((await sendTest(harness.base, "ops")).status).toBe(200);
    await waitFor(() => hook.hits.length === 1, "the test notice");
    expect(hook.hits[0]?.path).toBe("/hook/token-in-path");

    const listing = await call(harness.base, "/api/notify/channels");
    const events = await call(harness.base, "/api/events?limit=200");
    for (const reply of [created, renamed, listing, events]) {
      expect(JSON.stringify(reply.json)).not.toContain("token-in-path");
      expect(JSON.stringify(reply.json)).not.toContain("query-token");
    }

    const fresh = await put(harness.base, "new", { type: "webhook", name: "New", events: ["box.oom"] });
    expect(refused(fresh)).toMatchObject({ status: 400 });
  });

  test("a webhook answers with its stored signature for the owner's test, and the receiver can verify it", async () => {
    const harness = startApp();
    const hook = receiverFor();
    const secret = "signing-secret-value-7";
    await put(harness.base, "ops", {
      type: "webhook",
      name: "Ops",
      events: ["box.oom"],
      url: `${hook.url}/hook`,
      secret,
    });

    const result = await sendTest(harness.base, "ops");
    expect(result.json as unknown).toEqual({ ok: true, status: 200, attempts: 1, error: null });

    expect(hook.hits).toHaveLength(1);
    const [hit] = hook.hits;
    expect(hit?.method).toBe("POST");
    expect(hit?.path).toBe("/hook");
    expect(hit?.headers.get("x-minibox-event")).toBe("notify.test");
    expect(hit?.headers.get("x-minibox-signature")).toBe(expectedSignature(hit as Hit, secret));
    const age = Math.abs(Date.now() / 1000 - Number(hit?.headers.get("x-minibox-timestamp")));
    expect(age).toBeLessThan(60);
    expect(JSON.parse(hit?.body ?? "{}")).toMatchObject({ kind: "notify.test", title: "MiniBox test notification" });

    const deliveries = await deliveriesOf(harness.base);
    expect(deliveries).toEqual([
      expect.objectContaining({
        id: hit?.headers.get("x-minibox-delivery"),
        channel: "ops",
        type: "webhook",
        notice: "notify.test",
        status: "ok",
        attempts: 1,
        httpStatus: 200,
        error: null,
      }),
    ]);
  });

  test("an ntfy channel posts its text to the topic, with the access token as a bearer token", async () => {
    const harness = startApp();
    const ntfy = receiverFor();
    await put(harness.base, "phone", {
      type: "ntfy",
      name: "Phone",
      events: ["box.oom"],
      server: ntfy.url,
      topic: "minibox-alerts",
      secret: "tk_ntfy_access_1",
    });

    expect((await sendTest(harness.base, "phone")).json).toMatchObject({ ok: true, status: 200 });
    const [hit] = ntfy.hits;
    expect(hit?.path).toBe("/minibox-alerts");
    expect(hit?.headers.get("authorization")).toBe("Bearer tk_ntfy_access_1");
    expect(hit?.headers.get("title")).toBe("MiniBox test notification");
    expect(hit?.body).toBe("MiniBox test notification\nChecks that the Phone channel reaches you.");
  });

  test("a Telegram channel calls sendMessage for its chat, with the bot token only in the path", async () => {
    const telegram = receiverFor();
    const harness = startApp({ notify: { telegramBase: telegram.url } });
    const token = "123456:minibox-bot-token";
    await put(harness.base, "team", {
      type: "telegram",
      name: "Team",
      events: ["box.oom"],
      chatId: "-1001234567890",
      secret: token,
    });

    expect((await sendTest(harness.base, "team")).json).toMatchObject({ ok: true, status: 200 });
    const [hit] = telegram.hits;
    expect(hit?.path).toBe(`/bot${token}/sendMessage`);
    expect(JSON.parse(hit?.body ?? "{}")).toEqual({
      chat_id: "-1001234567890",
      text: "MiniBox test notification\nChecks that the Team channel reaches you.",
      disable_web_page_preview: true,
    });
    expect(JSON.stringify(await deliveriesOf(harness.base))).not.toContain(token);
  });

  test("a channel that points at a private address is refused and the refusal is recorded, unless private addresses are allowed", async () => {
    const harness = startApp({ allowPrivate: false });
    const hook = receiverFor();
    await put(harness.base, "ops", { type: "webhook", name: "Ops", events: ["box.oom"], url: `${hook.url}/hook` });

    expect((await sendTest(harness.base, "ops")).json as unknown).toEqual({
      ok: false,
      status: null,
      attempts: 1,
      error: "blocked_address",
    });
    expect(hook.hits).toEqual([]);
    expect(await deliveriesOf(harness.base)).toEqual([
      expect.objectContaining({ status: "error", error: "blocked_address" }),
    ]);
  });
});

describe("delivery of notices caused by operations", () => {
  test("a failed command notifies the channel, and neither its output, its environment nor the signing secret reaches the notice", async () => {
    const harness = startApp();
    const hook = receiverFor();
    const secret = "signing-secret-value-7";
    await put(harness.base, "ops", {
      type: "webhook",
      name: "Ops",
      events: ["exec.failed"],
      url: `${hook.url}/hook`,
      secret,
    });
    harness.runtime.execScript = { stdout: "", stderr: "s3cret-output-value\n", code: 3 };
    const id = await createBox(harness.base, "alpha");

    const run = await call(harness.base, `/api/boxes/${id}/exec`, {
      method: "POST",
      body: { cmd: "make build", env: { DB_PASSWORD: "env-secret-value-99" } },
    });
    expect(run.json).toMatchObject({ exitCode: 3 });

    await waitFor(() => hook.hits.length === 1, "the webhook");
    const [hit] = hook.hits;
    expect(JSON.parse(hit?.body ?? "{}")).toMatchObject({
      kind: "exec.failed",
      title: "Command failed in alpha",
      body: "Exit code 3.",
      box: "alpha",
    });
    expect(hit?.headers.get("x-minibox-signature")).toBe(expectedSignature(hit as Hit, secret));
    const everything = `${hit?.body}\n${JSON.stringify([...(hit?.headers.entries() ?? [])])}`;
    expect(everything).not.toContain("s3cret-output-value");
    expect(everything).not.toContain("env-secret-value-99");
    expect(everything).not.toContain(secret);
    expect(await deliveriesOf(harness.base)).toEqual([
      expect.objectContaining({ notice: "exec.failed", status: "ok", attempts: 1, httpStatus: 200 }),
    ]);
  });

  test("an endpoint that keeps failing is tried three times, and the failure is recorded with its attempts", async () => {
    const harness = startApp();
    const hook = receiverFor(() => 500);
    await put(harness.base, "ops", { type: "webhook", name: "Ops", events: ["exec.failed"], url: `${hook.url}/hook` });
    harness.runtime.execScript = { stdout: "", stderr: "", code: 1 };
    const id = await createBox(harness.base, "alpha");

    await call(harness.base, `/api/boxes/${id}/exec`, { method: "POST", body: { cmd: "false" } });
    await waitFor(() => hook.hits.length === 3, "three attempts");
    await harness.app.notify.idle();

    expect(hook.hits).toHaveLength(3);
    expect(await deliveriesOf(harness.base)).toEqual([
      expect.objectContaining({ status: "error", attempts: 3, httpStatus: 500, error: "http_500" }),
    ]);
  });

  test("a channel that never answers is cut off by its timeout, and does not hold the command that caused the notice", async () => {
    const harness = startApp({ notify: { timeoutMs: 1000, maxAttempts: 1 } });
    const hook = receiverFor(() => "hang");
    await put(harness.base, "ops", { type: "webhook", name: "Ops", events: ["exec.failed"], url: `${hook.url}/hook` });
    harness.runtime.execScript = { stdout: "", stderr: "", code: 1 };
    const id = await createBox(harness.base, "alpha");

    const started = Date.now();
    const run = await call(harness.base, `/api/boxes/${id}/exec`, { method: "POST", body: { cmd: "false" } });
    const elapsed = Date.now() - started;
    expect(run.json).toMatchObject({ exitCode: 1 });
    expect(elapsed).toBeLessThan(900);

    await waitFor(async () => (await deliveriesOf(harness.base)).length === 1, "the failed delivery");
    expect(await deliveriesOf(harness.base)).toEqual([
      expect.objectContaining({ status: "error", attempts: 1, error: "timeout" }),
    ]);
  });

  test("a box whose TTL is about to end notifies the channel that takes that kind", async () => {
    const harness = startApp();
    const hook = receiverFor();
    await put(harness.base, "ttl", { type: "webhook", name: "TTL", events: ["box.ttl_soon"], url: `${hook.url}/hook` });
    await createBox(harness.base, "short-lived", { ttlSec: 240 });

    await harness.app.lifecycle.tick();
    await waitFor(() => hook.hits.length === 1, "the TTL warning");
    const payload = JSON.parse(hook.hits[0]?.body ?? "{}") as {
      kind: string;
      title: string;
      body: string;
      box: string;
    };
    expect(payload).toMatchObject({
      kind: "box.ttl_soon",
      title: "Box TTL ends soon: short-lived",
      box: "short-lived",
    });
    expect(payload.body).toMatch(/^Stops at \d{4}-\d{2}-\d{2}T[\d:.]+Z\.$/);
  });
});
