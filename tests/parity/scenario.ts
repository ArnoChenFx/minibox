import { spyOn } from "bun:test";

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
    .replace(/"durationMs":\d+/g, '"durationMs":0');
}

function boxId(json: Record<string, unknown> | null): string {
  return String((json?.box as { id?: string } | undefined)?.id ?? "");
}

function checkpointIdOf(task: Record<string, unknown>): string {
  const checkpoint = (task.result as { checkpoint?: { id?: string } } | undefined)?.checkpoint;
  return String(checkpoint?.id ?? "");
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
    await waitTask(base, rolled.json);
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
  } finally {
    server.stop(true);
    app.throttle.stop();
    restoreLogs();
  }
  return exchanges;
}
