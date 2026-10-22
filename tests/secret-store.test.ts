import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SecretStore } from "../src/secrets/store";
import { silenceLogs } from "./support/app";

let dataDir: string;
let store: SecretStore;
const NOW = "2026-10-22T10:00:00.000Z";
const LATER = "2026-10-22T11:00:00.000Z";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mbx-secrets-"));
  store = new SecretStore(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("the secret store", () => {
  test("a secret is a mode 600 file under secrets/env and reads back exactly, spaces and all", () => {
    const value = "  pa=ss word  ";
    const { meta, created } = store.set("db-pass", value, NOW);

    expect(created).toBe(true);
    expect(meta).toEqual({ name: "db-pass", createdAt: NOW, updatedAt: NOW });
    const path = join(dataDir, "secrets", "env", "db-pass");
    expect(modeOf(path)).toBe(0o600);
    expect(store.value("db-pass")).toBe(value);
  });

  test("listings carry names and timestamps, never a value", () => {
    store.set("alpha", "value-one-secret", NOW);
    store.set("beta", "value-two-secret", NOW);

    const listed = store.list();
    expect(listed.map((item) => item.name)).toEqual(["alpha", "beta"]);
    expect(Object.keys(listed[0] ?? {}).toSorted()).toEqual(["createdAt", "name", "updatedAt"]);
    expect(JSON.stringify(listed)).not.toContain("value-one-secret");
    expect(JSON.stringify(store.meta("beta"))).not.toContain("value-two-secret");
  });

  test("replacing keeps the creation time, moves the update time, and reports that nothing was created", () => {
    store.set("token", "first-value-here", NOW);
    const replaced = store.set("token", "second-value-here", LATER);

    expect(replaced.created).toBe(false);
    expect(replaced.meta).toEqual({ name: "token", createdAt: NOW, updatedAt: LATER });
    expect(store.value("token")).toBe("second-value-here");
  });

  test("remove deletes the secret and reports whether there was one to delete", () => {
    store.set("gone", "some-secret-value", NOW);

    expect(store.remove("gone")).toBe(true);
    expect(store.remove("gone")).toBe(false);
    expect(store.value("gone")).toBeNull();
    expect(store.meta("gone")).toBeNull();
    expect(store.list()).toEqual([]);
  });

  test("a name that is not a valid secret name is refused for writes and is not read", () => {
    expect(() => store.set("../escape", "value-value-value", NOW)).toThrow();
    expect(() => store.set("with space", "value-value-value", NOW)).toThrow();
    expect(store.value("../escape")).toBeNull();
    expect(store.meta("")).toBeNull();
  });

  test("files in the directory whose names are not valid secret names are not listed", () => {
    store.set("real", "real-secret-value", NOW);
    const dir = join(dataDir, "secrets", "env");
    writeFileSync(join(dir, ".hidden"), `{"value":"x","createdAt":"${NOW}","updatedAt":"${NOW}"}`);
    writeFileSync(join(dir, "with space"), `{"value":"x","createdAt":"${NOW}","updatedAt":"${NOW}"}`);

    expect(store.list().map((item) => item.name)).toEqual(["real"]);
  });

  test("a file that is not a secret record is treated as missing, so a box cannot start with an empty value", () => {
    const dir = join(dataDir, "secrets", "env");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken"), "{not json");
    writeFileSync(join(dir, "shaped"), JSON.stringify({ value: 42, createdAt: NOW, updatedAt: NOW }));

    const restoreLogs = silenceLogs();
    try {
      expect(store.value("broken")).toBeNull();
      expect(store.value("shaped")).toBeNull();
      expect(store.list()).toEqual([]);
    } finally {
      restoreLogs();
    }
  });

  test("a loose file mode is tightened to 600 when the value is read", () => {
    store.set("loose", "loose-secret-value", NOW);
    const path = join(dataDir, "secrets", "env", "loose");
    chmodSync(path, 0o644);

    expect(store.value("loose")).toBe("loose-secret-value");
    expect(modeOf(path)).toBe(0o600);
  });

  test("a write leaves no temporary file behind, so the listing holds only secrets", () => {
    store.set("clean", "clean-secret-value", NOW);
    store.set("clean", "clean-secret-value-2", LATER);

    expect(readdirSync(join(dataDir, "secrets", "env"))).toEqual(["clean"]);
  });
});
