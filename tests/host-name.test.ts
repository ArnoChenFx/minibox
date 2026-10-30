import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeyPairPem } from "../src/agent/identity";
import { AGENT_PROTOCOL } from "../src/agent/protocol";
import type { App } from "../src/app";
import { hostsPath } from "../src/data-dir";
import { labelOf } from "../src/host/label";
import { HostStore, type StoredHost } from "../src/host/store";
import { AppError } from "../src/lib/errors";
import { createTestApp, silenceLogs } from "./support/app";
import { newKeyPair } from "./support/engines";

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

/** Pairs an agent with `code`, as the agent's first call does. */
function pairWith(app: App, code: string) {
  return app.hostAdmin.pairAgent({
    code,
    publicKey: generateKeyPairPem().publicKeyPem,
    version: "0.4.0",
    protocol: AGENT_PROTOCOL,
  });
}

/** A TCP port that counts the connections made to it and answers none, standing in for an SSH host. */
async function countingPort(): Promise<{ port: number; dials: () => number; close: () => void }> {
  let dials = 0;
  const server: Server = createServer((socket) => {
    dials += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, dials: () => dials, close: () => server.close() };
}

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

    // A host whose id another host already uses as its name is refused when it has no name of its own; the next test
    // covers that. A name equal to another host's id is fine.
    const other = boot();
    await other.hostAdmin.add({ id: "box", endpoint: "unix:///run/box.sock", name: "box-two" });
    await other.hostAdmin.add({ id: "second", endpoint: "unix:///run/second.sock", name: "second-two" });
    // A name equal to another host's id is allowed: ids identify a host, names only label it.
    await other.hostAdmin.add({ id: "third", endpoint: "unix:///run/third.sock", name: "box" });
    expect(other.hostAdmin.list().map((host) => host.name)).toContain("box");
  });

  test("a host with no name whose id another host uses as its name is told to give it a name", async () => {
    const app = boot();
    await app.hostAdmin.add({ id: "lab", endpoint: "unix:///run/lab.sock", name: "edge" });
    const error = await refusalOf(app.hostAdmin.add({ id: "edge", endpoint: "unix:///run/edge.sock" }));
    expect(error.status).toBe(409);
    expect(error.key).toBe("host_name_taken_by_id");
    expect(error.params).toEqual({ name: "edge", host: "lab" });
    expect(error.message).toContain("Give this host a name");
    const code = await refusalOf(app.hostAdmin.createPairing({ id: "edge" }));
    expect(code.key).toBe("host_name_taken_by_id");
  });

  test("a name is compared in Unicode NFC, so a combining accent and a precomposed one are one name", async () => {
    const app = boot();
    await app.hostAdmin.add({ id: "cafe", endpoint: "unix:///run/cafe.sock", name: "Cafe\u0301" });
    const error = await refusalOf(
      app.hostAdmin.add({ id: "edge", endpoint: "unix:///run/edge.sock", name: "CAF\u00c9" }),
    );
    expect(error.key).toBe("host_name_taken");
    expect(error.params).toEqual({ name: "CAF\u00c9", host: "cafe" });
  });

  test("an SSH host under a taken name is refused before the machine is dialled for its key", async () => {
    const app = boot();
    await app.hostAdmin.add({ id: "lab", endpoint: "unix:///run/lab.sock", name: "Lab" });
    const ssh = await countingPort();
    try {
      const error = await refusalOf(
        app.hostAdmin.add({
          id: "edge",
          name: "lab",
          endpoint: `ssh://minibox@127.0.0.1:${ssh.port}/var/run/docker.sock`,
          privateKey: newKeyPair().privateKey,
        }),
      );
      expect(error.key).toBe("host_name_taken");
      expect(ssh.dials()).toBe(0);
    } finally {
      ssh.close();
    }
  });

  test("a name that a host holds is refused to the next one, whatever its case, and the conflict names that host", async () => {
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
    expect(error.params).toEqual({ name: "edge lab", host: "edge" });
    const added = await refusalOf(
      app.hostAdmin.add({ id: "other", endpoint: "unix:///run/other.sock", name: "EDGE LAB" }),
    );
    expect(added.key).toBe("host_name_pending");
    // The waiting code still pairs: nothing about the refused calls touched it.
    await pairWith(app, waiting.code);
    expect(app.hostAdmin.list().find((host) => host.id === "edge")?.name).toBe("Edge lab");
  });

  test("a new code for the same host replaces the waiting one at once, and only the new code pairs", async () => {
    const app = boot();
    // An operator who lost a code asks for another under the same id and name, without waiting for the first to expire.
    const lost = await app.hostAdmin.createPairing({ id: "edge", name: "Edge" });
    const fresh = await app.hostAdmin.createPairing({ id: "edge", name: "Edge" });
    expect(fresh.code).not.toBe(lost.code);
    const stale = await refusalOf(pairWith(app, lost.code));
    expect(stale.status).toBe(401);
    expect(stale.key).toBe("agent_pairing_replaced");
    await pairWith(app, fresh.code);
    expect(app.hostAdmin.list().find((host) => host.id === "edge")?.name).toBe("Edge");
  });

  test("a new code for the same host may change the name, and the old name is free again", async () => {
    const app = boot();
    await app.hostAdmin.createPairing({ id: "edge", name: "Edge" });
    const renamed = await app.hostAdmin.createPairing({ id: "edge", name: "Edge two" });
    expect(renamed.name).toBe("Edge two");
    await app.hostAdmin.createPairing({ id: "other", name: "Edge" });
  });

  test("a waiting code does not stop its own id from being added another way", async () => {
    const app = boot();
    const waiting = await app.hostAdmin.createPairing({ id: "edge", name: "Edge" });
    await app.hostAdmin.add({ id: "edge", endpoint: "unix:///run/edge.sock", name: "Edge" });
    // The code now names a host that exists, so it pairs nothing.
    const error = await refusalOf(pairWith(app, waiting.code));
    expect(error.key).toBe("host_exists");
  });

  test("the name a code carried is free again once that code's host is added another way", async () => {
    const app = boot();
    await app.hostAdmin.createPairing({ id: "edge", name: "Waiting name" });
    // While the code can still pair, it holds the name against everybody else.
    expect((await refusalOf(app.hostAdmin.createPairing({ id: "other", name: "waiting name" }))).key).toBe(
      "host_name_pending",
    );
    await app.hostAdmin.add({ id: "edge", endpoint: "unix:///run/edge.sock", name: "Edge" });
    // The host exists under another name, so the code is dead and keeps nothing: the name can be taken, by a new code
    // and by a host alike.
    await app.hostAdmin.createPairing({ id: "other", name: "waiting name" });
    await app.hostAdmin.add({ id: "third", endpoint: "unix:///run/third.sock", name: "Third" });
    const taken = await refusalOf(
      app.hostAdmin.add({ id: "fourth", endpoint: "unix:///run/fourth.sock", name: "Waiting Name" }),
    );
    // The new code for `other` holds it now, which is the rule working as it should.
    expect(taken.key).toBe("host_name_pending");
    expect(taken.params).toEqual({ name: "Waiting Name", host: "other" });
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
  });

  test("names that differ only by case, or by the space around them in the file, count as one name, as they do when a host is added", () => {
    const dir = tempDir();
    const created = "2026-10-22T00:00:00.000Z";
    const hosts: StoredHost[] = [
      { id: "lab", name: "Lab", endpoint: "unix:///run/lab.sock", hostKeyFingerprint: null, createdAt: created },
      { id: "edge", name: " lab ", endpoint: "unix:///run/edge.sock", hostKeyFingerprint: null, createdAt: created },
    ];
    writeFileSync(hostsPath(dir), `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`);
    const app = boot(dir);
    expect(labelOf(app.hosts.get("lab").host)).toBe("Lab · lab");
    // The registered name has lost the space around it, and still compares equal to the other's.
    expect(labelOf(app.hosts.get("edge").host)).toBe("lab · edge");
  });

  test("a message about one of them quotes its name with its id, and a unique name alone", async () => {
    const dir = tempDir();
    const created = "2026-10-22T00:00:00.000Z";
    const hosts: StoredHost[] = [
      { id: "lab", name: "Lab", endpoint: "unix:///run/lab.sock", hostKeyFingerprint: null, createdAt: created },
      { id: "edge", name: "Lab", endpoint: "unix:///run/edge.sock", hostKeyFingerprint: null, createdAt: created },
    ];
    writeFileSync(hostsPath(dir), `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`);
    const app = boot(dir);
    expect(labelOf(app.hosts.get("lab").host)).toBe("Lab · lab");
    expect(labelOf(app.hosts.get("edge").host)).toBe("Lab · edge");
    expect(labelOf(app.hosts.get().host)).toBe("Local");
    // Once one of the pair is gone, the other's name is unique again and is quoted alone, and so is the one that went.
    const edge = app.hosts.get("edge").host;
    await app.hostAdmin.remove("edge");
    expect(labelOf(app.hosts.get("lab").host)).toBe("Lab");
    expect(labelOf(edge)).toBe("Lab");
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
