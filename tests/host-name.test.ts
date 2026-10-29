import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../src/app";
import { hostsPath } from "../src/data-dir";
import { HostStore, type StoredHost } from "../src/host/store";
import { AppError } from "../src/lib/errors";
import { createTestApp, silenceLogs } from "./support/app";

const apps: App[] = [];
const dirs: string[] = [];
let restoreLogs: () => void;

function boot(dataDir?: string): App {
  restoreLogs ??= silenceLogs();
  const { app } = createTestApp(dataDir === undefined ? {} : { dataDir });
  apps.push(app);
  return app;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "minibox-host-name-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const app of apps.splice(0)) {
    app.hostAdmin.close();
    app.throttle.stop();
    app.sessions.stop();
    app.tokens.stop();
    app.events.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The error a call was refused with, or a failure when it was not refused at all. */
async function refusalOf(call: Promise<unknown>): Promise<AppError> {
  try {
    await call;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("the call was not refused");
}

describe("a host's display name is unique", () => {
  test("adding a host under a name another host holds is a conflict that names the holder", async () => {
    const app = boot();
    await app.hostAdmin.add({ id: "lab", endpoint: "unix:///run/lab.sock", name: "Lab" });
    const error = await refusalOf(app.hostAdmin.add({ id: "edge", endpoint: "unix:///run/edge.sock", name: "Lab" }));
    expect(error.status).toBe(409);
    expect(error.key).toBe("host_name_taken");
    expect(error.params).toEqual({ name: "Lab", host: "lab" });
    expect(error.message).toContain("“lab”");
    // Nothing was written: no record, no registered host, and no name for a later add to trip over.
    expect(app.hosts.list().map((ctx) => ctx.host.id)).toEqual(["local", "lab"]);
    expect(app.hostAdmin.list().map((host) => host.id)).toEqual(["local", "lab"]);
  });

  test("a name is compared trimmed and without its case, so Lab, lab and “ Lab ” are one name", async () => {
    const app = boot();
    await app.hostAdmin.add({ id: "lab", endpoint: "unix:///run/lab.sock", name: "Lab" });
    for (const name of ["lab", " LAB ", "  Lab  "]) {
      const error = await refusalOf(app.hostAdmin.add({ id: "edge", endpoint: "unix:///run/edge.sock", name }));
      expect([name, error.key]).toEqual([name, "host_name_taken"]);
    }
  });

  test("a name the local host holds is taken too, since the console lists it beside the others", async () => {
    const app = boot();
    expect(app.hosts.get().host.name).toBe("Local");
    const error = await refusalOf(app.hostAdmin.add({ id: "edge", endpoint: "unix:///run/edge.sock", name: "Local" }));
    expect(error.params).toEqual({ name: "Local", host: "local" });
  });

  test("the store itself never refuses a file, so the rule cannot stop a control plane from booting", () => {
    const dir = tempDir();
    const created = "2026-10-22T00:00:00.000Z";
    const hosts: StoredHost[] = [
      { id: "lab", name: "Lab", endpoint: "unix:///run/lab.sock", hostKeyFingerprint: null, createdAt: created },
      { id: "edge", name: "lab", endpoint: "unix:///run/edge.sock", hostKeyFingerprint: null, createdAt: created },
    ];
    writeFileSync(hostsPath(dir), `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`);
    expect(new HostStore(dir).load()).toEqual(hosts);
  });

  test("a host added without a name falls back to its id, and that fallback is checked like any other name", async () => {
    const app = boot();
    // `lab` becomes the name of the first host by its own id, so a second host whose id is `lab` is refused by the id,
    // and one that asks for the name `lab` is refused by the name.
    await app.hostAdmin.add({ id: "lab", endpoint: "unix:///run/lab.sock" });
    expect(app.hostAdmin.list().find((host) => host.id === "lab")?.name).toBe("lab");
    const error = await refusalOf(app.hostAdmin.add({ id: "edge", endpoint: "unix:///run/edge.sock", name: "lab" }));
    expect(error.key).toBe("host_name_taken");

    // A host whose id another host already uses as its name is refused, and the same fallback is what refuses it.
    const other = boot();
    await other.hostAdmin.add({ id: "box", endpoint: "unix:///run/box.sock", name: "box-two" });
    await other.hostAdmin.add({ id: "second", endpoint: "unix:///run/second.sock", name: "second-two" });
    // A name equal to another host's id is allowed: ids identify a host, names only label it.
    await other.hostAdmin.add({ id: "third", endpoint: "unix:///run/third.sock", name: "box" });
    expect(other.hostAdmin.list().map((host) => host.name)).toContain("box");
  });

  test("the local host keeps its name, and the first host added under a free name takes it", async () => {
    const app = boot();
    await app.hostAdmin.add({ id: "edge", endpoint: "unix:///run/edge.sock", name: "Edge" });
    const again = await refusalOf(app.hostAdmin.add({ id: "edge2", endpoint: "unix:///run/edge2.sock", name: "edge" }));
    expect(again.params).toEqual({ name: "edge", host: "edge" });
  });
});

describe("a pairing code carries a unique name", () => {
  test("creating a code under a taken name is refused before any code is handed out", async () => {
    const app = boot();
    await app.hostAdmin.add({ id: "lab", endpoint: "unix:///run/lab.sock", name: "Lab" });
    const error = await refusalOf(app.hostAdmin.createPairing({ id: "edge", name: "Lab" }));
    expect(error.status).toBe(409);
    expect(error.key).toBe("host_name_taken");
    expect(error.params).toEqual({ name: "Lab", host: "lab" });
  });

  test("a code created without a name falls back to the id, and a free fallback is accepted", async () => {
    const app = boot();
    await app.hostAdmin.add({ id: "lab", endpoint: "unix:///run/lab.sock", name: "Lab" });
    const pairing = await app.hostAdmin.createPairing({ id: "edge" });
    expect(pairing.name).toBe("edge");
  });

  test("a name a waiting pairing code holds cannot be taken by another add or code", async () => {
    const app = boot();
    const waiting = await app.hostAdmin.createPairing({ id: "edge", name: "Edge lab" });
    const error = await refusalOf(app.hostAdmin.createPairing({ id: "edge2", name: "edge lab" }));
    expect(error.status).toBe(409);
    expect(error.key).toBe("host_name_pending");
    expect(error.params).toEqual({ name: "edge lab" });
    // The same code still pairs: nothing about the refused second code touched the first.
    expect(waiting.name).toBe("Edge lab");
    const added = await refusalOf(
      app.hostAdmin.add({ id: "other", endpoint: "unix:///run/other.sock", name: "EDGE LAB" }),
    );
    expect(added.key).toBe("host_name_pending");
  });
});

describe("a hosts file that already holds duplicate names still loads", () => {
  test("it loads, lists both hosts, and the duplicates stay distinguishable by their ids", () => {
    const dir = tempDir();
    const created = "2026-10-22T00:00:00.000Z";
    const hosts: StoredHost[] = [
      { id: "lab", name: "Lab", endpoint: "unix:///run/lab.sock", hostKeyFingerprint: null, createdAt: created },
      { id: "edge", name: "Lab", endpoint: "unix:///run/edge.sock", hostKeyFingerprint: null, createdAt: created },
    ];
    writeFileSync(hostsPath(dir), `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`);
    // The store keeps the rule out of loading: a name is checked where a person gives one, never when a file is read.
    expect(new HostStore(dir).load()).toEqual(hosts);

    const app = boot(dir);
    const listed = app.hostAdmin.list();
    expect(listed.map((host) => [host.id, host.name])).toEqual([
      ["local", "Local"],
      ["lab", "Lab"],
      ["edge", "Lab"],
    ]);
    // Every listing names the host by its id beside its name, so two hosts of one name never look identical.
    expect(new Set(listed.map((host) => host.id)).size).toBe(listed.length);
  });

  test("a host added later under a name the file already repeats is still refused", async () => {
    const dir = tempDir();
    const created = "2026-10-22T00:00:00.000Z";
    const hosts: StoredHost[] = [
      { id: "lab", name: "Lab", endpoint: "unix:///run/lab.sock", hostKeyFingerprint: null, createdAt: created },
      { id: "edge", name: "Lab", endpoint: "unix:///run/edge.sock", hostKeyFingerprint: null, createdAt: created },
    ];
    writeFileSync(hostsPath(dir), `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`);
    const app = boot(dir);
    const error = await refusalOf(app.hostAdmin.add({ id: "third", endpoint: "unix:///run/third.sock", name: "Lab" }));
    expect(error.key).toBe("host_name_taken");
    expect(error.params).toEqual({ name: "Lab", host: "lab" });
  });
});
