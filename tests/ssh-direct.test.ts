import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Client, type ConnectConfig, utils } from "ssh2";

import type { App } from "../src/app";
import type { AuditEvent } from "../src/operations/executor";
import { directSshView } from "../src/routes/ssh";
import { startDirectSsh, startServer } from "../src/server";
import { getBox, stopBox } from "../src/services/boxes";
import { DirectSshServer } from "../src/ssh/direct";
import { SshLoginLimiter } from "../src/ssh/limits";
import { createTestApp, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { ed25519Pair, runCommand } from "./support/ssh";
import { call, mint } from "./support/tokens";

const STRONG_KEY = "Direct-SSH-access-key-0123456789";

let app: App;
let runtime: FakeRuntime;
let server: ReturnType<typeof startServer>;
let direct: DirectSshServer;
let limiter: SshLoginLimiter;
let base: string;
let sshPort: number;
let audits: AuditEvent[];
let restoreLogs: () => void;
const clients: Client[] = [];

beforeEach(async () => {
  restoreLogs = silenceLogs();
  audits = [];
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest", accessKey: STRONG_KEY }, undefined, {
    audit: (event) => audits.push(event),
  }));
  runtime.seedImage(app.cfg.baseTemplateTag, { [app.hosts.get().keys.template]: "true" });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
  limiter = new SshLoginLimiter();
  direct = new DirectSshServer({
    gateway: app.ssh,
    hosts: app.hosts,
    keys: app.sshKeys,
    tokens: app.tokens,
    accessKey: app.cfg.accessKey,
    record: app.record,
    limiter,
    failDelayMs: 1,
  });
  sshPort = await direct.listen("127.0.0.1", 0);
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.end();
  await direct.close();
  app.sessions.stop();
  app.tokens.stop();
  app.throttle.stop();
  server.stop(true);
  restoreLogs();
});

async function makeBox(name: string): Promise<{ id: string; boxId: string; name: string }> {
  const res = await call(base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256 }, token: STRONG_KEY });
  expect(res.status).toBe(201);
  const box = res.json.box;
  if (!box) throw new Error("the box was not created");
  return box;
}

/** A plain TCP SSH login, as Termius or OpenSSH makes one. Rejects with the client's error when it is refused. */
function connect(config: Partial<ConnectConfig>, keyboardAnswer?: string): Promise<Client> {
  const client = new Client();
  clients.push(client);
  if (keyboardAnswer !== undefined) {
    client.on("keyboard-interactive", (_name, _instructions, _lang, _prompts, finish) => finish([keyboardAnswer]));
  }
  return new Promise((resolve, reject) => {
    client.on("ready", () => resolve(client));
    client.on("error", reject);
    client.on("close", () => reject(new Error("closed before ready")));
    client.connect({
      host: "127.0.0.1",
      port: sshPort,
      hostVerifier: () => true,
      readyTimeout: 5000,
      tryKeyboard: false,
      ...config,
    });
  });
}

const denied = () => audits.filter((event) => event.op === "ssh.connect" && event.status === "denied");
const detailOf = (event: AuditEvent) => event.detail as Record<string, unknown>;

describe("direct SSH login", () => {
  test("an agent token with box:ssh as the password runs a command in the box named by the user", async () => {
    const box = await makeBox("alpha");
    runtime.execScript = { stdout: "hi\n", stderr: "", code: 0 };
    const token = mint(app, { name: "phone", scopes: ["box:ssh"], boxes: { type: "all" } });
    const client = await connect({ username: box.name, password: token.secret });
    expect(await runCommand(client, "echo hi")).toEqual({ stdout: "hi\n", stderr: "", code: 0 });
    expect(runtime.execs.at(-1)?.spec.user).toBe("dev");
    const ok = audits.find((event) => event.op === "ssh.connect" && event.status === "ok");
    expect(ok?.source).toBe("ssh");
    expect(ok?.principal.type).toBe("token");
    expect(detailOf(ok as AuditEvent)).toMatchObject({ transport: "direct", method: "password", credential: "token" });
    expect(JSON.stringify(audits)).not.toContain(token.secret);
  });

  test("the box id works as the user, and keyboard-interactive carries the password too", async () => {
    const box = await makeBox("bravo");
    const token = mint(app, { name: "kbd", scopes: ["box:ssh"], boxes: { type: "all" } });
    const client = await connect({ username: box.boxId, tryKeyboard: true }, token.secret);
    expect((await runCommand(client, "true")).code).toBe(0);
    const ok = audits.find((event) => event.op === "ssh.connect" && event.status === "ok");
    expect(detailOf(ok as AuditEvent)).toMatchObject({ method: "keyboard-interactive", credential: "token" });
  });

  test("an owner key logs in with its signature, and the key's last use is recorded", async () => {
    const box = await makeBox("charlie");
    const pair = ed25519Pair("laptop");
    const added = app.sshKeys.add(pair.public);
    const client = await connect({ username: box.name, privateKey: pair.private });
    expect((await runCommand(client, "true")).code).toBe(0);
    const ok = audits.find((event) => event.op === "ssh.connect" && event.status === "ok");
    expect(ok?.principal.type).toBe("owner");
    expect(detailOf(ok as AuditEvent)).toMatchObject({
      method: "publickey",
      credential: "key",
      fingerprint: added.fingerprint,
    });
    expect(app.sshKeys.list()[0]?.lastUsedAt).not.toBeNull();
  });

  test("an RSA key signs with rsa-sha2", async () => {
    const box = await makeBox("rsa");
    const pair = utils.generateKeyPairSync("rsa", { bits: 2048 });
    app.sshKeys.add(pair.public, "rsa");
    const client = await connect({ username: box.name, privateKey: pair.private });
    expect((await runCommand(client, "true")).code).toBe(0);
  });

  test("an unregistered key, a wrong password and an unknown box are refused alike", async () => {
    const box = await makeBox("delta");
    const stranger = ed25519Pair();
    await expect(connect({ username: box.name, privateKey: stranger.private })).rejects.toThrow();
    await expect(connect({ username: box.name, password: "wrong-password" })).rejects.toThrow();
    await expect(connect({ username: "nobody", password: STRONG_KEY })).rejects.toThrow();
    const reasons = denied().map((event) => detailOf(event).reason);
    expect(reasons).toEqual(["bad_credential", "unknown_box"]);
    expect(denied()[1]?.principal.type).toBe("owner");
    expect(JSON.stringify(audits)).not.toContain("wrong-password");
  });

  test("the access key is a password only when it is strong", async () => {
    const box = await makeBox("echo");
    const client = await connect({ username: box.name, password: STRONG_KEY });
    expect((await runCommand(client, "true")).code).toBe(0);
  });

  test("a token without box:ssh, or limited to other boxes, is refused", async () => {
    const box = await makeBox("foxtrot");
    const other = await makeBox("golf");
    const readonly = mint(app, { name: "ro", preset: "readonly", boxes: { type: "all" } });
    await expect(connect({ username: box.name, password: readonly.secret })).rejects.toThrow();
    const elsewhere = mint(app, { name: "elsewhere", scopes: ["box:ssh"], boxes: { type: "ids", ids: [other.boxId] } });
    await expect(connect({ username: box.name, password: elsewhere.secret })).rejects.toThrow();
    const client = await connect({ username: other.name, password: elsewhere.secret });
    client.end();
    const reasons = denied().map((event) => detailOf(event).reason);
    expect(reasons).toEqual(["bad_credential", "forbidden"]);
  });

  test("a stopped box starts on connect", async () => {
    const box = await makeBox("hotel");
    await stopBox(app.hosts.get(), box.boxId, "idle");
    expect((await getBox(app.hosts.get(), box.boxId)).running).toBe(false);
    await connect({ username: box.name, password: STRONG_KEY });
    expect((await getBox(app.hosts.get(), box.boxId)).running).toBe(true);
  });

  test("revoking the token ends its connection", async () => {
    const box = await makeBox("india");
    const token = mint(app, { name: "revoked", scopes: ["box:ssh"], boxes: { type: "all" } });
    const client = await connect({ username: box.name, password: token.secret });
    const closed = new Promise<void>((resolve) => client.on("close", () => resolve()));
    app.tokens.revoke(token.id);
    await closed;
  });

  test("repeated failures lock the address out, and a good password is then refused too", async () => {
    const box = await makeBox("juliet");
    for (let i = 0; i < 6; i++) {
      await expect(connect({ username: box.name, password: `wrong-${i}` })).rejects.toThrow();
    }
    expect(limiter.lockedFor("127.0.0.1")).toBeGreaterThan(0);
    await expect(connect({ username: box.name, password: STRONG_KEY })).rejects.toThrow();
    expect(denied().at(-1) && detailOf(denied().at(-1) as AuditEvent).reason).toBe("locked_out");
  });
});

describe("direct SSH settings", () => {
  test("the host key route names the direct port only while it listens", async () => {
    expect(directSshView(app)).toBeNull();
    const other = createTestApp({ labelPrefix: "mbtest2", sshPort: 0, sshPublicHost: "box.example.com" }).app;
    const port = await startDirectSsh(other);
    try {
      expect(port).toBeGreaterThan(0);
      expect(directSshView(other)).toEqual({ host: "box.example.com", port: port ?? 0 });
    } finally {
      await other.sshDirect?.close();
      other.sessions.stop();
      other.tokens.stop();
      other.throttle.stop();
    }
  });

  test("SSH keys are managed by the owner over REST, and a token cannot list them", async () => {
    const pair = ed25519Pair("me@laptop");
    const added = await call(base, "/api/ssh-keys", { body: { publicKey: pair.public }, token: STRONG_KEY });
    expect(added.status).toBe(200);
    const listed = await call(base, "/api/ssh-keys", { token: STRONG_KEY });
    const keys = (listed.json as unknown as { keys: { id: string; label: string }[] }).keys;
    expect(keys.map((key) => key.label)).toEqual(["me@laptop"]);
    const agent = mint(app, { name: "agent", preset: "operator", boxes: { type: "all" } });
    expect((await call(base, "/api/ssh-keys", { token: agent.secret })).status).toBe(403);
    const removed = await call(base, `/api/ssh-keys/${keys[0]?.id}`, { method: "DELETE", token: STRONG_KEY });
    expect(removed.status).toBe(200);
    expect(app.sshKeys.size).toBe(0);
  });
});
