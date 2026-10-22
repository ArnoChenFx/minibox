import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { CONTEXT_MAX_BYTES, extractContextUrl, extractTar } from "../src/services/build-context";
import { rejectionOf } from "./support/app";
import { archive, entry, gnuLongName, tarBytes } from "./support/tar";

const fresh = (): string => mkdtempSync(join(tmpdir(), "bctx-"));
const stream = (bytes: Buffer) => Readable.from([bytes]);

async function refusal(
  bytes: Buffer,
  opts?: Parameters<typeof extractTar>[2],
): Promise<{ key?: string; detail: string }> {
  const error = await rejectionOf(extractTar(stream(bytes), fresh(), opts));
  const failure = error as { key?: string; params?: { detail?: string } };
  return { key: failure.key, detail: failure.params?.detail ?? String(error) };
}

describe("extractTar keeps a build context inside its directory", () => {
  test("regular files, directories and symlinks that stay inside are written", async () => {
    const root = fresh();
    await extractTar(
      stream(
        tarBytes([
          { name: "app/", dir: true },
          { name: "app/Dockerfile", body: Buffer.from("FROM alpine:3.20\n") },
          { name: "app/latest", typeflag: "2", linkname: "Dockerfile" },
        ]),
      ),
      root,
    );
    expect(readFileSync(join(root, "app/Dockerfile"), "utf8")).toBe("FROM alpine:3.20\n");
    expect(readlinkSync(join(root, "app/latest"))).toBe("Dockerfile");
  });

  test("a path that climbs out of the context is refused and nothing is written outside", async () => {
    const root = fresh();
    const error = await rejectionOf(
      extractTar(stream(tarBytes([{ name: "../escape.txt", body: Buffer.from("x") }])), root),
    );
    expect(error).toMatchObject({ status: 400, key: "context_invalid" });
    expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
  });

  test("an absolute path is refused", async () => {
    expect((await refusal(tarBytes([{ name: "/etc/evil", body: Buffer.from("x") }]))).detail).toContain("absolute");
  });

  test("a symlink whose target resolves outside the context is refused once the archive is in place", async () => {
    const result = await refusal(tarBytes([{ name: "escape", typeflag: "2", linkname: "../../../../../../../etc" }]));
    expect(result.key).toBe("context_invalid");
    expect(result.detail).toContain("does not point inside the build context");
  });

  test("a symlink to an absolute path is refused when it is read", async () => {
    expect((await refusal(tarBytes([{ name: "passwd", typeflag: "2", linkname: "/etc/passwd" }]))).detail).toContain(
      "links to",
    );
  });

  test("a write that would pass through a symlink is refused, so the write cannot be redirected", async () => {
    const result = await refusal(
      tarBytes([
        { name: "dir", typeflag: "2", linkname: "." },
        { name: "dir/Dockerfile", body: Buffer.from("FROM x") },
      ]),
    );
    expect(result.detail).toContain("inside a symbolic link");
  });

  test("a hard link, a device, a FIFO or another special entry is refused", async () => {
    for (const typeflag of ["1", "3", "4", "6"]) {
      const result = await refusal(tarBytes([{ name: "special", typeflag, linkname: "target" }]));
      expect(result.detail).toContain("hard link, a device or another special file");
    }
  });

  test("a header with a wrong checksum is refused as not a tar file", async () => {
    expect((await refusal(tarBytes([{ name: "a.txt", body: Buffer.from("a"), badChecksum: true }]))).detail).toContain(
      "not a tar file",
    );
  });

  test("an archive that ends inside an entry is refused as truncated", async () => {
    const whole = tarBytes([{ name: "big.bin", body: Buffer.alloc(4096, 7) }], { trailer: false });
    expect((await refusal(whole.subarray(0, 512 + 1000))).detail).toContain("truncated");
  });

  test("more entries than the limit are refused", async () => {
    const bytes = tarBytes([{ name: "a" }, { name: "b" }, { name: "c" }], { trailer: true });
    expect((await refusal(bytes, { maxEntries: 2 })).detail).toContain("more than 2 entries");
  });

  test("more bytes than the limit are refused before the file is written", async () => {
    const root = fresh();
    const bytes = tarBytes([{ name: "big.txt", body: Buffer.alloc(2048, 1) }]);
    const error = await rejectionOf(extractTar(stream(bytes), root, { maxBytes: 1024 }));
    expect(error).toMatchObject({ key: "context_invalid" });
    expect(existsSync(join(root, "big.txt"))).toBe(false);
  });

  test("a PAX path record and a GNU long name both name the entry in full", async () => {
    const long = `deep/${"n".repeat(150)}.txt`;
    const root = fresh();
    await extractTar(stream(tarBytes([{ name: "short.txt", body: Buffer.from("pax"), pax: { path: long } }])), root);
    expect(readFileSync(join(root, long), "utf8")).toBe("pax");

    const gnuRoot = fresh();
    const gnuName = `gnu/${"g".repeat(150)}.txt`;
    await extractTar(
      stream(archive(gnuLongName(gnuName), entry({ name: "short.txt", type: "0" }, Buffer.from("gnu")))),
      gnuRoot,
    );
    expect(readFileSync(join(gnuRoot, gnuName), "utf8")).toBe("gnu");
  });

  test("a top-level name the caller skips, such as .git, is read past and not written", async () => {
    const root = fresh();
    await extractTar(
      stream(
        tarBytes([
          { name: ".git/config", body: Buffer.from("[core]") },
          { name: "src/a.txt", body: Buffer.from("a") },
        ]),
      ),
      root,
      { skip: (top) => top === ".git" },
    );
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(readFileSync(join(root, "src/a.txt"), "utf8")).toBe("a");
  });

  test("the default limits leave room for a real context", () => {
    expect(CONTEXT_MAX_BYTES).toBe(256 * 1024 * 1024);
  });
});

describe("extractContextUrl fetches a context archive", () => {
  let server: ReturnType<typeof Bun.serve>;
  const plain = new Uint8Array(tarBytes([{ name: "Dockerfile", body: Buffer.from("FROM alpine:3.20\n") }]));

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/ctx.tar") return new Response(plain);
        if (pathname === "/ctx.tar.gz") return new Response(Bun.gzipSync(plain));
        if (pathname === "/redirect") return Response.redirect(`http://127.0.0.1:${server.port}/ctx.tar`, 302);
        return new Response("nope", { status: 404 });
      },
    });
  });

  afterAll(() => server.stop(true));

  const base = () => `http://127.0.0.1:${server.port}`;

  test("a plain tar is unpacked", async () => {
    const root = fresh();
    await extractContextUrl(`${base()}/ctx.tar`, root);
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toBe("FROM alpine:3.20\n");
  });

  test("a gzipped tar is detected by its magic bytes and unpacked", async () => {
    const root = fresh();
    await extractContextUrl(`${base()}/ctx.tar.gz`, root);
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toBe("FROM alpine:3.20\n");
  });

  test("redirects are followed", async () => {
    const root = fresh();
    await extractContextUrl(`${base()}/redirect`, root);
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toBe("FROM alpine:3.20\n");
  });

  test("an HTTP error is refused as a failed fetch with the status", async () => {
    const error = await rejectionOf(extractContextUrl(`${base()}/missing.tar`, fresh()));
    expect(error).toMatchObject({ key: "context_fetch_failed", params: { detail: "HTTP 404" } });
  });

  test("an address with credentials is refused before any request", async () => {
    const error = await rejectionOf(extractContextUrl("https://user:pw@example.com/ctx.tar", fresh()));
    expect(error).toMatchObject({ key: "context_url_invalid" });
  });

  test("a host that does not answer is refused as a failed fetch", async () => {
    const error = await rejectionOf(extractContextUrl("http://127.0.0.1:1/ctx.tar", fresh()));
    expect(error).toMatchObject({ key: "context_fetch_failed" });
  });
});
