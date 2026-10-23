import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { SecretStore } from "../src/secrets/store";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";

const PASSPHRASE = "correct horse battery staple";
const UNUSED_PORT = "http://127.0.0.1:9";

interface Io {
  out: string;
  err: string;
  stdout(text: string): void;
  stderr(text: string): void;
  stdoutBytes(bytes: Uint8Array): void;
  stdinBytes(): AsyncIterable<Uint8Array>;
}

function io(stdin = ""): Io {
  const sink: Io = {
    out: "",
    err: "",
    stdout(text) {
      sink.out += text;
    },
    stderr(text) {
      sink.err += text;
    },
    stdoutBytes() {},
    stdinBytes: async function* () {
      if (stdin) yield new TextEncoder().encode(stdin);
    },
  };
  return sink;
}

function serve(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const { app } = createTestApp({ dataDir });
  const server = startServer(app);
  const env = { MINIBOX_URL: `http://127.0.0.1:${server.port}`, MINIBOX_ACCESS_KEY: TEST_KEY };
  return {
    app,
    env,
    stop: () => {
      server.stop(true);
      app.throttle.stop();
    },
  };
}

let restoreLogs: () => void;
let scratch: string;

beforeEach(() => {
  restoreLogs = silenceLogs();
  scratch = mkdtempSync(join(tmpdir(), "mb-cli-backup-"));
});

afterEach(() => {
  restoreLogs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("minibox backup and restore", () => {
  test("backup --out saves a sealed archive that restore opens into an empty DATA_DIR", async () => {
    const live = join(scratch, "live");
    const { env, stop } = serve(live);
    try {
      writeFileSync(join(live, "marker.txt"), "kept");
      new SecretStore(live).set("api-token", "s3cret-value-123", new Date().toISOString());
      const archive = join(scratch, "backup.mbbak");

      const created = io();
      const code = await runCli(
        ["backup", "--out", archive],
        { ...env, MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE },
        created,
      );
      expect(code).toBe(0);
      expect(created.out).toMatch(/^bk_[0-9a-z]{8,32}\n$/);
      expect(statSync(archive).mode & 0o777).toBe(0o600);

      const sealed = readFileSync(archive);
      expect(sealed.includes(Buffer.from("s3cret-value-123"))).toBe(false);
      expect(sealed.includes(Buffer.from(PASSPHRASE))).toBe(false);

      const restored = join(scratch, "restored");
      const restore = io();
      const restoredCode = await runCli(
        ["restore", archive, "--data-dir", restored],
        { MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE },
        restore,
      );
      expect(restoredCode).toBe(0);
      expect(restore.out).toContain(`Restored`);
      expect(readFileSync(join(restored, "marker.txt"), "utf8")).toBe("kept");
      expect(new SecretStore(restored).value("api-token")).toBe("s3cret-value-123");
      expect(existsSync(join(restored, "backups"))).toBe(false);
      expect(readdirSync(restored).filter((name) => name.startsWith("."))).toEqual([]);
    } finally {
      stop();
    }
  }, 30_000);

  test("the passphrase comes from stdin with --passphrase-stdin, and never from an argument", async () => {
    const { env, stop } = serve(join(scratch, "live"));
    try {
      const refused = io();
      expect(await runCli(["backup", "--passphrase", PASSPHRASE], env, refused)).toBe(2);
      expect(refused.err).toContain("Unknown option --passphrase");

      const session = io(`${PASSPHRASE}\nthe second line is ignored\n`);
      expect(await runCli(["backup", "--passphrase-stdin", "--json"], env, session)).toBe(0);
      const backup = JSON.parse(session.out) as { id: string; bytes: number; sha256: string };
      expect(backup.id).toMatch(/^bk_/);
      expect(backup.bytes).toBeGreaterThan(0);
    } finally {
      stop();
    }
  }, 30_000);

  test("a backup with no passphrase is refused before any request is sent", async () => {
    const session = io();
    const code = await runCli(
      ["backup", "--out", join(scratch, "x.mbbak")],
      { MINIBOX_URL: UNUSED_PORT, MINIBOX_ACCESS_KEY: TEST_KEY },
      session,
    );
    expect(code).toBe(2);
    expect(session.err).toContain("MINIBOX_BACKUP_PASSPHRASE");
    expect(existsSync(join(scratch, "x.mbbak"))).toBe(false);
  });

  test("backup --out refuses to replace a file unless --overwrite is given", async () => {
    const { env, stop } = serve(join(scratch, "live"));
    try {
      const archive = join(scratch, "backup.mbbak");
      writeFileSync(archive, "keep me");
      const refused = io();
      expect(
        await runCli(["backup", "--out", archive], { ...env, MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE }, refused),
      ).toBe(1);
      expect(refused.err).toContain("already exists");
      expect(readFileSync(archive, "utf8")).toBe("keep me");

      const replaced = io();
      expect(
        await runCli(
          ["backup", "--out", archive, "--overwrite"],
          { ...env, MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE },
          replaced,
        ),
      ).toBe(0);
      expect(readFileSync(archive).byteLength).toBeGreaterThan(8);
    } finally {
      stop();
    }
  }, 30_000);

  test("backup ls lists the stored backups, and backup rm deletes one", async () => {
    const { env, stop } = serve(join(scratch, "live"));
    try {
      const created = io();
      expect(await runCli(["backup"], { ...env, MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE }, created)).toBe(0);
      const id = created.out.trim();

      const listed = io();
      expect(await runCli(["backup", "ls", "--json"], env, listed)).toBe(0);
      expect((JSON.parse(listed.out) as { backups: { id: string }[] }).backups.map((b) => b.id)).toContain(id);

      const removed = io();
      expect(await runCli(["backup", "rm", id], env, removed)).toBe(0);
      expect(removed.out).toBe(`Deleted ${id}\n`);

      const after = io();
      expect(await runCli(["backup", "ls"], env, after)).toBe(0);
      expect(after.out).not.toContain(id);

      const again = io();
      expect(await runCli(["backup", "rm", id], env, again)).toBe(1);
      expect(again.err).toMatch(/not found|does not exist/i);
    } finally {
      stop();
    }
  }, 30_000);

  test("restore refuses a wrong passphrase and a DATA_DIR that holds files, and leaves both untouched", async () => {
    const { env, stop } = serve(join(scratch, "live"));
    try {
      const archive = join(scratch, "backup.mbbak");
      expect(await runCli(["backup", "--out", archive], { ...env, MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE }, io())).toBe(
        0,
      );

      const empty = join(scratch, "empty");
      const wrong = io();
      expect(
        await runCli(
          ["restore", archive, "--data-dir", empty],
          { MINIBOX_BACKUP_PASSPHRASE: "not the passphrase" },
          wrong,
        ),
      ).toBe(1);
      expect(wrong.err).toContain("does not open this backup");
      expect(readdirSync(empty)).toEqual([]);

      const occupied = join(scratch, "occupied");
      mkdirSync(occupied);
      writeFileSync(join(occupied, "keep.txt"), "keep me");
      const refused = io();
      expect(
        await runCli(["restore", archive, "--data-dir", occupied], { MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE }, refused),
      ).toBe(1);
      expect(refused.err).toContain("is not empty");
      expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("keep me");
    } finally {
      stop();
    }
  }, 30_000);

  test("restore names a file that is not a backup, and a missing archive", async () => {
    const notBackup = join(scratch, "notes.txt");
    writeFileSync(notBackup, "this is plainly not sealed by MiniBox, and it is long enough to read");
    const target = join(scratch, "target");

    const refused = io();
    expect(
      await runCli(["restore", notBackup, "--data-dir", target], { MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE }, refused),
    ).toBe(1);
    expect(refused.err).toContain("not a MiniBox backup");

    const missing = io();
    expect(
      await runCli(
        ["restore", join(scratch, "absent.mbbak"), "--data-dir", target],
        { MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE },
        missing,
      ),
    ).toBe(1);
    expect(missing.err).toContain("does not exist");
  });

  test("restore and backup usage errors exit 2 before they touch an archive or the server", async () => {
    const env = { MINIBOX_URL: UNUSED_PORT, MINIBOX_ACCESS_KEY: TEST_KEY, MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE };
    const noFile = io();
    expect(await runCli(["restore", "--data-dir", join(scratch, "t")], env, noFile)).toBe(2);
    expect(noFile.err).toContain("needs one archive file");

    const noTarget = io();
    expect(
      await runCli(["restore", join(scratch, "backup.mbbak")], { MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE }, noTarget),
    ).toBe(2);
    expect(noTarget.err).toContain("--data-dir");

    const extra = io();
    expect(await runCli(["backup", "ls", "extra"], env, extra)).toBe(2);
    expect(extra.err).toContain("takes no argument");

    const overwrite = io();
    expect(await runCli(["backup", "--overwrite"], env, overwrite)).toBe(2);
    expect(overwrite.err).toContain("--overwrite only with --out");
  });

  test("a download that does not match its record is not saved, and leaves no partial file", async () => {
    const body = "not the archive the record describes";
    const sha256 = createHash("sha256").update("the archive the record describes").digest("hex");
    const fake = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/api/backups") {
          return Response.json({ taskId: "tk_fake" }, { status: 202 });
        }
        if (req.method === "GET" && url.pathname === "/api/tasks/tk_fake") {
          return Response.json({
            id: "tk_fake",
            status: "succeeded",
            result: {
              backup: {
                id: "bk_fakebackup",
                origin: "create",
                createdAt: new Date().toISOString(),
                bytes: Buffer.byteLength(body),
                sha256,
              },
            },
          });
        }
        if (req.method === "GET" && url.pathname === "/api/backups/bk_fakebackup/download") {
          return new Response(body, { headers: { "content-type": "application/octet-stream" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const dest = join(scratch, "fake.mbbak");
      const session = io();
      const env = {
        MINIBOX_URL: `http://127.0.0.1:${fake.port}`,
        MINIBOX_ACCESS_KEY: TEST_KEY,
        MINIBOX_BACKUP_PASSPHRASE: PASSPHRASE,
      };
      expect(await runCli(["backup", "--out", dest], env, session)).toBe(1);
      expect(session.err).toContain("does not match");
      expect(readdirSync(scratch).filter((name) => name.startsWith("fake"))).toEqual([]);
    } finally {
      fake.stop(true);
    }
  });
});
