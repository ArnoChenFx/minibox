import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { utils } from "ssh2";

import { sshKeysPath } from "../src/data-dir";
import { AppError } from "../src/lib/errors";
import { boxRefOfUser, identify } from "../src/ssh/direct-auth";
import { parsePublicKey, SSH_KEYS_MAX, SshKeyStore } from "../src/ssh/keys";
import {
  SSH_FAILURES_FREE,
  SSH_LOCKOUT_BASE_MS,
  SSH_LOCKOUT_MAX_MS,
  SSH_PENDING_PER_IP_MAX,
  SshLoginLimiter,
} from "../src/ssh/limits";
import { compileToken } from "../src/tokens/model";
import { TokenStore } from "../src/tokens/store";
import { silenceLogs } from "./support/app";
import { ed25519Pair } from "./support/ssh";

let dir: string;
let restoreLogs: () => void;
beforeEach(() => {
  restoreLogs = silenceLogs();
  dir = mkdtempSync(join(tmpdir(), "mb-sshkeys-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  restoreLogs();
});

const statusOf = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.status : -1;
  }
  return 0;
};

describe("public key parsing", () => {
  test("reads an authorized_keys line and names it by its comment", () => {
    const pair = ed25519Pair("me@laptop");
    const parsed = parsePublicKey(`  ${pair.public}\n`);
    expect(parsed.algorithm).toBe("ssh-ed25519");
    expect(parsed.comment).toBe("me@laptop");
    expect(parsed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(parsed.publicKey).not.toContain("me@laptop");
  });
  test("refuses a private key, two keys at once, junk and an unsupported type", () => {
    const pair = ed25519Pair();
    const other = utils.generateKeyPairSync("ecdsa", { bits: 256 });
    expect(statusOf(() => parsePublicKey(pair.private))).toBe(400);
    expect(statusOf(() => parsePublicKey(`${pair.public}\n${other.public}`))).toBe(400);
    expect(statusOf(() => parsePublicKey("ssh-ed25519 not-base64!"))).toBe(400);
    expect(statusOf(() => parsePublicKey(""))).toBe(400);
    expect(statusOf(() => parsePublicKey("ssh-dss AAAAB3NzaC1kc3MAAACBAP"))).toBe(400);
    expect(statusOf(() => parsePublicKey(other.public))).toBe(0);
  });
});

describe("SSH key store", () => {
  test("keeps keys in a 600 file across restarts, refuses duplicates, and removes by id", () => {
    const store = new SshKeyStore(dir);
    const pair = ed25519Pair("phone");
    const key = store.add(pair.public);
    expect(key).toMatchObject({ label: "phone", algorithm: "ssh-ed25519", lastUsedAt: null });
    expect(key.id).toMatch(/^sk_[0-9a-f]{16}$/);
    expect(statSync(sshKeysPath(dir)).mode & 0o777).toBe(0o600);
    expect(statusOf(() => store.add(pair.public, "again"))).toBe(409);
    const reloaded = new SshKeyStore(dir);
    expect(reloaded.list().map((k) => k.fingerprint)).toEqual([key.fingerprint]);
    reloaded.remove(key.id);
    expect(statusOf(() => reloaded.remove(key.id))).toBe(404);
    expect(JSON.parse(readFileSync(sshKeysPath(dir), "utf8"))).toEqual({ keys: [] });
  });
  test(`holds at most ${SSH_KEYS_MAX} keys`, () => {
    const store = new SshKeyStore(dir);
    for (let i = 0; i < SSH_KEYS_MAX; i++) store.add(ed25519Pair().public);
    expect(statusOf(() => store.add(ed25519Pair().public))).toBe(409);
  });
  test("a signature verifies only with the registered key, and last use is written at most once a minute", () => {
    let now = 1_000_000;
    const store = new SshKeyStore(dir, () => now);
    const pair = ed25519Pair();
    const key = store.add(pair.public);
    const priv = utils.parseKey(pair.private);
    if (priv instanceof Error || Array.isArray(priv)) throw new Error("bad key");
    const data = Buffer.from("session data");
    const signature = priv.sign(data);
    const blob = priv.getPublicSSH();
    expect(store.verify("ssh-ed25519", blob, data, signature)?.id).toBe(key.id);
    expect(store.verify("ssh-ed25519", blob, Buffer.from("other"), signature)).toBeNull();
    expect(store.verify("ssh-rsa", blob, data, signature)).toBeNull();
    store.touch(key.id);
    now += 10_000;
    store.touch(key.id);
    expect(store.list()[0]?.lastUsedAt).toBe(now);
    expect(new SshKeyStore(dir).list()[0]?.lastUsedAt).toBe(1_000_000);
  });
});

describe("login limiter", () => {
  test("the first failures are free, then each one doubles the lockout up to an hour; a success clears it", () => {
    let now = 0;
    const limiter = new SshLoginLimiter(() => now);
    for (let i = 0; i < SSH_FAILURES_FREE; i++) expect(limiter.fail("203.0.113.9")).toBe(0);
    expect(limiter.fail("203.0.113.9")).toBe(SSH_LOCKOUT_BASE_MS);
    expect(limiter.fail("203.0.113.9")).toBe(SSH_LOCKOUT_BASE_MS * 2);
    for (let i = 0; i < 20; i++) limiter.fail("203.0.113.9");
    expect(limiter.lockedFor("203.0.113.9")).toBe(SSH_LOCKOUT_MAX_MS);
    expect(limiter.lockedFor("203.0.113.10")).toBe(0);
    now += SSH_LOCKOUT_MAX_MS;
    expect(limiter.lockedFor("203.0.113.9")).toBe(0);
    limiter.succeed("203.0.113.9");
    expect(limiter.fail("203.0.113.9")).toBe(0);
  });
  test("IPv6 addresses in one /64 share a count", () => {
    const limiter = new SshLoginLimiter();
    for (let i = 0; i <= SSH_FAILURES_FREE; i++) limiter.fail(`2001:db8::${i + 1}`);
    expect(limiter.lockedFor("2001:db8::ffff")).toBeGreaterThan(0);
  });
  test("caps the handshakes one address holds, and a release is counted once", () => {
    const limiter = new SshLoginLimiter();
    const releases = Array.from({ length: SSH_PENDING_PER_IP_MAX }, () => limiter.admit("198.51.100.1"));
    expect(releases.every(Boolean)).toBe(true);
    expect(limiter.admit("198.51.100.1")).toBeNull();
    expect(limiter.admit("198.51.100.2")).not.toBeNull();
    releases[0]?.();
    releases[0]?.();
    expect(limiter.pendingCount).toBe(SSH_PENDING_PER_IP_MAX);
    expect(limiter.admit("198.51.100.1")).not.toBeNull();
  });
});

function tokens(): TokenStore {
  return new TokenStore({ file: join(dir, "tokens.json") });
}

describe("direct login policy", () => {
  const STRONG = "Direct-SSH-access-key-0123456789";

  test("the user is a box name or id, nothing else", () => {
    expect(boxRefOfUser("my-box")).toBe("my-box");
    expect(boxRefOfUser("mb_0123abcd")).toBe("mb_0123abcd");
    expect(boxRefOfUser("../etc")).toBeNull();
    expect(boxRefOfUser("")).toBeNull();
    expect(boxRefOfUser("a".repeat(65))).toBeNull();
  });
  test("a strong access key is the owner, a weak one is never accepted", () => {
    const keys = new SshKeyStore(dir);
    const store = tokens();
    const owner = identify({ accessKey: STRONG, tokens: store, keys }, { method: "password", password: STRONG }, "::1");
    expect(owner).toMatchObject({ principal: { type: "owner" }, credential: "access-key" });
    const weak = "k".repeat(64);
    expect(
      identify({ accessKey: weak, tokens: store, keys }, { method: "password", password: weak }, "::1"),
    ).toBeNull();
    expect(
      identify({ accessKey: STRONG, tokens: store, keys }, { method: "password", password: "" }, "::1"),
    ).toBeNull();
    store.stop();
  });
  test("a token needs box:ssh", () => {
    const keys = new SshKeyStore(dir);
    const store = tokens();
    const ssh = store.create(compileToken({ name: "ssh", scopes: ["box:ssh"], quotas: { rateLimit: null } }), "owner");
    const ro = store.create(compileToken({ name: "ro", preset: "readonly", quotas: { rateLimit: null } }), "owner");
    const deps = { accessKey: STRONG, tokens: store, keys };
    expect(identify(deps, { method: "password", password: ssh.secret }, "::1")).toMatchObject({
      principal: { type: "token", id: ssh.record.id },
      credential: "token",
    });
    expect(identify(deps, { method: "keyboard-interactive", password: ro.secret }, "::1")).toBeNull();
    store.stop();
  });
});
