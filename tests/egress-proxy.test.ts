import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";

import { PROXY_PROGRAM, parseProxyLine } from "../src/egress/proxy";

const procs: Bun.Subprocess[] = [];
afterEach(() => {
  for (const proc of procs.splice(0)) proc.kill();
});

/** The runtime the program runs under in the container. Node when it is installed, otherwise Bun, which runs the same code. */
const runtime = Bun.which("node") ?? process.execPath;

/** Starts the program and resolves once it logs `listening`. Its stdout is read for as long as the process lives. */
async function startProxy(allow: string[]): Promise<{ port: number; lines: string[] }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = Bun.spawn([runtime, "-e", PROXY_PROGRAM], {
      env: {
        ...process.env,
        MINIBOX_EGRESS_PORT: String(port),
        MINIBOX_EGRESS_ALLOW: JSON.stringify(allow),
      },
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
function request(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(response));
    socket.on("connect", () => socket.end(payload));
    setTimeout(() => socket.destroy(), 5000);
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
