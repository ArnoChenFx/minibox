/**
 * Saves a box as a template on a real engine, through the REST API, and creates a box from that template. The template
 * keeps the box's system layer: a file written outside the volumes is in the new box. /workspace is not carried, so
 * the new box starts with an empty one. A name already taken is refused before any commit, and the template keeps its
 * image.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) picks a fresh label prefix and sweeps what the run left behind. To run
 * this file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-templates.test.ts
 *
 * Optional: DOCKER_SOCKET (default /var/run/docker.sock) and MINIBOX_TEST_IMAGE (default alpine:3.20). The image must
 * already be present locally. It is also the base template, so the boxes these tests create start from it. The prefix
 * must start with "mbit", so the cleanup can never touch a real MiniBox install.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import Docker from "dockerode";

import { type App, createApp } from "../src/app";
import { createDockerRuntime } from "../src/docker/runtime";
import type { HostCtx } from "../src/host/registry";
import type { Runtime } from "../src/runtime";
import { startServer } from "../src/server";
import * as boxes from "../src/services/boxes";
import { createSnapshot, deleteSnapshot } from "../src/services/snapshots";
import { createDeclaredTemplate } from "../src/services/template-builds";
import { deleteTemplate } from "../src/services/templates";
import { silenceLogs, testConfig } from "./support/app";
import { call, finishedTask, refused } from "./support/tokens";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const LONG = 120_000;
const TEMPLATE = `${prefix}-template:probe`;
const runtime: Runtime = createDockerRuntime(SOCKET);
const docker = new Docker({ socketPath: SOCKET });

let app: App;
let host: HostCtx;
let server: ReturnType<typeof startServer>;
let base: string;
let restoreLogs: () => void;
const madeBoxes: string[] = [];

/** Runs a shell snippet in a container as `user` and returns what it printed, trimmed. */
async function run(containerId: string, user: string, script: string): Promise<string> {
  const session = await runtime.startExec(containerId, {
    cmd: ["sh", "-c", `${script}; echo MB_DONE`],
    env: [],
    workingDir: "/",
    user,
    tty: false,
  });
  session.stderr.resume();
  let text = "";
  session.stdout.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  try {
    const deadline = Date.now() + 60_000;
    while (!text.includes("MB_DONE")) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${script}`);
      await Bun.sleep(100);
    }
  } finally {
    session.stream.destroy();
  }
  return text.slice(0, text.indexOf("MB_DONE")).trim();
}

/** Creates a box over REST from `template`, and remembers it for cleanup. */
async function makeBox(name: string, template = IMAGE): Promise<{ boxId: string; containerId: string }> {
  const made = await call(base, "/api/boxes", { body: { name, template, cpus: 1, memoryMb: 256 } });
  if (made.status !== 201) throw new Error(`create ${name}: ${made.status} ${JSON.stringify(made.json)}`);
  const boxId = made.json.box?.boxId ?? "";
  madeBoxes.push(boxId);
  return { boxId, containerId: (await boxes.getBox(host, boxId)).id };
}

beforeAll(() => {
  if (!enabled) return;
  restoreLogs = silenceLogs();
  app = createApp(testConfig({ labelPrefix: prefix, dockerSocket: SOCKET, baseTemplateTag: IMAGE }), "0.0.0-test", {
    runtime,
    eventsPath: ":memory:",
  });
  host = app.hosts.get();
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (!enabled) return;
  server?.stop(true);
  app?.throttle.stop();
  app?.sessions.stop();
  app?.tokens.stop();
  app?.events.close();
  for (const boxId of madeBoxes) await boxes.deleteBox(host, boxId, true).catch(() => {});
  await deleteTemplate(host, TEMPLATE).catch(() => {});
  const { Volumes } = await docker.listVolumes({ filters: { label: [`${prefix}=true`] } });
  for (const volume of Volumes ?? [])
    await docker
      .getVolume(volume.Name)
      .remove()
      .catch(() => {});
  restoreLogs?.();
});

describe.skipIf(!enabled)("Saving a box as a template on a real engine", () => {
  test(
    "the template keeps the box's system layer, and a box made from it starts with an empty /workspace",
    async () => {
      const source = await makeBox("tpl-source");
      await run(
        source.containerId,
        "root",
        "echo system-layer > /etc/minibox-probe && echo data > /workspace/data.txt",
      );
      expect(await run(source.containerId, "root", "cat /etc/minibox-probe /workspace/data.txt")).toBe(
        "system-layer\ndata",
      );

      const started = await call(base, `/api/boxes/${source.boxId}/template`, {
        body: { name: "probe", description: "saved by the docker test" },
      });
      expect(started.status).toBe(202);
      expect(await finishedTask(base, started.json.taskId ?? "")).toMatchObject({
        status: "succeeded",
        result: { template: { ref: TEMPLATE, name: "probe" } },
      });

      const image = await runtime.inspectImage(TEMPLATE);
      expect(image.labels).toMatchObject({
        [host.keys.template]: "true",
        [host.keys.snapshot]: "false",
        [host.keys.templateName]: "probe",
        [host.keys.snapshotOf]: "tpl-source",
        [host.keys.snapshotOfId]: source.boxId,
        [host.keys.createdBy]: "owner",
      });
      expect(
        await runtime.listImages({ labels: { [host.keys.snapshot]: "true", [host.keys.snapshotOf]: "tpl-source" } }),
      ).toEqual([]);

      const listed = await call(base, "/api/templates");
      expect(listed.json.templates).toContainEqual(
        expect.objectContaining({ ref: TEMPLATE, source: "tpl-source", sourceId: source.boxId }),
      );

      const copy = await makeBox("tpl-copy", TEMPLATE);
      expect(
        await run(
          copy.containerId,
          "root",
          "cat /etc/minibox-probe; test -e /workspace/data.txt && echo kept || echo empty",
        ),
      ).toBe("system-layer\nempty");
    },
    LONG,
  );

  test(
    "a name already taken is refused before any commit, and the template keeps its image",
    async () => {
      const other = await makeBox("tpl-other");
      const before = (await runtime.inspectImage(TEMPLATE)).id;

      const again = await call(base, `/api/boxes/${other.boxId}/template`, { body: { name: "probe" } });

      expect(refused(again)).toEqual({ status: 409, key: "template_name_taken" });
      expect((await runtime.inspectImage(TEMPLATE)).id).toBe(before);
      expect(await runtime.listImages({ labels: { [host.keys.snapshotOf]: "tpl-other" } })).toEqual([]);
    },
    LONG,
  );

  test(
    "promoting a snapshot under a taken name is refused, and the template keeps its image",
    async () => {
      const kept = await makeBox("tpl-kept");
      const { ref } = await createSnapshot(host, kept.boxId, "kept");
      const before = (await runtime.inspectImage(TEMPLATE)).id;

      const promoted = await call(base, `/api/snapshots/${encodeURIComponent(ref)}/promote`, {
        body: { name: "probe" },
      });

      expect(refused(promoted)).toEqual({ status: 409, key: "template_name_taken" });
      expect((await runtime.inspectImage(TEMPLATE)).id).toBe(before);
      await deleteSnapshot(host, ref);
    },
    LONG,
  );
  test(
    "declared source edits, description commits and rebuild keep one valid recipe on the real engine",
    async () => {
      const ref = `${prefix}-template:review-edit`;
      try {
        await createDeclaredTemplate(
          host,
          { name: "review-edit", source: { kind: "dockerfile", text: `FROM ${IMAGE}\n` }, createdBy: "owner" },
          {},
        );
        const before = (await runtime.inspectImage(ref)).id;
        const path = `/api/templates/${encodeURIComponent(ref)}`;
        expect(
          (
            await call(base, path, {
              method: "PATCH",
              body: {
                source: { kind: "dockerfile", text: `FROM ${IMAGE}\nENV REVIEW_LITERAL=literal\n` },
                init: { postCreate: ["printf", "%s", "$REVIEW_LITERAL"], forwardPorts: [3000] },
              },
            })
          ).status,
        ).toBe(200);
        expect((await runtime.inspectImage(ref)).id).toBe(before);
        expect((await call(base, path, { method: "PATCH", body: { description: "Reviewed source" } })).status).toBe(
          200,
        );
        expect((await runtime.inspectImage(ref)).id).not.toBe(before);
        const recipe = await call(base, `${path}/recipe`);
        expect(recipe.status).toBe(200);
        expect(recipe.json.recipe?.postCreate).toEqual(["printf", "%s", "$REVIEW_LITERAL"]);
        const listed = await call(base, "/api/templates");
        expect(listed.json.templates?.filter((template) => template.name === "review-edit")).toHaveLength(1);
        const started = await call(base, `${path}/rebuild`, { body: {} });
        expect(started.status).toBe(202);
        expect((await finishedTask(base, started.json.taskId ?? "")).status).toBe("succeeded");
        expect((await call(base, `${path}/recipe`)).status).toBe(200);
      } finally {
        await deleteTemplate(host, ref).catch(() => {});
      }
    },
    LONG,
  );
});
