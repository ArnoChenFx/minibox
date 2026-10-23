import { afterAll, beforeAll, describe, expect, test } from "bun:test";

interface Change {
  field: string;
  from: string;
  to: string;
}

let mountLines: (change: Change) => string[] | null;
let envLines: (change: Change) => string[] | null;
const restores: (() => void)[] = [];

function stubGlobal(name: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  restores.push(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete (globalThis as Record<string, unknown>)[name];
  });
}

beforeAll(async () => {
  const store = new Map<string, string>();
  stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  });
  stubGlobal("document", { documentElement: {} });
  // @ts-expect-error The web modules are plain JavaScript without declarations.
  ({ mountLines, envLines } = await import("../web/js/components/staged-changes.js"));
});

afterAll(() => {
  for (const restore of restores.toReversed()) restore();
});

const mounts = (rows: { path: string; volume: string; mode: string }[]) => JSON.stringify(rows);

describe("the staged mounts change", () => {
  test("lists each path that is added, removed or switched, and leaves out the ones that stay", () => {
    const change = {
      field: "mounts",
      from: mounts([
        { path: "/workspace", volume: "vol_a", mode: "rw" },
        { path: "/home/dev", volume: "vol_b", mode: "rw" },
        { path: "/cache", volume: "vol_c", mode: "rw" },
      ]),
      to: mounts([
        { path: "/home/dev", volume: "vol_b", mode: "rw" },
        { path: "/cache", volume: "vol_c", mode: "ro" },
        { path: "/data", volume: "vol_d", mode: "ro" },
      ]),
    };
    expect(mountLines(change)).toEqual(["~ /cache (Read-write → Read-only)", "+ /data (Read-only)", "− /workspace"]);
  });

  test("is null for text that is not the JSON a plan names mounts in", () => {
    expect(mountLines({ field: "mounts", from: "a", to: "[]" })).toBeNull();
  });
});

const env = (rows: { name: string; value?: string; secretRef?: string }[]) =>
  JSON.stringify(rows.map((row) => ({ name: row.name, value: row.value ?? null, secretRef: row.secretRef ?? null })));

describe("the staged environment change", () => {
  test("lists each variable that is added, removed or set to another value, and leaves out the ones that stay", () => {
    const change = {
      field: "env",
      from: env([
        { name: "KEEP", value: "1" },
        { name: "MODE", value: "dev" },
        { name: "OLD", value: "x" },
      ]),
      to: env([
        { name: "API_URL", value: "https://api.example.com" },
        { name: "KEEP", value: "1" },
        { name: "MODE", value: "prod" },
        { name: "TOKEN", secretRef: "GITHUB_TOKEN" },
      ]),
    };
    expect(envLines(change)).toEqual([
      "+ API_URL=https://api.example.com",
      "~ MODE: dev → prod",
      "+ TOKEN=🔒 secret: GITHUB_TOKEN",
      "− OLD",
    ]);
  });

  test("is null for the note about a rotated secret", () => {
    expect(envLines({ field: "env", from: "secret A: value in use", to: "secret A: new value" })).toBeNull();
  });
});
