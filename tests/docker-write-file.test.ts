import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WRITE_FILE_SCRIPT } from "../src/docker/exec";

function writeProcess(path: string, temporary: string) {
  return Bun.spawn(["/bin/sh", "-c", WRITE_FILE_SCRIPT, "sh", path, "022", "755", temporary], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
}

async function waitForBytes(path: string, size: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!existsSync(path) || statSync(path).size !== size) {
    if (Date.now() > deadline) throw new Error(`the writer did not reach ${size} bytes`);
    await Bun.sleep(5);
  }
}

describe.skipIf(process.platform !== "linux")("container file publication", () => {
  test("concurrent writes publish complete executables while another writer still has its temporary file open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-write-"));
    const path = join(dir, "relay");
    const original = readFileSync("/bin/true");
    const firstBytes = Buffer.concat([original, Buffer.from("first")]);
    const secondBytes = Buffer.concat([original, Buffer.from("second")]);
    writeFileSync(path, original, { mode: 0o755 });
    chmodSync(path, 0o755);
    const first = writeProcess(path, join(dir, "first.tmp"));
    const second = writeProcess(path, join(dir, "second.tmp"));
    try {
      first.stdin.write(firstBytes.subarray(0, 100));
      second.stdin.write(secondBytes.subarray(0, 100));
      await Promise.all([first.stdin.flush(), second.stdin.flush()]);
      await Promise.all([waitForBytes(join(dir, "first.tmp"), 100), waitForBytes(join(dir, "second.tmp"), 100)]);
      expect(readFileSync(path)).toEqual(original);

      first.stdin.write(firstBytes.subarray(100));
      first.stdin.end();
      expect(await first.exited).toBe(0);
      expect(readFileSync(path)).toEqual(firstBytes);
      expect(statSync(path).mode & 0o777).toBe(0o755);
      // The second writer is still open, but it cannot cause ETXTBSY on the published executable.
      expect(await Bun.spawn([path], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);

      second.stdin.write(secondBytes.subarray(100));
      second.stdin.end();
      expect(await second.exited).toBe(0);
      expect(readFileSync(path)).toEqual(secondBytes);
      expect(readdirSync(dir)).toEqual(["relay"]);
    } finally {
      first.kill();
      second.kill();
      await Promise.all([first.exited, second.exited]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replacing a destination symlink preserves its referent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-write-link-"));
    try {
      const original = join(dir, "original");
      const path = join(dir, "destination");
      writeFileSync(original, "keep");
      symlinkSync(original, path);
      const writer = writeProcess(path, join(dir, "temporary"));
      writer.stdin.write("replacement");
      writer.stdin.end();
      expect(await writer.exited).toBe(0);
      expect(readFileSync(original, "utf8")).toBe("keep");
      expect(readFileSync(path, "utf8")).toBe("replacement");
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
