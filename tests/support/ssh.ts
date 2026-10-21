import { Duplex } from "node:stream";

import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

export interface SshOpened {
  readonly client: Client;
  readonly ws: WebSocket;
  /** Resolves with the close event of the WebSocket, which is how a test sees 1008 or a server-side end. */
  readonly closed: Promise<CloseEvent>;
}

/**
 * An ssh2 client whose bytes travel over a WebSocket, the way `minibox ssh-proxy` carries them. Every binary frame is a
 * chunk of the SSH stream, and the client's writes become binary frames.
 */
export function openSsh(url: string, headers: Record<string, string>, config: ConnectConfig): Promise<SshOpened> {
  const ws = new WebSocket(url, { headers });
  ws.binaryType = "arraybuffer";
  const transport = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      ws.send(chunk);
      callback();
    },
    final(callback) {
      ws.close(1000);
      callback();
    },
    destroy(error, callback) {
      ws.close();
      callback(error);
    },
  });
  ws.addEventListener("message", (event) => transport.push(Buffer.from(event.data as ArrayBuffer)));
  const closed = new Promise<CloseEvent>((resolve) => {
    ws.addEventListener("close", (event) => {
      transport.push(null);
      resolve(event);
    });
  });
  const client = new Client();
  return new Promise((resolve, reject) => {
    ws.addEventListener("error", () => reject(new Error("websocket failed before the ssh handshake")));
    client.on("error", (error: Error) => reject(error));
    client.on("ready", () => resolve({ client, ws, closed }));
    ws.addEventListener("open", () => client.connect({ ...config, sock: transport }));
  });
}

/** Runs one command and resolves with its stdout, stderr and exit status. */
export function runCommand(
  client: Client,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream: ClientChannel) => {
      if (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      let code: number | null = null;
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      stream.on("exit", (status: number | null) => {
        code = status;
      });
      stream.on("close", () => resolve({ stdout, stderr, code }));
    });
  });
}

/** Opens an interactive shell. ssh2 requests a pty by default, so `false` is what asks for none. */
export function openShell(client: Client, pty: boolean): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | undefined, channel: ClientChannel) => (error ? reject(error) : resolve(channel));
    client.shell(pty ? { term: "xterm-256color", cols: 80, rows: 24 } : false, done);
  });
}
