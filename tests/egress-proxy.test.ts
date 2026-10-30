import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config";
import { PROXY_PROGRAM, parseProxyLine } from "../src/egress/proxy";

const procs: Bun.Subprocess[] = [];
afterEach(() => {
  for (const proc of procs.splice(0)) proc.kill();
});

/** The runtime the program runs under in the container. Node when it is installed, otherwise Bun, which runs the same code. */
const runtime = Bun.which("node") ?? process.execPath;

/** Starts the program and resolves once it logs `listening`. Its stdout is read for as long as the process lives. */
async function startProxy(
  allow: string[],
  ranges?: readonly string[] | string,
): Promise<{ port: number; lines: string[] }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MINIBOX_EGRESS_ALLOW: JSON.stringify(allow),
  };
  // An exported variable on the machine running the tests must not leak into a case that means "unset".
  delete env.MINIBOX_EGRESS_RANGES;
  if (ranges !== undefined) {
    env.MINIBOX_EGRESS_RANGES = typeof ranges === "string" ? ranges : JSON.stringify(ranges);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = Bun.spawn([runtime, "-e", PROXY_PROGRAM], {
      env: { ...env, MINIBOX_EGRESS_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    procs.push(proc);
    const lines: string[] = [];
    const listening = new Promise<boolean>((resolve) => {
      void collect(proc, lines, (line) => {
        if (line.includes('"e":"listening"')) resolve(true);
      }).then(() => resolve(false));
    });
    if (await Promise.race([listening, Bun.sleep(4000).then(() => false)])) return { port, lines };
    proc.kill();
  }
  throw new Error("the proxy did not start");
}

async function collect(proc: Bun.Subprocess, lines: string[], onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) {
      if (line.length === 0) continue;
      lines.push(line);
      onLine(line);
    }
  }
}

/** Sends one raw request and returns the first response line, plus the whole response once the socket closes. */
function request(port: number, payload: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(response));
    socket.on("connect", () => socket.end(payload));
    setTimeout(() => socket.destroy(), timeoutMs);
  });
}

describe("proxy program", () => {
  test("CONNECT to a host off the allowlist is refused", async () => {
    const { port } = await startProxy(["example.com"]);
    const response = await request(port, "CONNECT not-listed.test:443 HTTP/1.1\r\nHost: not-listed.test:443\r\n\r\n");
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
  });

  test("CONNECT to a port other than 443 is refused", async () => {
    const { port } = await startProxy(["example.com"]);
    const response = await request(port, "CONNECT example.com:22 HTTP/1.1\r\nHost: example.com:22\r\n\r\n");
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
  });

  test("an allowlisted name that resolves to a private address is refused", async () => {
    const { port, lines } = await startProxy(["localhost"]);
    const response = await request(port, "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
    await Bun.sleep(100);
    const denied = lines.map(parseProxyLine).find((event) => event?.kind === "denied");
    expect(denied).toEqual({ kind: "denied", host: "localhost", port: 443, reason: "private_address" });
  });

  test("a private address inside an allowed range is let through to the upstream attempt", async () => {
    // localhost resolves to a loopback address, which the proxy refuses unless the range that holds it is allowed.
    const { port, lines } = await startProxy(["localhost"], ["127.0.0.0/8"]);
    const response = await request(port, "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    // Nothing listens on 443, so the attempt fails upstream; a refusal would be a 403.
    expect(response.split("\r\n")[0]).not.toBe("HTTP/1.1 403 Forbidden");
    await Bun.sleep(100);
    const events = lines.map(parseProxyLine).filter((event) => event !== null);
    expect(events.some((event) => event.kind === "denied" && event.reason === "private_address")).toBe(false);
    expect(events.some((event) => event.kind === "failed" && event.reason === "upstream")).toBe(true);
  });

  test("a private address outside the allowed ranges is still refused", async () => {
    const { port, lines } = await startProxy(["localhost"], ["198.18.0.0/15"]);
    const response = await request(port, "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
    await Bun.sleep(100);
    const denied = lines.map(parseProxyLine).find((event) => event?.kind === "denied");
    expect(denied).toEqual({ kind: "denied", host: "localhost", port: 443, reason: "private_address" });
  });

  test("an empty ranges variable keeps the refusal exactly as it was", async () => {
    const { port, lines } = await startProxy(["localhost"], "[]");
    const response = await request(port, "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
    await Bun.sleep(100);
    const denied = lines.map(parseProxyLine).find((event) => event?.kind === "denied");
    expect(denied).toEqual({ kind: "denied", host: "localhost", port: 443, reason: "private_address" });
  });

  test("a malformed ranges variable does not stop the proxy", async () => {
    // The last two would each pass a looser parser and then let a private address through: an octet above 255 wraps
    // into the range, and /0 would hold every address. A host written as an address is resolved by the program itself,
    // without DNS, so the answer these cases see is exactly the one named.
    const cases = [
      { ranges: "not json", host: "localhost" },
      { ranges: '{"range":"127.0.0.0/8"}', host: "localhost" },
      { ranges: '["127.0.0.0",42,null,"nope"]', host: "localhost" },
      { ranges: '["198.18.0.300/16"]', host: "198.18.0.5" },
      { ranges: '["0.0.0.0/0"]', host: "10.1.2.3" },
    ];
    for (const { ranges, host } of cases) {
      const { port, lines } = await startProxy([host], ranges);
      const response = await request(port, `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
      expect(response.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
      await Bun.sleep(100);
      const denied = lines.map(parseProxyLine).find((event) => event?.kind === "denied");
      expect(denied).toEqual({ kind: "denied", host, port: 443, reason: "private_address" });
    }
  });

  test("a range loadConfig produces lets a fake-IP answer through", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "minibox-egress-proxy-"));
    try {
      const cfg = loadConfig(
        { ACCESS_KEY: "k".repeat(64), DATA_DIR: dataDir, EGRESS_ALLOW_RANGES: "198.18.0.1/16" },
        { envFile: join(dataDir, "absent.env") },
      );
      expect(cfg.egressAllowRanges).toEqual(["198.18.0.0/16"]);
      const { port, lines } = await startProxy(["198.18.0.5"], cfg.egressAllowRanges);
      const response = await request(port, "CONNECT 198.18.0.5:443 HTTP/1.1\r\nHost: 198.18.0.5:443\r\n\r\n", 1500);
      // Nothing routes to the fake address here, so the attempt may time out; what it must not be is the refusal.
      expect(response.split("\r\n")[0]).not.toBe("HTTP/1.1 403 Forbidden");
      await Bun.sleep(100);
      const events = lines.map(parseProxyLine).filter((event) => event !== null);
      expect(events.some((event) => event.kind === "denied" && event.reason === "private_address")).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a plain HTTP request is refused without its path reaching the log", async () => {
    const { port, lines } = await startProxy(["example.com"]);
    const response = await request(
      port,
      "GET http://not-listed.test/secret-path?token=abc HTTP/1.1\r\nHost: not-listed.test\r\n\r\n",
    );
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
    await Bun.sleep(100);
    const log = lines.join("\n");
    expect(log).toContain("not-listed.test");
    expect(log).not.toContain("secret-path");
    expect(log).not.toContain("token=abc");
  });

  test("a request without an absolute URL is refused", async () => {
    const { port } = await startProxy(["example.com"]);
    const response = await request(port, "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
  });
});
