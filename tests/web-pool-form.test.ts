import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";

const LIB = join(ROOT, "web", "js", "lib");
const I18N = join(ROOT, "web", "js", "i18n");

/**
 * Evaluates `expression` in a fresh process whose globals stand in for the browser: the pool form reads the language
 * once, when the i18n module loads. `form` is the loaded module, `en` and `zh` the dictionaries.
 */
function inBrowser<T>(expression: string, saved = "en"): T {
  const script = [
    `const store = new Map([["minibox.lang", ${JSON.stringify(saved)}]]);`,
    `Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {`,
    `  getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) } });`,
    `Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });`,
    `Object.defineProperty(globalThis, "document", { configurable: true, value: {`,
    `  documentElement: {}, querySelector: () => null, querySelectorAll: () => [], body: { append() {} },`,
    `  createElement: () => ({ content: { firstElementChild: {} }, set innerHTML(v) {} }),`,
    `  addEventListener() {}, removeEventListener() {} } });`,
    `const form = await import(${JSON.stringify(join(LIB, "pool-form.js"))});`,
    `const en = (await import(${JSON.stringify(join(I18N, "en.js"))})).default;`,
    `const zh = (await import(${JSON.stringify(join(I18N, "zh-CN.js"))})).default;`,
    FORM,
    `console.log(JSON.stringify(${expression}));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as T;
}

/** A saved NFS pool, as `GET /api/pools` returns one. */
const nasPool = {
  name: "nas",
  backend: "nfs" as const,
  default: true,
  server: "192.168.1.10",
  export: "/volume1/minibox",
  options: ["nfsvers=4.1", "hard"],
  root: null,
  marker: null,
};

const localPool = {
  name: "local",
  backend: "local" as const,
  default: false,
  server: null,
  export: null,
  options: [] as string[],
  root: null,
  marker: null,
};

/** The body of the test cases, so a case reads as the calls it makes. */
const FORM = `
  const nas = ${JSON.stringify(nasPool)};
  const local = ${JSON.stringify(localPool)};
`;

describe("the pool form starts from the pool it edits", () => {
  test("an NFS pool fills the name, server, export, comma-separated options and the default flag", () => {
    expect(inBrowser(`        form.poolForm(nas)`, "en")).toEqual({
      name: "nas",
      backend: "nfs",
      server: "192.168.1.10",
      export: "/volume1/minibox",
      options: "nfsvers=4.1, hard",
      root: "",
      marker: "",
      default: true,
    });
  });

  test("a path pool fills its root and marker, and a blank one starts at the marker the server defaults to", () => {
    expect(
      inBrowser(
        `        ({
          saved: form.poolForm({ ...local, name: "disk", backend: "path", root: "/mnt/disk", marker: ".mounted" }),
          blank: form.poolForm({ backend: "path" }),
          blankNfs: form.poolForm({ backend: "nfs" }),
        })`,
      ),
    ).toEqual({
      saved: {
        name: "disk",
        backend: "path",
        server: "",
        export: "",
        options: "",
        root: "/mnt/disk",
        marker: ".mounted",
        default: false,
      },
      blank: {
        name: "",
        backend: "path",
        server: "",
        export: "",
        options: "",
        root: "",
        marker: ".minibox-mounted",
        default: false,
      },
      blankNfs: {
        name: "",
        backend: "nfs",
        server: "",
        export: "",
        options: "",
        root: "",
        marker: "",
        default: false,
      },
    });
  });

  test("options split on commas, with the spaces and empty entries dropped", () => {
    expect(inBrowser(`form.splitOptions(" nfsvers=4.1 , hard ,, noatime ")`)).toEqual([
      "nfsvers=4.1",
      "hard",
      "noatime",
    ]);
    expect(inBrowser(`form.splitOptions("")`)).toEqual([]);
  });
});

describe("the pool a form describes", () => {
  test("an edited NFS pool keeps its backend and capabilities, and sends the new parameters", () => {
    expect(
      inBrowser(`form.poolDraft(
          { ...form.poolForm(nas), export: "/volume1/data", options: "nfsvers=4.2, soft", default: false },
          { pool: nas, pools: [local, nas] },
        )`),
    ).toEqual({
      pool: {
        name: "nas",
        backend: "nfs",
        default: false,
        server: "192.168.1.10",
        export: "/volume1/data",
        options: ["nfsvers=4.2", "soft"],
        root: null,
        marker: null,
        capabilities: { shareable: true, snapshots: false, quota: false, clone: false, crossHost: true },
      },
    });
  });

  test("a renamed pool is accepted, and a name another pool holds is refused with the server's own key", () => {
    expect(
      inBrowser(`({
          renamed: form.poolDraft({ ...form.poolForm(nas), name: "nas-2" }, { pool: nas, pools: [local, nas] }),
          duplicate: form.poolDraft(
            { ...form.poolForm(nas), name: "backup" },
            { pool: nas, pools: [local, nas, { ...nas, name: "backup" }] },
          ),
        })`),
    ).toEqual({
      renamed: {
        pool: {
          name: "nas-2",
          backend: "nfs",
          default: true,
          server: "192.168.1.10",
          export: "/volume1/minibox",
          options: ["nfsvers=4.1", "hard"],
          root: null,
          marker: null,
          capabilities: { shareable: true, snapshots: false, quota: false, clone: false, crossHost: true },
        },
      },
      duplicate: { error: "Pool names must be unique.", field: "p-name" },
    });
  });

  test("an invalid name, a missing NFS field, bad options and a missing root each name the field to show it on", () => {
    expect(
      inBrowser(`({
          badName: form.poolDraft({ ...form.poolForm(nas), name: "-nas" }, { pool: nas, pools: [local, nas] }),
          noServer: form.poolDraft({ ...form.poolForm(nas), server: "  " }, { pool: nas, pools: [local, nas] }),
          noExport: form.poolDraft({ ...form.poolForm(nas), export: "" }, { pool: nas, pools: [local, nas] }),
          badOption: form.poolDraft(
            { ...form.poolForm(nas), options: "nfsvers=4.1, a b" },
            { pool: nas, pools: [local, nas] },
          ),
          tooMany: form.poolDraft(
            { ...form.poolForm(nas), options: Array.from({ length: 17 }, (_, i) => "o" + i).join(", ") },
            { pool: nas, pools: [local, nas] },
          ),
          emptyOptions: form.poolDraft({ ...form.poolForm(nas), options: "" }, { pool: nas, pools: [local, nas] }),
          noRoot: form.poolDraft(
            { ...form.poolForm({ ...local, name: "disk", backend: "path", root: "/mnt/disk" }), root: "" },
            { pool: { ...local, name: "disk", backend: "path" }, pools: [local] },
          ),
          localBackend: form.poolDraft({ ...form.poolForm({ backend: "nfs" }), name: "local" }, { pools: [local] }),
        })`),
    ).toEqual({
      badName: {
        error:
          "Name may only contain letters, digits, dots, underscores and hyphens, and must start with a letter or digit.",
        field: "p-name",
      },
      noServer: { error: "NFS pool nas needs a server and an absolute export path.", field: "p-server" },
      noExport: { error: "NFS pool nas needs a server and an absolute export path.", field: "p-export" },
      badOption: {
        error: "NFS options for pool nas must be up to 16 tokens of letters, digits and . _ = -.",
        field: "p-options",
      },
      tooMany: {
        error: "NFS options for pool nas must be up to 16 tokens of letters, digits and . _ = -.",
        field: "p-options",
      },
      emptyOptions: { error: "Enter at least one NFS option, such as nfsvers=4.1.", field: "p-options" },
      noRoot: { error: "Path pool disk needs an absolute root directory.", field: "p-root" },
      localBackend: { error: "The local pool must stay a local backend.", field: "p-name" },
    });
  });

  test("a name the form only trims is not a rename, and a blank marker takes the default one", () => {
    expect(
      inBrowser(`({
          trimmed: form.poolDraft({ ...form.poolForm(nas), name: " nas " }, { pool: nas, pools: [local, nas] }).pool.name,
          marker: form.poolDraft(
            { ...form.poolForm({ ...local, name: "disk", backend: "path", root: "/mnt/disk" }), marker: "" },
            { pool: { ...local, name: "disk", backend: "path" }, pools: [local] },
          ).pool.marker,
        })`),
    ).toEqual({ trimmed: "nas", marker: ".minibox-mounted" });
  });

  test("the messages are the dictionary's own, so the dialog says what the rest of the console says", () => {
    const duplicate = `form.poolDraft({ name: "nas-2", backend: "nfs", server: "h", export: "/e" }, { pools: [{ ...nas, name: "nas-2" }] }).error`;
    expect(inBrowser(`({ duplicate: ${duplicate} === en["err.pool_duplicate"] })`)).toEqual({ duplicate: true });
    expect(inBrowser(`({ duplicate: ${duplicate} === zh["err.pool_duplicate"] })`, "zh-CN")).toEqual({
      duplicate: true,
    });
    expect(
      inBrowser(
        `({
          options: form.poolDraft({ ...form.poolForm(nas), server: "" }, { pool: nas, pools: [local, nas] }).error,
          emptyOptions: form.poolDraft({ ...form.poolForm(nas), options: "" }, { pool: nas, pools: [local, nas] }).error,
        })`,
        "zh-CN",
      ),
    ).toEqual({
      options: "NFS 池 nas 需要服务器和绝对导出路径。",
      emptyOptions: "请至少填写一个 NFS 选项，例如 nfsvers=4.1。",
    });
  });
});

describe("writing a pool back into the list", () => {
  test("the pool is replaced by name, keeps its place, and every other pool is left as it was", () => {
    expect(
      inBrowser(`form.applyPoolDraft(
          [local, nas, { ...nas, name: "backup", default: false }],
          "nas",
          { ...nas, export: "/volume1/data", default: true },
        ).map((pool) => [pool.name, pool.default, pool.export])`),
    ).toEqual([
      ["local", false, null],
      ["nas", true, "/volume1/data"],
      ["backup", false, "/volume1/minibox"],
    ]);
  });

  test("a rename leaves the list one pool shorter only by the old name, and a default draft clears the other flags", () => {
    expect(
      inBrowser(
        `form.applyPoolDraft([local, nas], "nas", { ...nas, name: "nas-2", default: false }).map((pool) => pool.name)`,
      ),
    ).toEqual(["local", "nas-2"]);
    expect(
      inBrowser(`form.applyPoolDraft(
          [{ ...local, default: true }, { ...nas, default: false }],
          "nas",
          { ...nas, default: true },
        ).map((pool) => [pool.name, pool.default])`),
    ).toEqual([
      ["local", false],
      ["nas", true],
    ]);
  });

  test("the roles that named the old pool name the new one, and the others stay", () => {
    expect(
      inBrowser(`form.renameRole({ workspace: "nas", home: null, tools: "local", cache: "nas" }, "nas", "nas-2")`),
    ).toEqual({ workspace: "nas-2", home: null, tools: "local", cache: "nas-2" });
  });

  test("a save's changed pools name what each mounts before and after, and a default-only change is not one", () => {
    expect(
      inBrowser(`({
          changed: form.poolChanges(
            [local, nas],
            [local, { ...nas, export: "/volume1/data", default: false }],
          ),
          defaultOnly: form.poolChanges([local, nas], [local, { ...nas, default: false }]),
          added: form.poolChanges([local], [local, nas]),
          path: form.poolSummary({ name: "disk", backend: "path", root: "/mnt/disk", marker: ".mounted" }),
          nfsNoOptions: form.poolSummary({ name: "nas", backend: "nfs", server: "h", export: "/e", options: [] }),
        })`),
    ).toEqual({
      changed: [
        {
          name: "nas",
          from: "nfs · 192.168.1.10:/volume1/minibox · nfsvers=4.1,hard",
          to: "nfs · 192.168.1.10:/volume1/data · nfsvers=4.1,hard",
        },
      ],
      defaultOnly: [],
      added: [],
      path: "path · /mnt/disk · .mounted",
      nfsNoOptions: "nfs · h:/e",
    });
  });
});
