import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";

import { SshTunnel } from "../src/host/ssh";
import { type FakeSshHost, type KeyPair, newKeyPair, removeDir, startSshHost, tempDir } from "./support/engines";

let dir: string;
let upstream: Server;
let upstreamPath: string;
let sshHost: FakeSshHost;
let trusted: KeyPair;

/** A socket server that answers only once the client has finished sending, as Docker does when an exec's stdin closes. */
function startReplyAfterEnd(path: string): Promise<Server> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    socket.on("end", () => {
      setTimeout(() => socket.end(`got:${received}`), 50);
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

function exchange(socketPath: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createConnection({ path: socketPath, allowHalfOpen: true });
    let reply = "";
    client.on("data", (chunk: Buffer) => {
      reply += chunk.toString();
    });
    client.on("error", reject);
    client.on("close", () => resolve(reply));
    client.end(message);
  });
}

beforeAll(async () => {
  dir = tempDir("mbtun-");
  upstreamPath = join(dir, "engine.sock");
  upstream = await startReplyAfterEnd(upstreamPath);
  trusted = newKeyPair();
  sshHost = await startSshHost(trusted, upstreamPath);
});

afterAll(async () => {
  await sshHost.close();
  upstream.close();
  removeDir(dir);
});

describe("the SSH tunnel keeps a connection half open", () => {
  test("a client that ends its side still reads the whole reply, as an exec whose stdin closes does", async () => {
    const tunnel = new SshTunnel({
      user: "minibox",
      hostname: "127.0.0.1",
      port: sshHost.port,
      remoteSocket: upstreamPath,
      privateKey: trusted.privateKey,
      hostKeyFingerprint: sshHost.fingerprint,
    });
    try {
      await tunnel.connect();
      expect(await exchange(tunnel.socketPath, "ping")).toBe("got:ping");
      expect(await exchange(tunnel.socketPath, "again")).toBe("got:again");
    } finally {
      tunnel.close();
    }
  });
});
