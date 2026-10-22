import { spyOn } from "bun:test";

import { generateKeyPairPem } from "../../src/agent/identity";
import type { HostMetrics } from "../../src/host/metrics";
import { startServer } from "../../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "../support/app";

/** One HTTP exchange of the parity scenario, with ids, timestamps and snapshot stamps replaced by placeholders. */
export interface Exchange {
  step: string;
  method: string;
  path: string;
  status: number;
  contentType: string | null;
  body: string;
}

const GB = 1024 ** 3;
const PASSPHRASE = "correct horse battery staple";

/** A fixed host, so capacity errors do not depend on the machine running the scenario. */
const HOST = { cpu: { cores: 4 }, memory: { total: 8 * GB } } as unknown as HostMetrics;

/**
 * Replaces values that differ between runs: container and image ids, timestamps, snapshot stamps and event ids. Event
 * clock values become 0 rather than a placeholder, so each body is still JSON that the OpenAPI schema check can read.
 */
export function normalize(text: string): string {
  return text
    .replace(/mbx_[A-Za-z0-9_-]{20,}/g, "<token>")
    .replace(/"prefix":"mbx_[A-Za-z0-9_-]+"/g, '"prefix":"<prefix>"')
    .replace(/vol_[0-9a-z]+/g, "<volumeId>")
    .replace(/\bbx_[0-9a-z]+/g, "<boxId>")
    .replace(/\bck_[0-9a-z]{8,32}\b/g, "ck_<checkpoint>")
    .replace(/tok_[0-9a-f]+/g, "<tokenId>")
    .replace(/sha256:[0-9a-f]{64}/g, "sha256:<image>")
    .replace(/ex_[0-9A-HJKMNP-TV-Z]{26}/g, "ex_<ulid>")
    .replace(/[0-9a-f]{64}/g, "<id>")
    .replace(/ \([0-9a-f]{12}\)/g, " (<image>)")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>")
    .replace(/-\d{8}-\d{6}/g, "-<stamp>")
    .replace(/"parentId":"[0-9A-HJKMNP-TV-Z]{26}"/g, '"parentId":"<ulid>"')
    .replace(/"id":"[0-9A-HJKMNP-TV-Z]{26}"/g, '"id":"<ulid>"')
    .replace(/"taskId":"[0-9A-HJKMNP-TV-Z]{26}"/g, '"taskId":"<ulid>"')
    .replace(/"parentId":"[0-9A-HJKMNP-TV-Z]{26}"/g, '"parentId":"<ulid>"')
    .replace(/\/api\/tasks\/[0-9A-HJKMNP-TV-Z]{26}/g, "/api/tasks/<ulid>")
    .replace(/"cursor":"[0-9a-f]{12}\./g, '"cursor":"<epoch>.')
    .replace(/"ts":\d+/g, '"ts":0')
    .replace(/"durationMs":\d+/g, '"durationMs":0')
    .replace(/"latencyMs":\d+/g, '"latencyMs":0')
    .replace(/"code":"[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}"/g, '"code":"<pairing-code>"')
    .replace(/"agentId":"[0-9a-f]{32}"/g, '"agentId":"<agentId>"')
    .replace(/agent:\/\/[0-9a-f]{32}/g, "agent://<agentId>");
}

function boxId(json: Record<string, unknown> | null): string {
  return String((json?.box as { id?: string } | undefined)?.id ?? "");
}

function checkpointIdOf(task: Record<string, unknown>): string {
  const checkpoint = (task.result as { checkpoint?: { id?: string } } | undefined)?.checkpoint;
  return String(checkpoint?.id ?? "");
}

/** A rollback rebuilds the box, so it has a new container id, which the task result carries. */
function boxIdOfTask(task: Record<string, unknown>): string {
  const box = (task.result as { box?: { id?: string } } | undefined)?.box;
  return String(box?.id ?? "");
}

const rollbackAt = (box: string) => `/api/boxes/${box}/rollback`;
const ifMatch = (revision: number) => ({ "if-match": String(revision) });

/** The recycle bin entry that kept the named box or volume, from a trash list response. */
function entryNamed(json: Record<string, unknown> | null, name: string): string {
  const entries = (json?.trash ?? []) as { id?: string; sourceName?: string }[];
  return String(entries.find((entry) => entry.sourceName === name)?.id ?? "");
}

function snapshotRef(json: Record<string, unknown> | null): string {
  const direct = (json?.snapshot as { ref?: string } | undefined)?.ref;
  const nested = (json?.result as { snapshot?: { ref?: string } } | undefined)?.snapshot?.ref;
  return String(direct ?? nested ?? "");
}

/** Polls off the transcript until the task is finished, so the recorded GET is a stable terminal view. */
async function waitTask(base: string, json: Record<string, unknown> | null): Promise<Record<string, unknown>> {
  const id = String(json?.taskId ?? "");
  const deadline = Date.now() + 2000;
  for (;;) {
    const res = await fetch(`${base}/api/tasks/${id}`, { headers: { authorization: `Bearer ${TEST_KEY}` } });
    const view = (await res.json()) as Record<string, unknown>;
    if (view.status !== "running" || Date.now() > deadline) return view;
    await Bun.sleep(5);
  }
}

const MINUTE_MS = 60_000;

/**
 * Event timestamps group reads by the minute they fall in, so two identical reads on either side of a minute boundary
 * are stored as two rows, and every later sequence number moves. The clock is moved to the middle of a minute for the
 * run, which is far longer than the run takes. Every timestamp moves by the same amount, so their order is unchanged.
 */
function clockInMiddleOfMinute(): () => void {
  const real = Date.now;
  const offset = (MINUTE_MS / 2 - (real() % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
  const clock = spyOn(Date, "now").mockImplementation(() => real() + offset);
  return () => clock.mockRestore();
}

/**
 * Drives the box and snapshot API through success and failure paths and records every exchange. The same
 * scenario runs against the code before a refactor and after it, and the two transcripts must match.
 */
export async function runParityScenario(): Promise<Exchange[]> {
  const restoreClock = clockInMiddleOfMinute();
  try {
    return await recordScenario();
  } finally {
    restoreClock();
  }
}

async function recordScenario(): Promise<Exchange[]> {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  app.monitor.snapshot = async () => HOST;
  const restoreLogs = silenceLogs();
  const server = startServer(app);
  const base = `http://127.0.0.1:${server.port}`;
  const keys = app.hosts.get().keys;
  runtime.seedImage(
    app.cfg.baseTemplateTag,
    { [keys.template]: "true", [keys.templateName]: "base" },
    "2000-01-01T00:00:00.000Z",
  );
  runtime.unpullable.add("ghost:1");

  const exchanges: Exchange[] = [];
  let alphaRev = 0;

  async function send(
    step: string,
    method: string,
    path: string,
    init: {
      body?: string;
      contentType?: string;
      authed?: boolean;
      origin?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const headers = new Headers();
    if (init.authed !== false) headers.set("authorization", `Bearer ${TEST_KEY}`);
    if (init.contentType) headers.set("content-type", init.contentType);
    if (init.origin) headers.set("origin", init.origin);
    for (const [key, value] of Object.entries(init.headers ?? {})) headers.set(key, value);
    const res = await fetch(`${base}${path}`, { method, headers, body: init.body });
    const text = await res.text();
    exchanges.push({
      step,
      method,
      path: normalize(path),
      status: res.status,
      contentType: res.headers.get("content-type"),
      body: normalize(text),
    });
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    const box = json?.box as { name?: string; revision?: number } | undefined;
    if (box?.name === "alpha" && typeof box.revision === "number") alphaRev = box.revision;
    return { status: res.status, json };
  }

  const JSON_TYPE = "application/json";
  const post = (step: string, path: string, body: unknown) =>
    send(step, "POST", path, { body: JSON.stringify(body), contentType: JSON_TYPE });
  const put = (step: string, path: string, body: unknown) =>
    send(step, "PUT", path, { body: JSON.stringify(body), contentType: JSON_TYPE });
  const patch = (step: string, path: string, body: unknown, headers?: Record<string, string>) =>
    send(step, "PATCH", path, { body: JSON.stringify(body), contentType: JSON_TYPE, headers });
  const raw = (step: string, method: string, path: string, body: string) =>
    send(step, method, path, { body, contentType: JSON_TYPE });

  try {
    await send("no access key", "GET", "/api/boxes", { authed: false });
    await send("unknown api path", "GET", "/api/nope");
    await send("wrong method", "PUT", "/api/boxes");
    await send("health", "GET", "/api/health", { authed: false });
    await raw("malformed json", "POST", "/api/boxes", "{not json");
    await raw("array body", "POST", "/api/boxes", "[]");
    await send("form body refused", "POST", "/api/boxes", {
      body: "name=alpha",
      contentType: "application/x-www-form-urlencoded",
    });
    await send("cross-site write refused", "POST", "/api/boxes", {
      body: JSON.stringify({ name: "evil", cpus: 1, memoryMb: 256 }),
      contentType: JSON_TYPE,
      origin: "https://evil.example",
    });

    await post("create without name", "/api/boxes", {});
    await post("create with bad name", "/api/boxes", { name: "bad name!", cpus: 1, memoryMb: 256 });
    await post("create with blank name", "/api/boxes", { name: "   " });
    await post("create with numeric name", "/api/boxes", { name: 42 });
    await post("create with cpus over the limit", "/api/boxes", { name: "alpha", cpus: 500 });
    await post("create with null cpus", "/api/boxes", { name: "alpha", cpus: null });
    await post("create with text cpus", "/api/boxes", { name: "alpha", cpus: "abc" });
    await post("create with memory below the minimum", "/api/boxes", { name: "alpha", memoryMb: 64 });
    await post("create with fractional memory", "/api/boxes", { name: "alpha", memoryMb: 1024.5 });
    await post("create with text memory", "/api/boxes", { name: "alpha", memoryMb: "x" });
    await post("create from a missing image", "/api/boxes", { name: "alpha", template: "ghost:1", cpus: 1 });
    await post("create with a malformed template", "/api/boxes", { name: "alpha", template: "bad ref" });
    await post("create with a null template", "/api/boxes", { name: "alpha", template: null });
    await post("create with a blank template", "/api/boxes", { name: "alpha", template: "   " });
    await post("create over host cpu capacity", "/api/boxes", { name: "alpha", cpus: 5, memoryMb: 256 });
    await post("create over host memory capacity", "/api/boxes", { name: "alpha", cpus: 1, memoryMb: 9216 });

    const alpha = boxId((await post("create alpha", "/api/boxes", { name: "alpha", cpus: 2, memoryMb: 512 })).json);
    await post("create alpha again", "/api/boxes", { name: "alpha", cpus: 1, memoryMb: 256 });
    const beta = boxId(
      (
        await post("create beta with an empty template", "/api/boxes", {
          name: "beta",
          template: "",
          cpus: 1,
          memoryMb: 256,
        })
      ).json,
    );
    await post("create beta", "/api/boxes", { name: "beta", cpus: 1, memoryMb: 256 });

    const plain = runtime.seedContainer({ image: app.cfg.baseTemplateTag, name: "plain" });
    const alphaContainer = runtime.containers.get(alpha);
    if (alphaContainer) alphaContainer.logs = "one\ntwo\nthree\n";

    await send("list boxes with stats", "GET", "/api/boxes");
    await send("list boxes without stats", "GET", "/api/boxes?stats=false");
    await send("list boxes, stats=0 still includes stats", "GET", "/api/boxes?stats=0");
    await send("get alpha", "GET", `/api/boxes/${alpha}`);
    await send("get a missing box", "GET", "/api/boxes/missing");
    await send("get an unlabelled container", "GET", `/api/boxes/${plain}`);

    await send("logs with default tail", "GET", `/api/boxes/${alpha}/logs`);
    await send("logs with tail=2", "GET", `/api/boxes/${alpha}/logs?tail=2`);
    await send("logs with an empty tail", "GET", `/api/boxes/${alpha}/logs?tail=`);
    await send("logs with tail=0", "GET", `/api/boxes/${alpha}/logs?tail=0`);
    await send("logs with tail=abc", "GET", `/api/boxes/${alpha}/logs?tail=abc`);
    await send("logs with tail=2.5", "GET", `/api/boxes/${alpha}/logs?tail=2.5`);
    await send("logs of a missing box", "GET", "/api/boxes/missing/logs");
    await send("stats of alpha", "GET", `/api/boxes/${alpha}/stats`);
    await send("stats of a missing box", "GET", "/api/boxes/missing/stats");

    await send("stop alpha", "POST", `/api/boxes/${alpha}/stop`);
    await send("stop alpha again", "POST", `/api/boxes/${alpha}/stop`);
    await send("start alpha", "POST", `/api/boxes/${alpha}/start`);
    await send("restart alpha", "POST", `/api/boxes/${alpha}/restart`);
    const ran = await post("exec true in alpha", `/api/boxes/${alpha}/exec`, { argv: ["true"] });
    const execId = String(ran.json?.execId ?? "");
    await send("get the exec", "GET", `/api/execs/${execId}`);
    await send("read exec output", "GET", `/api/execs/${execId}/output`);
    await post("exec with neither cmd nor argv", `/api/boxes/${alpha}/exec`, {});
    await post("kill an exec that has finished", `/api/execs/${execId}/kill`, {});
    runtime.execScript = null;
    const background = await post("exec sleep in the background", `/api/boxes/${alpha}/exec`, {
      argv: ["sleep", "30"],
      background: true,
      timeoutSec: 30,
    });
    const sleepId = String(background.json?.execId ?? "");
    await post("kill the background exec", `/api/execs/${sleepId}/kill`, {});
    await send("get the killed exec", "GET", `/api/execs/${sleepId}?waitMs=0`);
    runtime.execScript = { stdout: "", stderr: "", code: 0 };
    await raw("start ignores a malformed body", "POST", `/api/boxes/${alpha}/start`, "{not json");
    await send("start a missing box", "POST", "/api/boxes/missing/start");
    await send("stop a missing box", "POST", "/api/boxes/missing/stop");

    await patch("resize cpus", `/api/boxes/${alpha}/resources`, { cpus: 1 }, { "if-match": String(alphaRev) });
    await patch("resize memory", `/api/boxes/${alpha}/resources`, { memoryMb: 768 }, { "if-match": String(alphaRev) });
    await patch("resize without If-Match", `/api/boxes/${alpha}/resources`, { cpus: 1 });
    await patch(
      "resize with a stale If-Match",
      `/api/boxes/${alpha}/resources`,
      { cpus: 1 },
      { "if-match": alphaRev === 1 ? "999" : "1" },
    );
    await patch("update idle timeout", `/api/boxes/${alpha}`, { idleTimeoutSec: 60 }, { "if-match": String(alphaRev) });
    await patch("resize with nothing", `/api/boxes/${alpha}/resources`, {});
    await patch("resize with null cpus only", `/api/boxes/${alpha}/resources`, { cpus: null });
    await patch("resize cpus over the limit", `/api/boxes/${alpha}/resources`, { cpus: 999 });
    await patch("resize with text memory", `/api/boxes/${alpha}/resources`, { memoryMb: "abc" });
    await patch("resize beyond host capacity", `/api/boxes/${alpha}/resources`, { cpus: 5 });
    await patch("resize a missing box", "/api/boxes/missing/resources", { cpus: 1 });
    await raw("resize with a malformed body", "PATCH", `/api/boxes/${alpha}/resources`, "{");
    await raw("resize with an array body", "PATCH", `/api/boxes/${alpha}/resources`, "[1]");

    const first = await post("snapshot alpha as nightly", `/api/boxes/${alpha}/snapshots`, { name: "nightly" });
    const nightly = snapshotRef(await waitTask(base, first.json));
    await send("list snapshots", "GET", "/api/snapshots");

    // Default-named snapshots share a second-resolution tag, so each is removed before the next is taken.
    // The create calls return 202; the image exists only after the task finishes.
    const discard = async (step: string, created: { json: Record<string, unknown> | null }) => {
      const ref = snapshotRef(await waitTask(base, created.json));
      return send(step, "DELETE", `/api/snapshots/${encodeURIComponent(ref)}`);
    };
    await discard(
      "discard snapshot taken with no body",
      await send("snapshot alpha with no body", "POST", `/api/boxes/${alpha}/snapshots`),
    );
    await discard(
      "discard snapshot taken with an empty name",
      await post("snapshot alpha with an empty name", `/api/boxes/${alpha}/snapshots`, { name: "" }),
    );
    await discard(
      "discard snapshot taken with a null name",
      await post("snapshot alpha with a null name", `/api/boxes/${alpha}/snapshots`, { name: null }),
    );
    await post("snapshot alpha with a bad name", `/api/boxes/${alpha}/snapshots`, { name: "bad name!" });
    await post("snapshot alpha with a numeric name", `/api/boxes/${alpha}/snapshots`, { name: 5 });
    await post("snapshot a missing box", "/api/boxes/missing/snapshots", { name: "x" });
    await post("snapshot a missing box with a bad name", "/api/boxes/missing/snapshots", { name: "bad name!" });

    const restored = boxId(
      (
        await post("restore snapshot as restored", `/api/snapshots/${encodeURIComponent(nightly)}/boxes`, {
          name: "restored",
          cpus: 1,
          memoryMb: 256,
        })
      ).json,
    );
    const restoredWithTemplate = boxId(
      (
        await post("restore snapshot with a body template", `/api/snapshots/${encodeURIComponent(nightly)}/boxes`, {
          name: "restored-2",
          template: "other:1",
        })
      ).json,
    );
    await post("restore snapshot with a duplicate name", `/api/snapshots/${encodeURIComponent(nightly)}/boxes`, {
      name: "restored",
    });
    await post("restore snapshot with a bad box name", `/api/snapshots/${encodeURIComponent(nightly)}/boxes`, {
      name: "bad name!",
    });
    await post("restore snapshot with cpus 0", `/api/snapshots/${encodeURIComponent(nightly)}/boxes`, {
      name: "ok-3",
      cpus: 0,
    });
    await post("restore a missing image", "/api/snapshots/ghost%3A1/boxes", { name: "ok-4" });
    await post("restore a malformed ref", `/api/snapshots/${encodeURIComponent("bad ref")}/boxes`, { name: "ok-5" });
    await post("restore with a non-object body", `/api/snapshots/${encodeURIComponent(nightly)}/boxes`, [1]);

    await post("promote nightly to gold", `/api/snapshots/${encodeURIComponent(nightly)}/promote`, {
      name: "gold",
      description: "Gold image",
    });
    // Templates are sorted by creation time at millisecond resolution; the pause keeps the rebuilt base after gold.
    await Bun.sleep(5);
    const built = await send("build the base template", "POST", "/api/templates/base/build");
    await waitTask(base, built.json);
    await send("list templates", "GET", "/api/templates");
    await send("delete gold", "DELETE", `/api/templates/${encodeURIComponent("mbtest-template:gold")}`);
    await send("delete a missing snapshot", "DELETE", "/api/snapshots/missing");

    await send("delete beta with a bad deleteVolume", "DELETE", `/api/boxes/${beta}?deleteVolume=yes`);
    await send("delete beta with an empty deleteVolume", "DELETE", `/api/boxes/${beta}?deleteVolume=`);
    await send("delete beta, keeping its volume", "DELETE", `/api/boxes/${beta}?deleteVolume=0`);
    await send("delete beta again", "DELETE", `/api/boxes/${beta}`);
    await send("delete a missing box", "DELETE", "/api/boxes/missing");
    await send("delete restored with its volume", "DELETE", `/api/boxes/${restored}?deleteVolume=true`);
    await send("delete restored-2", "DELETE", `/api/boxes/${restoredWithTemplate}`);
    runtime.seedDiff(alpha, [{ path: "/etc/motd", kind: "modified" }]);
    await send("rebuild alpha without confirm", "POST", `/api/boxes/${alpha}/rebuild`, {
      body: JSON.stringify({ profile: "strict" }),
      contentType: JSON_TYPE,
      headers: { "if-match": String(alphaRev) },
    });
    const rebuilt = await send("rebuild alpha", "POST", `/api/boxes/${alpha}/rebuild`, {
      body: JSON.stringify({ profile: "strict", confirm: true }),
      contentType: JSON_TYPE,
      headers: { "if-match": String(alphaRev) },
    });
    await send("delete alpha, keeping its volume", "DELETE", `/api/boxes/${boxId(rebuilt.json)}`);

    await send("delete nightly snapshot", "DELETE", `/api/snapshots/${encodeURIComponent(nightly)}`);
    await send("list snapshots after delete", "GET", "/api/snapshots");
    await send("activity feed", "GET", "/api/activity");
    await send("final box list", "GET", "/api/boxes");

    const gammaRes = await post("create gamma for volumes", "/api/boxes", { name: "gamma", cpus: 1, memoryMb: 256 });
    const gamma = boxId(gammaRes.json);
    const gammaRev = (gammaRes.json?.box as { revision?: number } | undefined)?.revision ?? 1;
    await send("list pools", "GET", "/api/pools");
    await send("list volumes", "GET", "/api/volumes");
    await send("get gamma workspace", "GET", "/api/volumes/gamma-workspace");
    await send("create spare volume without confirm", "POST", "/api/volumes", {
      body: JSON.stringify({ name: "spare" }),
      contentType: JSON_TYPE,
    });
    const spare = await post("create spare volume", "/api/volumes", { name: "spare", confirm: true });
    const spareId = String((spare.json?.volume as { id?: string } | undefined)?.id ?? "");
    await send("measure spare", "POST", `/api/volumes/${spareId}/usage`);
    await put("set spare limits", `/api/volumes/${spareId}/limits`, {
      softBytes: GB,
      hardBytes: 2 * GB,
      action: "warn",
    });
    await put("set spare limits with soft above hard", `/api/volumes/${spareId}/limits`, {
      softBytes: 2 * GB,
      hardBytes: GB,
    });
    await send("write a file on spare", "PUT", `/api/volumes/${spareId}/files/content`, {
      body: JSON.stringify({ path: "hello.txt", content: "hi\n" }),
      contentType: JSON_TYPE,
    });
    await send("read the file on spare", "GET", `/api/volumes/${spareId}/files/content?path=hello.txt`);
    await send("list files on spare", "GET", `/api/volumes/${spareId}/files?path=/&maxDepth=2`);
    await send("copy the file on spare", "POST", `/api/volumes/${spareId}/files/copy`, {
      body: JSON.stringify({ from: "hello.txt", to: "hello2.txt" }),
      contentType: JSON_TYPE,
    });
    await send("download spare root as tar", "GET", `/api/volumes/${spareId}/files/archive?path=/`);
    const tar = await send("download hello as tar", "GET", `/api/volumes/${spareId}/files/archive?path=hello.txt`);
    await send("upload tar onto spare", "PUT", `/api/volumes/${spareId}/files/archive`, {
      body: JSON.stringify({
        path: "uploaded",
        content: (tar.json as { content?: string } | null)?.content ?? "",
        encoding: "base64",
      }),
      contentType: JSON_TYPE,
    });
    await send("read escapes the volume", "GET", `/api/volumes/${spareId}/files/content?path=../secret`);
    await send("attach spare without confirm", "POST", `/api/volumes/${spareId}/attach`, {
      body: JSON.stringify({ box: gamma, path: "/srv/data", mode: "ro" }),
      contentType: JSON_TYPE,
      headers: { "if-match": String(gammaRev) },
    });
    const attached = await send("attach spare read-only", "POST", `/api/volumes/${spareId}/attach`, {
      body: JSON.stringify({ box: gamma, path: "/srv/data", mode: "ro", confirm: true }),
      contentType: JSON_TYPE,
      headers: { "if-match": String(gammaRev) },
    });
    const attachedRevision = (attached.json?.box as { revision?: number } | undefined)?.revision ?? 1;
    await send("detach spare", "POST", `/api/volumes/${spareId}/detach`, {
      body: JSON.stringify({ box: gamma, path: "/srv/data", confirm: true }),
      contentType: JSON_TYPE,
      headers: { "if-match": String(attachedRevision) },
    });
    await send("delete spare volume without confirm", "DELETE", `/api/volumes/${spareId}`);
    await send("delete spare volume", "DELETE", `/api/volumes/${spareId}?confirm=true`);
    const pools = [{ name: "local", backend: "local", default: true }];
    await send("replace pools without confirm", "PUT", "/api/pools", {
      body: JSON.stringify({ pools }),
      contentType: JSON_TYPE,
    });
    await send("replace pools", "PUT", "/api/pools", {
      body: JSON.stringify({ pools, confirm: true }),
      contentType: JSON_TYPE,
    });
    await send("delete gamma", "DELETE", `/api/boxes/${gamma}`);

    await send("events without a key", "GET", "/api/events", { authed: false });
    await send("events from another site", "GET", "/api/events", { origin: "https://evil.example" });
    const newest = await send("events of box creation", "GET", "/api/events?op=box.create&limit=2");
    await send(
      "older events of box creation",
      "GET",
      `/api/events?op=box.create&limit=2&cursor=${newest.json?.nextCursor}`,
    );
    await send("events with limit 0", "GET", "/api/events?limit=0");
    await send("events of alpha that failed", "GET", "/api/events?box=alpha&status=error");
    await send("list tasks", "GET", "/api/tasks");
    const finished = await send("read the base build task", "GET", `/api/tasks/${String(built.json?.taskId ?? "")}`);
    await send("read a missing task", "GET", "/api/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await send("read a malformed task id", "GET", "/api/tasks/not-a-task");
    await send("cancel a missing task", "POST", "/api/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV/cancel");
    await send("cancel a finished task", "POST", `/api/tasks/${String(finished.json?.id ?? "")}/cancel`);

    await send("list tool catalog", "GET", "/api/tools/catalog");
    const toolsBox = boxId(
      (
        await post("create tools box", "/api/boxes", {
          name: "toolsbox",
          cpus: 1,
          memoryMb: 256,
          tools: ["claude-code"],
        })
      ).json,
    );
    await send("list tools", "GET", "/api/tools");
    await send("list tools for the box", "GET", `/api/tools?id=${toolsBox}`);
    const priorHelper = runtime.helperHandler;
    const onVolume = new Set<string>();
    runtime.helperHandler = (spec) => {
      const cmd = spec.cmd.join(" ");
      if (cmd.includes("MBTOOL")) {
        const records = [...onVolume].map((id) => `MBTOOL\t${id}\t0\t1\t1.0.0`);
        return { exitCode: 0, logs: records.length ? `${records.join("\n")}\n` : "" };
      }
      if (cmd.includes("npm install")) {
        onVolume.add("claude-code");
        return { exitCode: 0, logs: "ok\n" };
      }
      if (cmd.includes("npm uninstall")) {
        onVolume.delete("claude-code");
        return { exitCode: 0, logs: "ok\n" };
      }
      return priorHelper(spec);
    };
    const installTask = await post("install claude-code", `/api/boxes/${toolsBox}/tools/install`, {
      tool: "claude-code",
      version: "latest",
    });
    await waitTask(base, installTask.json);
    await send("get install task", "GET", `/api/tasks/${String(installTask.json?.taskId ?? "")}`);
    const upgradeTask = await post("upgrade claude-code", `/api/boxes/${toolsBox}/tools/upgrade`, {
      tool: "claude-code",
      version: "latest",
    });
    await waitTask(base, upgradeTask.json);
    const reconcileTask = await send("reconcile tools", "POST", `/api/boxes/${toolsBox}/tools/reconcile`);
    await waitTask(base, reconcileTask.json);
    const uninstallTask = await post("uninstall claude-code", `/api/boxes/${toolsBox}/tools/uninstall`, {
      tool: "claude-code",
    });
    await waitTask(base, uninstallTask.json);
    const unknown = await post("install an unknown tool", `/api/boxes/${toolsBox}/tools/install`, {
      tool: "no-such-tool",
    });
    await waitTask(base, unknown.json);
    runtime.helperHandler = priorHelper;

    await send("list ports of the tools box", "GET", `/api/boxes/${toolsBox}/ports`);
    await post("expose a preview port", `/api/boxes/${toolsBox}/ports`, { port: 5173 });
    await post("expose an invalid preview port", `/api/boxes/${toolsBox}/ports`, { port: 0 });
    await send("list ports after expose", "GET", `/api/boxes/${toolsBox}/ports`);
    await send("unexpose the preview port", "DELETE", `/api/boxes/${toolsBox}/ports/5173`);
    await send("unexpose a missing preview port", "DELETE", `/api/boxes/${toolsBox}/ports/5173`);
    await send("delete the tools box", "DELETE", `/api/boxes/${toolsBox}`);

    const term = boxId(
      (await post("create the session box", "/api/boxes", { name: "term", cpus: 1, memoryMb: 256 })).json,
    );
    await send("list sessions of a box with none", "GET", `/api/boxes/${term}/sessions`);
    await post("start a session", `/api/boxes/${term}/sessions`, { name: "work" });
    await post("start the same session again", `/api/boxes/${term}/sessions`, { name: "work" });
    await post("start a session with a bad name", `/api/boxes/${term}/sessions`, { name: "bad name!" });
    await post("start a session in a missing box", "/api/boxes/missing/sessions", { name: "work" });
    await send("list sessions", "GET", `/api/boxes/${term}/sessions`);
    await post("type text into a session", `/api/boxes/${term}/sessions/work/input`, { text: "echo hi\n" });
    await post("press Enter in a session", `/api/boxes/${term}/sessions/work/input`, { keys: ["Enter"] });
    await post("send keys and text together", `/api/boxes/${term}/sessions/work/input`, { keys: ["Enter"], text: "x" });
    await post("send neither keys nor text", `/api/boxes/${term}/sessions/work/input`, {});
    await send("read the session", "GET", `/api/boxes/${term}/sessions/work?lines=10`);
    await send("read with an invalid since", "GET", `/api/boxes/${term}/sessions/work?since=bogus`);
    await send(
      "read with a cursor that cannot be continued",
      "GET",
      `/api/boxes/${term}/sessions/work?lines=5&since=000000000000.1`,
    );
    await send("read with zero lines", "GET", `/api/boxes/${term}/sessions/work?lines=0`);
    await send("read a missing session", "GET", `/api/boxes/${term}/sessions/nope`);
    await send("close the session", "DELETE", `/api/boxes/${term}/sessions/work`);
    await send("close the session again", "DELETE", `/api/boxes/${term}/sessions/work`);
    await send("read a closed session", "GET", `/api/boxes/${term}/sessions/work`);
    await send("delete the session box", "DELETE", `/api/boxes/${term}`);

    const minted = await post("create a readonly token", "/api/tokens", { name: "ci", preset: "readonly" });
    const tokenId = String((minted.json?.record as { id?: string } | undefined)?.id ?? "");
    await send("list tokens", "GET", "/api/tokens");
    await post("create a token with no scope", "/api/tokens", { name: "empty" });
    await post("create a duplicate token name", "/api/tokens", { name: "ci", preset: "readonly" });
    await send("revoke the readonly token", "DELETE", `/api/tokens/${tokenId}?deleteCreated=false`);
    await send("revoke the readonly token again", "DELETE", `/api/tokens/${tokenId}`);
    await send("revoke a missing token", "DELETE", "/api/tokens/missing");

    const ckbox = boxId(
      (await post("create the checkpoint box", "/api/boxes", { name: "ckbox", cpus: 1, memoryMb: 256 })).json,
    );
    const taken = await post("take a checkpoint", `/api/boxes/${ckbox}/checkpoints`, { label: "before refactor" });
    const ckId = checkpointIdOf(await waitTask(base, taken.json));
    await post("take a checkpoint in an unknown mode", `/api/boxes/${ckbox}/checkpoints`, { consistency: "warm" });
    await send("list checkpoints", "GET", "/api/checkpoints");
    await send("read the checkpoint", "GET", `/api/checkpoints/${ckId}`);
    await send("read a missing checkpoint", "GET", "/api/checkpoints/ck_0000000000000000000000000");
    await waitTask(base, (await patch("pin the checkpoint", `/api/checkpoints/${ckId}`, { pinned: true })).json);
    await send("delete a pinned checkpoint", "DELETE", `/api/checkpoints/${ckId}`);
    await waitTask(base, (await patch("unpin the checkpoint", `/api/checkpoints/${ckId}`, { pinned: false })).json);
    const revision = (await send("read the checkpoint box", "GET", `/api/boxes/${ckbox}`)).json?.box as
      | { revision?: number }
      | undefined;
    const rollbackPath = `/api/boxes/${ckbox}/rollback`;
    const current = { "if-match": String(revision?.revision ?? 1) };
    await send("roll back without a revision", "POST", rollbackPath, {
      body: JSON.stringify({ checkpoint: ckId, confirm: true }),
      contentType: JSON_TYPE,
    });
    await send("roll back from a stale revision", "POST", rollbackPath, {
      body: JSON.stringify({ checkpoint: ckId, confirm: true }),
      contentType: JSON_TYPE,
      headers: { "if-match": "9" },
    });
    await send("roll back without confirm", "POST", rollbackPath, {
      body: JSON.stringify({ checkpoint: ckId }),
      contentType: JSON_TYPE,
      headers: current,
    });
    const rolled = await send("roll back with confirm", "POST", rollbackPath, {
      body: JSON.stringify({ checkpoint: ckId, confirm: true }),
      contentType: JSON_TYPE,
      headers: current,
    });
    const rolledBox = boxIdOfTask(await waitTask(base, rolled.json));
    const forked = await post("fork the checkpoint", `/api/checkpoints/${ckId}/fork`, {
      name: "ckcopy",
      cpus: 1,
      memoryMb: 256,
    });
    await waitTask(base, forked.json);
    await post("fork the checkpoint under a taken name", `/api/checkpoints/${ckId}/fork`, {
      name: "ckcopy",
      cpus: 1,
      memoryMb: 256,
    });
    await waitTask(base, (await send("delete the checkpoint", "DELETE", `/api/checkpoints/${ckId}`)).json);
    await send("read the deleted checkpoint", "GET", `/api/checkpoints/${ckId}`);

    await send("list secrets with none", "GET", "/api/secrets");
    await raw("set a secret", "PUT", "/api/secrets/vault", JSON.stringify({ value: "parity-value" }));
    await raw("set a secret with an empty value", "PUT", "/api/secrets/vault", JSON.stringify({ value: "" }));
    await raw("set a secret with a bad name", "PUT", "/api/secrets/-bad", JSON.stringify({ value: "x" }));
    await send("list secrets", "GET", "/api/secrets");
    await send("delete a secret no box uses", "DELETE", "/api/secrets/vault");
    await send("delete a missing secret", "DELETE", "/api/secrets/vault");

    await raw("set the secret a box uses", "PUT", "/api/secrets/vault", JSON.stringify({ value: "parity-value" }));
    await post("create a box that names a missing secret", "/api/boxes", {
      name: "secretbox",
      cpus: 1,
      memoryMb: 256,
      env: [{ name: "TOKEN", secretRef: "absent" }],
    });
    const secretBox = boxId(
      (
        await post("create a box with a secret", "/api/boxes", {
          name: "secretbox",
          cpus: 1,
          memoryMb: 256,
          env: [
            { name: "TOKEN", secretRef: "vault" },
            { name: "GREETING", value: "hello" },
          ],
        })
      ).json,
    );
    await send("read the box with a secret", "GET", `/api/boxes/${secretBox}`);
    await send("delete a secret in use", "DELETE", "/api/secrets/vault");
    await send("delete a secret in use with force", "DELETE", "/api/secrets/vault?force=true");
    await send("delete the secret box", "DELETE", `/api/boxes/${secretBox}`);

    const afterRollback = await send("read the rolled back box", "GET", `/api/boxes/${rolledBox}`);
    const rolledRevision = (afterRollback.json?.box as { revision?: number } | undefined)?.revision ?? 1;
    await send("read the rollback that waits", "GET", rollbackAt(rolledBox));
    await post("confirm a rollback without confirm", `${rollbackAt(rolledBox)}/confirm`, {});
    await post("undo a rollback without a revision", `${rollbackAt(rolledBox)}/undo`, { confirm: true });
    await send("undo a rollback from a stale revision", "POST", `${rollbackAt(rolledBox)}/undo`, {
      body: JSON.stringify({ confirm: true }),
      contentType: JSON_TYPE,
      headers: ifMatch(rolledRevision + 5),
    });
    await send("undo a rollback without confirm", "POST", `${rollbackAt(rolledBox)}/undo`, {
      body: JSON.stringify({}),
      contentType: JSON_TYPE,
      headers: ifMatch(rolledRevision),
    });
    const undone = await send("undo the rollback", "POST", `${rollbackAt(rolledBox)}/undo`, {
      body: JSON.stringify({ confirm: true }),
      contentType: JSON_TYPE,
      headers: ifMatch(rolledRevision),
    });
    const undoneBox = boxIdOfTask(await waitTask(base, undone.json));
    await send("read the rollback after undo", "GET", rollbackAt(undoneBox));
    await post("confirm with nothing to confirm", `${rollbackAt(undoneBox)}/confirm`, { confirm: true });

    const second = await post("take a checkpoint before a second rollback", `/api/boxes/${undoneBox}/checkpoints`, {
      label: "before the second rollback",
    });
    const secondCheckpoint = checkpointIdOf(await waitTask(base, second.json));
    const beforeSecond = await send("read the box before the second rollback", "GET", `/api/boxes/${undoneBox}`);
    const secondRevision = (beforeSecond.json?.box as { revision?: number } | undefined)?.revision ?? 1;
    const again = await send("roll back again", "POST", rollbackAt(undoneBox), {
      body: JSON.stringify({ checkpoint: secondCheckpoint, confirm: true }),
      contentType: JSON_TYPE,
      headers: ifMatch(secondRevision),
    });
    const againTask = await waitTask(base, again.json);
    const rolledAgain = boxIdOfTask(againTask);
    const safety = String((againTask.result as { safety?: { id?: string } } | undefined)?.safety?.id ?? "");
    await send("delete the safety checkpoint of a waiting rollback", "DELETE", `/api/checkpoints/${safety}`);
    await send("read the rollback that waits again", "GET", rollbackAt(rolledAgain));
    const confirmed = await post("confirm the rollback", `${rollbackAt(rolledAgain)}/confirm`, { confirm: true });
    await waitTask(base, confirmed.json);
    const freed = await send("delete the safety checkpoint after confirm", "DELETE", `/api/checkpoints/${safety}`);
    await waitTask(base, freed.json);
    await send("read the rollback after confirm", "GET", rollbackAt(rolledAgain));
    await send("read the checkpoint repository usage", "GET", "/api/checkpoints/usage");

    const saved = await post("save a box as a template", `/api/boxes/${rolledAgain}/template`, { name: "saved" });
    await waitTask(base, saved.json);
    await post("save a box under a taken template name", `/api/boxes/${rolledAgain}/template`, { name: "saved" });
    await post("save a missing box as a template", "/api/boxes/missing/template", { name: "other" });
    const customTool = {
      name: "Parity tool",
      description: "A custom entry for the transcript.",
      category: "terminal",
      source: "npm",
      package: "parity-tool",
      bin: "parity-tool",
      requires: "Node ≥ 20",
      install: "npm install -g --prefix {{prefix}} {{package_spec}}",
      upgrade: "npm install -g --prefix {{prefix}} {{package_spec}}",
      uninstall: "npm uninstall -g --prefix {{prefix}} {{package}}",
      detect: "command -v parity-tool >/dev/null && parity-tool --version 2>/dev/null",
    };
    await send("list custom tools", "GET", "/api/tools/custom");
    await put("save a custom tool", "/api/tools/custom/parity-tool", customTool);
    await send("list custom tools after a save", "GET", "/api/tools/custom");
    await put("save a custom tool with an unknown placeholder", "/api/tools/custom/parity-tool", {
      ...customTool,
      install: "npm install -g {{home}}",
    });
    await put("save a custom tool over a built-in id", "/api/tools/custom/uv", customTool);
    await send("delete the custom tool", "DELETE", "/api/tools/custom/parity-tool");
    await send("delete a missing custom tool", "DELETE", "/api/tools/custom/parity-tool");
    await send("delete a built-in tool with no custom entry", "DELETE", "/api/tools/custom/uv");
    await send("list hosts before any is added", "GET", "/api/hosts");
    await post("test a tcp host without credentials", "/api/hosts/test", {
      id: "edge",
      endpoint: "tcp://engine.example:2376",
    });
    await post("test a host with a bad endpoint", "/api/hosts/test", { id: "edge", endpoint: "http://engine.example" });
    await post("test a unix host", "/api/hosts/test", { id: "lab", endpoint: "unix:///var/run/lab.sock" });
    await post("add a host with a bad id", "/api/hosts", { id: "Lab One", endpoint: "unix:///var/run/lab.sock" });
    await post("add the lab host", "/api/hosts", { id: "lab", endpoint: "unix:///var/run/lab.sock", name: "Lab" });
    await post("add the lab host again", "/api/hosts", { id: "lab", endpoint: "unix:///var/run/lab.sock" });
    await post("add a host named local", "/api/hosts", { id: "local", endpoint: "unix:///var/run/lab.sock" });
    await send("list hosts after adding lab", "GET", "/api/hosts");
    await send("remove the local host", "DELETE", "/api/hosts/local");
    await send("remove the lab host", "DELETE", "/api/hosts/lab");
    await send("remove a missing host", "DELETE", "/api/hosts/missing");
    await send("list hosts after removing lab", "GET", "/api/hosts");

    const portBox = boxId(
      (await post("create a box to export", "/api/boxes", { name: "portbox", cpus: 1, memoryMb: 256 })).json,
    );
    const portable = checkpointIdOf(
      await waitTask(
        base,
        (await post("take a checkpoint to export", `/api/boxes/${portBox}/checkpoints`, { label: "to export" })).json,
      ),
    );
    const exportPath = `/api/checkpoints/${portable}/export`;
    await post("export a checkpoint with a short passphrase", exportPath, { passphrase: "short" });
    await waitTask(base, (await post("export the checkpoint", exportPath, { passphrase: PASSPHRASE })).json);
    await post("export a missing checkpoint", "/api/checkpoints/ck_0000000000000000000000000/export", {
      passphrase: PASSPHRASE,
    });
    const importPath = "/api/packages/pk_0000000000000000/import";
    await post("import a short passphrase", importPath, { passphrase: "short" });
    await waitTask(
      base,
      (await post("import a package that is not stored", importPath, { passphrase: PASSPHRASE })).json,
    );
    await send("upload a body that is not a package", "POST", "/api/packages", {
      body: "not a package",
      contentType: "application/octet-stream",
    });
    await send("download a package that is not stored", "GET", "/api/packages/pk_0000000000000000/download");

    const timeBox = boxId(
      (await post("create a box to schedule", "/api/boxes", { name: "timebox", cpus: 1, memoryMb: 256 })).json,
    );
    const schedulePath = `/api/boxes/${timeBox}/checkpoint-schedule`;
    await send("read the schedule of a box with none", "GET", schedulePath);
    await put("set an hourly schedule", schedulePath, { everyHours: 6 });
    await put("set a schedule with an hour and a time", schedulePath, { everyHours: 6, at: "02:30" });
    await put("set a schedule past the longest interval", schedulePath, { everyHours: 721 });
    await send("read the schedule", "GET", schedulePath);
    await send("clear the schedule", "DELETE", schedulePath);
    await send("clear the schedule again", "DELETE", schedulePath);

    await send("list host usage after removing lab", "GET", "/api/hosts/usage");
    const mover = boxId(
      (await post("create a box to move", "/api/boxes", { name: "mover", cpus: 1, memoryMb: 256 })).json,
    );
    const moveBox = (step: string, id: string, body: unknown, revision: number) =>
      send(step, "POST", `/api/boxes/${id}/move`, {
        body: JSON.stringify(body),
        contentType: JSON_TYPE,
        headers: ifMatch(revision),
      });
    await moveBox("move a box to its own host", mover, { host: "local" }, 1);
    await moveBox("move a box with a stale revision", mover, { host: "local", confirm: true }, 9);
    await moveBox("move a box to a host that is not added", mover, { host: "lab", confirm: true }, 1);
    await moveBox("move a missing box", "missing", { host: "lab", confirm: true }, 1);

    const startbox = boxId(
      (
        await post("create a box with a startup command", "/api/boxes", {
          name: "startbox",
          cpus: 1,
          memoryMb: 256,
          startupCommand: "echo ready",
        })
      ).json,
    );
    const startupAt = `/api/boxes/${startbox}/startup-command`;
    await post("create a box with a startup command that is not text", "/api/boxes", {
      name: "startbad",
      cpus: 1,
      memoryMb: 256,
      startupCommand: 5,
    });
    await send("read the startup command", "GET", startupAt);
    await send("read the startup command of a missing box", "GET", "/api/boxes/missing/startup-command");
    await send("set the startup command without a revision", "PUT", startupAt, {
      body: JSON.stringify({ command: "echo two" }),
      contentType: JSON_TYPE,
    });
    await send("set the startup command with a stale revision", "PUT", startupAt, {
      body: JSON.stringify({ command: "echo two" }),
      contentType: JSON_TYPE,
      headers: ifMatch(9),
    });
    await send("set a startup command of only spaces", "PUT", startupAt, {
      body: JSON.stringify({ command: "   " }),
      contentType: JSON_TYPE,
      headers: ifMatch(1),
    });
    await send("set a startup command with a control character", "PUT", startupAt, {
      body: JSON.stringify({ command: "echo \u0007" }),
      contentType: JSON_TYPE,
      headers: ifMatch(1),
    });
    await send("set the startup command", "PUT", startupAt, {
      body: JSON.stringify({ command: "echo two" }),
      contentType: JSON_TYPE,
      headers: ifMatch(1),
    });
    await send("set the same startup command again", "PUT", startupAt, {
      body: JSON.stringify({ command: "echo two" }),
      contentType: JSON_TYPE,
      headers: ifMatch(2),
    });
    await send("set the startup command and apply it now", "PUT", startupAt, {
      body: JSON.stringify({ command: "echo three", applyNow: true }),
      contentType: JSON_TYPE,
      headers: ifMatch(2),
    });
    await send("run the startup command again", "POST", `${startupAt}/run`);
    await send("stop the startup box", "POST", `/api/boxes/${startbox}/stop`);
    await send("set the startup command while stopped", "PUT", startupAt, {
      body: JSON.stringify({ command: "echo four" }),
      contentType: JSON_TYPE,
      headers: ifMatch(4),
    });
    await send("run the startup command while stopped", "POST", `${startupAt}/run`);
    await send("start the startup box", "POST", `/api/boxes/${startbox}/start`);
    await send("remove the startup command with a stale revision", "DELETE", startupAt, { headers: ifMatch(4) });
    await send("remove the startup command", "DELETE", startupAt, { headers: ifMatch(6) });
    await send("run the startup command with none set", "POST", `${startupAt}/run`);
    await send("read the startup command after removal", "GET", startupAt);
    await send("delete the startup box", "DELETE", `/api/boxes/${startbox}`);
    const agentKey = generateKeyPairPem();
    const issued = await post("create a pairing code for an agent host", "/api/hosts/pairing", { id: "edge" });
    await post("create a pairing code for a host that exists", "/api/hosts/pairing", { id: "local" });
    await post("create a pairing code with a bad id", "/api/hosts/pairing", { id: "Edge One" });
    await post("revoke a host that is not an agent", "/api/hosts/local/revoke", {});
    await post("revoke a missing host", "/api/hosts/missing/revoke", {});
    const agent = { publicKey: agentKey.publicKeyPem, version: "0.4.0", protocol: 1 };
    await post("pair an agent with an unknown code", "/api/agent/pair", { ...agent, code: "00000-00000" });
    await post("pair an agent with its code", "/api/agent/pair", { ...agent, code: String(issued.json?.code ?? "") });
    await post("pair an agent with a used code", "/api/agent/pair", {
      ...agent,
      code: String(issued.json?.code ?? ""),
    });
    await send("list hosts with an agent", "GET", "/api/hosts");
    await post("revoke the agent host", "/api/hosts/edge/revoke", {});
    await send("remove the revoked agent host", "DELETE", "/api/hosts/edge");
    const filesRes = await post("create the files volume", "/api/volumes", { name: "files", confirm: true });
    const filesId = String((filesRes.json?.volume as { id?: string } | undefined)?.id ?? "");
    const OCTET = "application/octet-stream";
    const streamPath = `/api/volumes/${filesId}/files/stream`;
    await send("stream a file up without an octet-stream type", "PUT", `${streamPath}?path=notes/todo.txt`, {
      body: "one\n",
      contentType: "text/plain",
    });
    await send("stream a file up", "PUT", `${streamPath}?path=notes/todo.txt`, { body: "one\n", contentType: OCTET });
    await send("stream a file over an existing one without overwrite", "PUT", `${streamPath}?path=notes/todo.txt`, {
      body: "two\n",
      contentType: OCTET,
    });
    await send(
      "stream a file over an existing one with overwrite",
      "PUT",
      `${streamPath}?path=notes/todo.txt&overwrite=true`,
      {
        body: "two\n",
        contentType: OCTET,
      },
    );
    await send("stream a file back", "GET", `${streamPath}?path=notes/todo.txt`);
    await send("stream a missing file back", "GET", `${streamPath}?path=notes/nope.txt`);
    await send("create a folder with its parents", "POST", `/api/volumes/${filesId}/files/directory`, {
      body: JSON.stringify({ path: "made/deep" }),
      contentType: JSON_TYPE,
    });
    await send("stream a file into a folder", "PUT", `${streamPath}?path=made/other.txt`, {
      body: "other\n",
      contentType: OCTET,
    });
    await send("move a file onto an existing one", "POST", `/api/volumes/${filesId}/files/move`, {
      body: JSON.stringify({ from: "made/other.txt", to: "notes/todo.txt" }),
      contentType: JSON_TYPE,
    });
    await send("move a file", "POST", `/api/volumes/${filesId}/files/move`, {
      body: JSON.stringify({ from: "notes/todo.txt", to: "made/deep/moved.txt" }),
      contentType: JSON_TYPE,
    });
    await send("move a path onto itself", "POST", `/api/volumes/${filesId}/files/move`, {
      body: JSON.stringify({ from: "made", to: "made" }),
      contentType: JSON_TYPE,
    });
    await send("delete a file without confirm", "DELETE", `/api/volumes/${filesId}/files?path=made/deep/moved.txt`);
    await send("delete a file", "DELETE", `/api/volumes/${filesId}/files?path=made/deep/moved.txt&confirm=true`);
    await send("delete the volume root", "DELETE", `/api/volumes/${filesId}/files?path=/&confirm=true`);

    const sampleSource = { kind: "dockerfile", text: "FROM alpine:3.20\n" };
    const sample = await post("create a template from a Dockerfile", "/api/templates", {
      name: "sample",
      source: sampleSource,
    });
    await waitTask(base, sample.json);
    await send("read the template build task", "GET", `/api/tasks/${String(sample.json?.taskId ?? "")}`);
    await post("create a template without a source", "/api/templates", { name: "nosource" });
    await post("create a template from a Dockerfile without FROM", "/api/templates", {
      name: "nofrom",
      source: { kind: "dockerfile", text: "RUN true\n" },
    });
    const sampleRebuilt = await send(
      "rebuild the sample template",
      "POST",
      "/api/templates/mbtest-template%3Asample/rebuild",
    );
    await waitTask(base, sampleRebuilt.json);
    await send("read the rebuild task", "GET", `/api/tasks/${String(sampleRebuilt.json?.taskId ?? "")}`);
    await send("rebuild a template that was not declared", "POST", "/api/templates/mbtest-template%3Abase/rebuild");

    const pulled = await post("pull an image", "/api/images/pull", { ref: "alpine:3.20" });
    await waitTask(base, pulled.json);
    await send("read the pull task", "GET", `/api/tasks/${String(pulled.json?.taskId ?? "")}`);
    const absent = await post("pull an image the registry does not hold", "/api/images/pull", { ref: "ghost:1" });
    await waitTask(base, absent.json);
    await send("read the failed pull task", "GET", `/api/tasks/${String(absent.json?.taskId ?? "")}`);
    await post("pull an image with a bad reference", "/api/images/pull", { ref: "bad ref" });
    await send("list notification channels when there are none", "GET", "/api/notify/channels");
    const alerts = "/api/notify/channels/alerts";
    await put("create a webhook channel with a signing key", alerts, {
      name: "Alerts",
      type: "webhook",
      events: ["box.oom"],
      url: "http://127.0.0.1:9/hook",
      secret: "signing-key-1",
    });
    await put("create a webhook channel with a URL that is not http", "/api/notify/channels/bad", {
      name: "Bad",
      type: "webhook",
      events: ["box.oom"],
      url: "ftp://example.com/hook",
    });
    await put("create a telegram channel without a bot token", "/api/notify/channels/chat", {
      name: "Chat",
      type: "telegram",
      events: ["host.offline"],
      chatId: "-1001234567890",
    });
    await send("list notification channels", "GET", "/api/notify/channels");
    await send("send a test notice to a channel on a private address", "POST", `${alerts}/test`);
    await send("list notification deliveries", "GET", "/api/notify/deliveries?limit=10");
    await send("list notification deliveries with a zero limit", "GET", "/api/notify/deliveries?limit=0");
    await send("delete the webhook channel", "DELETE", alerts);
    await send("delete the webhook channel again", "DELETE", alerts);

    const doomed = await post("create a box to delete into the recycle bin", "/api/boxes", {
      name: "doomed",
      cpus: 1,
      memoryMb: 256,
    });
    await send("delete the doomed box", "DELETE", `/api/boxes/${boxId(doomed.json)}`);
    const listed = await send("list the recycle bin", "GET", "/api/trash");
    const doomedEntry = entryNamed(listed.json, "doomed");
    const trashRestored = await post(
      "restore the recycle bin entry as a new box",
      `/api/trash/${doomedEntry}/restore`,
      { name: "doomed-copy" },
    );
    await waitTask(base, trashRestored.json);
    await send("read the restore task", "GET", `/api/tasks/${String(trashRestored.json?.taskId ?? "")}`);
    await post("restore a recycle bin entry that is gone", `/api/trash/${doomedEntry}/restore`, {});

    const keptBox = await post("create a box to keep in the recycle bin", "/api/boxes", {
      name: "spare-box",
      cpus: 1,
      memoryMb: 256,
    });
    await send("delete the spare box", "DELETE", `/api/boxes/${boxId(keptBox.json)}`);
    const kept = entryNamed((await send("list the recycle bin again", "GET", "/api/trash")).json, "spare-box");
    const purged = await send("purge a recycle bin entry", "DELETE", `/api/trash/${kept}`);
    await waitTask(base, purged.json);
    await send("read the purge task", "GET", `/api/tasks/${String(purged.json?.taskId ?? "")}`);
    await send("purge a recycle bin entry that is gone", "DELETE", `/api/trash/${kept}`);
    await send("purge a missing recycle bin entry", "DELETE", "/api/trash/ck_0000000000000000000000000");
  } finally {
    server.stop(true);
    app.throttle.stop();
    app.hostAdmin.close();
    restoreLogs();
  }
  return exchanges;
}
