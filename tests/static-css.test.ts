import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveFile } from "../src/static";

const WEB = join(import.meta.dir, "..", "web");

describe("stylesheet parts", () => {
  test("app.css is served as one stylesheet: every part is inlined in import order and no @import is left", async () => {
    const res = await serveFile(WEB, "/css/app.css");
    expect(res?.headers.get("content-type")).toBe("text/css; charset=utf-8");
    const served = await res!.text();
    expect(served).not.toContain("@import");
    const source = readFileSync(join(WEB, "css", "app.css"), "utf8");
    const parts = [...source.matchAll(/^@import "([^"]+)";$/gm)].map(([, rel]) => rel!);
    expect(parts.length).toBeGreaterThan(1);
    let at = -1;
    for (const rel of parts) {
      const text = readFileSync(join(WEB, "css", rel), "utf8").trimEnd();
      const found = served.indexOf(text);
      expect(found).toBeGreaterThan(at);
      at = found;
    }
    expect(served).toContain(".overlay {");
  });

  test("an import outside the web root or of a missing file is left as written", async () => {
    const root = mkdtempSync(join(tmpdir(), "mb-static-"));
    mkdirSync(join(root, "css", "app"), { recursive: true });
    writeFileSync(join(root, "css", "app", "a.css"), ".a { color: red; }\n");
    writeFileSync(join(root, "secret.css"), ".secret {}\n");
    writeFileSync(
      join(root, "css", "app.css"),
      '@import "app/a.css";\n@import "app/missing.css";\n@import "https://example.com/x.css";\n.b {}\n',
    );
    const served = await (await serveFile(root, "/css/app.css"))!.text();
    expect(served).toContain(".a { color: red; }");
    expect(served).toContain('@import "app/missing.css";');
    expect(served).toContain('@import "https://example.com/x.css";');
    expect(served).toContain(".b {}");
    const part = await (await serveFile(root, "/css/app/a.css"))!.text();
    expect(part).toBe(".a { color: red; }\n");
  });
});
