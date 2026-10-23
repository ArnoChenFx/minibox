import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { RuntimeError } from "../src/runtime";
import { type OfficialName, OFFICIAL_TEMPLATES } from "../src/services/official-templates";
import { type Cluster, boxOn as boxOnIn, bootCluster, errorOf, type HostName } from "./support/cluster";
import { mint } from "./support/tokens";

const root = resolve(import.meta.dir, "..");
const shipped = (name: string) => readFileSync(resolve(root, "templates/official", name, "Dockerfile"), "utf8");
const aptInstallOf = (text: string) => text.slice(text.indexOf("apt-get install"), text.indexOf("rm -rf /var/lib/apt"));

const PYTHON = "mbtest-template:python";
const GO = "mbtest-template:go";

let cluster: Cluster | undefined;

afterEach(() => {
  cluster?.close();
  cluster = undefined;
});

async function boot(templates: HostName[] = ["local", "small", "large"]): Promise<Cluster> {
  cluster = await bootCluster({}, templates);
  return cluster;
}

function current(): Cluster {
  if (!cluster) throw new Error("the test has not booted");
  return cluster;
}

const createOn = (host: string | undefined, name: string, template: string) =>
  current().post("/api/boxes", { name, cpus: 1, memoryMb: 256, host, template, mounts: [] });

const boxOn = (host: string | undefined, name: string, extra: Record<string, unknown> = {}) =>
  boxOnIn(current(), host, name, extra);

async function buildOfficial(host: HostName, name: OfficialName): Promise<void> {
  const res = await current().api(`/api/templates/official/${name}/build?host=${host}`, { method: "POST" });
  expect(res.status).toBe(202);
  await current().app.tasks.drain();
}

async function listedOn(host: HostName): Promise<{ ref: string; buildKind?: string }[]> {
  const res = await current().api(`/api/templates?host=${host}`);
  return ((await res.json()) as { templates: { ref: string; buildKind?: string }[] }).templates;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

describe("the official templates ship with a pinned base and the box convention", () => {
  test("each one's base is the image its Dockerfile starts from", () => {
    for (const template of OFFICIAL_TEMPLATES) {
      expect(shipped(template.name).match(/^FROM (\S+)$/m)?.[1]).toBe(template.base);
    }
  });

  test("each one runs as the dev user with the uid and gid the box convention uses, and sleeps as its command", () => {
    for (const template of OFFICIAL_TEMPLATES) {
      const text = shipped(template.name);
      expect(text).toContain("ARG DEV_UID=1000");
      expect(text).toContain("ARG DEV_GID=1000");
      expect(text).toMatch(/^USER dev$/m);
      expect(text).toContain(`minibox.template.name=${template.name}`);
      expect(text).toContain('minibox.template.uid="${DEV_UID}"');
      expect(text).toContain('CMD ["sleep", "infinity"]');
    }
  });

  test("each one installs the tools every box needs", () => {
    for (const template of OFFICIAL_TEMPLATES) {
      const apt = aptInstallOf(shipped(template.name));
      for (const pkg of [
        "git",
        "curl",
        "tmux",
        "jq",
        "ripgrep",
        "sudo",
        "openssh-sftp-server",
        "socat",
        "iputils-ping",
      ]) {
        expect(apt).toContain(pkg);
      }
    }
  });

  test("the minimal one carries no compiler and no Python, and the others carry a compiler", () => {
    expect(aptInstallOf(shipped("minimal"))).not.toMatch(/build-essential|python3/);
    for (const name of ["node", "python", "go"] as const) {
      expect(aptInstallOf(shipped(name))).toContain("build-essential");
    }
  });
});

describe("the catalog is listed with the ref each template has on this host", () => {
  test("GET /api/templates/official names the four, each with its ref, description and pinned base", async () => {
    await boot();
    const res = await current().api("/api/templates/official");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      templates: OFFICIAL_TEMPLATES.map((template) => ({
        name: template.name,
        ref: `mbtest-template:${template.name}`,
        description: template.description,
        base: template.base,
      })),
    });
  });
});

describe("an owner builds an official template on a host", () => {
  test("the build runs as a task from the Dockerfile that ships, and the template then lists as official", async () => {
    await boot();
    const res = await current().api("/api/templates/official/minimal/build?host=small", { method: "POST" });
    expect(res.status).toBe(202);
    const { taskId } = (await res.json()) as { taskId: string };
    await current().app.tasks.drain();

    expect(current().app.tasks.get(taskId, { output: false })).toMatchObject({
      op: "template.official.build",
      status: "succeeded",
      hostId: "small",
      result: { template: { ref: "mbtest-template:minimal", name: "minimal" } },
    });
    const [build] = current().engines.small.builds;
    expect(build).toMatchObject({ tag: "mbtest-template:minimal", dockerfile: "Dockerfile" });
    expect(build?.files.get("Dockerfile")).toBe(shipped("minimal"));
    expect(await listedOn("small")).toContainEqual(
      expect.objectContaining({ ref: "mbtest-template:minimal", buildKind: "official" }),
    );
  });

  test("a name the host already holds is refused with 409, and nothing is built", async () => {
    await boot();
    const engine = current().engines.small;
    const keys = current().app.hosts.get().keys;
    engine.seedImage("mbtest-template:minimal", { [keys.template]: "true", [keys.templateName]: "minimal" });

    const res = await current().api("/api/templates/official/minimal/build?host=small", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ key: "template_name_taken" });
    expect(engine.builds).toEqual([]);
  });

  test("an unknown name is a 400 and a host that is not added is a 404, and neither starts a task", async () => {
    await boot();
    const unknown = await current().api("/api/templates/official/rust/build", { method: "POST" });
    expect(unknown.status).toBe(400);
    const missing = await current().api("/api/templates/official/minimal/build?host=nowhere", { method: "POST" });
    expect(missing.status).toBe(404);
    expect(current().app.tasks.list({ limit: 10 })).toEqual([]);
  });

  test("a token may not build an official template, even on a host it is granted", async () => {
    await boot();
    const token = mint(current().app, {
      name: "operator",
      preset: "operator",
      hosts: { type: "list", ids: ["small"] },
    });
    const res = await fetch(`${current().base}/api/templates/official/minimal/build?host=small`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.secret}` },
    });
    expect(res.status).toBe(403);
    expect(current().engines.small.builds).toEqual([]);
  });
});

describe("a box created from an official template builds it where it has to", () => {
  test("a create on a host without the template builds it there, as a task the create waits for, and the box starts from it", async () => {
    await boot();
    const res = await createOn("small", "alpha", PYTHON);
    expect(res.status).toBe(201);
    const { box, sync } = (await res.json()) as { box: { hostId?: string }; sync?: { taskId: string } };
    expect(box.hostId).toBe("small");
    expect(current().app.tasks.get(sync?.taskId ?? "", { output: false })).toMatchObject({
      op: "template.official.build",
      status: "succeeded",
      hostId: "small",
    });
    expect(current().engines.small.callsTo("createContainer")[0]?.args[0]).toMatchObject({ image: PYTHON });
  });

  test("a second create on that host starts from the built image and builds nothing", async () => {
    await boot();
    expect((await createOn("small", "alpha", PYTHON)).status).toBe(201);

    const second = await createOn("small", "beta", PYTHON);
    expect(second.status).toBe(201);
    expect(((await second.json()) as { sync?: unknown }).sync).toBeUndefined();
    expect(current().engines.small.builds).toHaveLength(1);
  });

  test("two creates that need the same build share one build, and both boxes are made", async () => {
    await boot();
    const engine = current().engines.small;
    const gate = engine.hold("buildImage");
    const first = createOn("small", "alpha", PYTHON);
    await waitFor(() => engine.callsTo("buildImage").length === 1, "the build to start");
    const inspected = engine.callsTo("inspectImage").length;
    const second = createOn("small", "beta", PYTHON);
    await waitFor(
      () => engine.callsTo("inspectImage").length > inspected,
      "the second create to look for the template",
    );
    await Bun.sleep(20);
    gate.release();

    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const [bodyA, bodyB] = [
      (await a.json()) as { sync?: { taskId: string } },
      (await b.json()) as { sync?: { taskId: string } },
    ];
    expect(bodyA.sync?.taskId).toBeString();
    expect(bodyB.sync?.taskId).toBe(bodyA.sync?.taskId);
    expect(engine.builds).toHaveLength(1);
    expect(engine.callsTo("createContainer")).toHaveLength(2);
  });

  test("a build that fails fails the create with the build's error, and leaves no box and no template", async () => {
    await boot();
    const engine = current().engines.small;
    engine.fail("buildImage", new RuntimeError("engine", "build step 2 failed"));

    const res = await createOn("small", "alpha", PYTHON);
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ key: "docker_error" });
    expect(current().app.tasks.list({ limit: 10 })).toContainEqual(
      expect.objectContaining({ op: "template.official.build", status: "failed" }),
    );
    expect(current().app.hosts.get("small").specs.list()).toEqual([]);
    expect(engine.callsTo("createContainer")).toHaveLength(0);
    expect(await listedOn("small")).not.toContainEqual(expect.objectContaining({ ref: PYTHON }));
  });

  test("a copy from another host is preferred to a build, and the copy keeps the official kind", async () => {
    await boot();
    await buildOfficial("large", "go");

    const res = await createOn("small", "alpha", GO);
    expect(res.status).toBe(201);
    const { sync } = (await res.json()) as { sync?: { taskId: string } };
    expect(current().app.tasks.get(sync?.taskId ?? "", { output: false })).toMatchObject({
      op: "template.sync",
      status: "succeeded",
    });
    expect(current().engines.small.builds).toEqual([]);
    expect(await listedOn("small")).toContainEqual(expect.objectContaining({ ref: GO, buildKind: "official" }));
  });

  test("a token's create is refused when no host holds the official template, and nothing is built", async () => {
    await boot();
    const token = mint(current().app, {
      name: "operator",
      preset: "operator",
      hosts: { type: "list", ids: ["small"] },
    });
    const res = await fetch(`${current().base}/api/boxes`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "alpha", cpus: 1, memoryMb: 256, host: "small", template: PYTHON, mounts: [] }),
    });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ key: "template_out_of_scope" });
    expect(current().engines.small.builds).toEqual([]);
  });

  test("a template of the same name built from a Dockerfile is the one a box uses, and the official build is refused", async () => {
    await boot();
    const started = await current().post("/api/templates", {
      name: "python",
      source: { kind: "dockerfile", text: "FROM alpine:3.20\nRUN true\n" },
      host: "small",
    });
    expect(started.status).toBe(202);
    await current().app.tasks.drain();

    const res = await createOn("small", "alpha", PYTHON);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { sync?: unknown }).sync).toBeUndefined();
    expect(current().engines.small.builds).toHaveLength(1);

    const refused = await current().api("/api/templates/official/python/build?host=small", { method: "POST" });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toMatchObject({ key: "template_name_taken" });
  });
});

describe("auto places a box where an official template is built or already held", () => {
  test("with no host holding the template, auto picks the roomiest host, which builds it", async () => {
    await boot([]);
    current().app.hosts.get().host.status = "offline";

    const placed = await boxOn("auto", "alpha", { template: PYTHON });
    expect(placed.hostId).toBe("large");
    expect(current().engines.large.builds).toHaveLength(1);
    expect(current().engines.small.builds).toEqual([]);
  });

  test("a holder with room wins over a roomier host that would have to build", async () => {
    await boot([]);
    current().app.hosts.get().host.status = "offline";
    await buildOfficial("small", "python");

    const placed = await boxOn("auto", "alpha", { template: PYTHON });
    expect(placed.hostId).toBe("small");
    expect(current().engines.large.builds).toEqual([]);
  });

  test("a holder without room for the box gives way to the roomiest other host, which takes a copy rather than a build", async () => {
    await boot(["small"]);
    current().app.hosts.get().host.status = "offline";
    await buildOfficial("small", "python");
    await boxOn("small", "filler", { cpus: 2 });

    const placed = await boxOn("auto", "alpha", { template: PYTHON });
    expect(placed.hostId).toBe("large");
    expect(current().engines.large.builds).toEqual([]);
    expect(await listedOn("large")).toContainEqual(expect.objectContaining({ ref: PYTHON, buildKind: "official" }));
  });
});

describe("rebuilding an official template", () => {
  test("keeps the template official and builds it again from the Dockerfile that ships", async () => {
    await boot();
    await buildOfficial("small", "node");

    const res = await current().api("/api/templates/mbtest-template%3Anode/rebuild?host=small", { method: "POST" });
    expect(res.status).toBe(202);
    await current().app.tasks.drain();

    expect(current().app.tasks.list({ limit: 10 })).toContainEqual(
      expect.objectContaining({ op: "template.rebuild", status: "succeeded" }),
    );
    const [, rebuilt] = current().engines.small.builds;
    expect(rebuilt?.files.get("Dockerfile")).toBe(shipped("node"));
    expect(await listedOn("small")).toContainEqual(
      expect.objectContaining({ ref: "mbtest-template:node", buildKind: "official" }),
    );
  });
});
