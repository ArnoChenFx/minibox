import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { Readable } from "node:stream";

import type { Client, SFTPWrapper, Stats } from "ssh2";

import { connectClient } from "../host/ssh";
import { classifyFailure, isMissing, TargetFailure } from "./errors";
import type { RemoteObject, SftpConnection, TargetSession } from "./session";

const ROOT = ".";
/** Bytes per SFTP write request. Each request is one packet, so a large chunk is sent in slices this size. */
const WRITE_SLICE = 32 * 1024;

type Done<T> = (err: Error | null | undefined, value?: T) => void;

function call<T>(run: (done: Done<T>) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    run((err, value) => (err ? reject(err) : resolve(value as T)));
  });
}

function toObject(name: string, attrs: Stats): RemoteObject {
  return { name, bytes: attrs.size, modifiedAt: new Date(attrs.mtime * 1000).toISOString() };
}

/** Writes one object under a new name, through explicit open, write and close requests, so the bytes are on the server before the caller renames it. */
async function writeObject(sftp: SFTPWrapper, path: string, body: AsyncIterable<Uint8Array>): Promise<void> {
  const handle = await call<Buffer>((done) => sftp.open(path, "w", { mode: 0o600 }, done));
  let offset = 0;
  let failure: unknown = null;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (let start = 0; start < bytes.length; start += WRITE_SLICE) {
        const slice = bytes.subarray(start, Math.min(start + WRITE_SLICE, bytes.length));
        await call<void>((done) => sftp.write(handle, slice, 0, slice.length, offset, done));
        offset += slice.length;
      }
    }
  } catch (e) {
    failure = e;
  }
  try {
    await call<void>((done) => sftp.close(handle, done));
  } catch (e) {
    failure ??= e;
  }
  if (failure !== null) throw failure;
}

/**
 * A folder on an SFTP server. The connection pins the server's host key, and the login uses a private key. A write goes to
 * a temporary name and is renamed into place once it is complete, so a reader sees the whole object or none of it.
 */
export async function openSftpSession(conn: SftpConnection): Promise<TargetSession> {
  const client = await connect(conn);
  let sftp: SFTPWrapper;
  try {
    sftp = await sftpOf(client);
  } catch (e) {
    client.end();
    throw e;
  }
  const root = conn.path === "" ? ROOT : conn.path;
  const at = (name: string) => (root === ROOT ? name : `${root}/${name}`);

  const statPath = async (path: string): Promise<Stats | null> => {
    try {
      return await call<Stats>((done) => sftp.stat(path, done));
    } catch (e) {
      if (isMissing(e)) return null;
      throw classifyFailure(e);
    }
  };

  const mkdirp = async (dir: string): Promise<void> => {
    const absolute = dir.startsWith("/");
    let current = "";
    for (const segment of dir.split("/")) {
      if (segment === "" || segment === ROOT) continue;
      current = current === "" ? (absolute ? `/${segment}` : segment) : `${current}/${segment}`;
      const found = await statPath(current);
      if (found === null) {
        await call<void>((done) => sftp.mkdir(current, done));
      } else if (!found.isDirectory()) {
        throw new TargetFailure("failed", `${current} is a file, not a folder`);
      }
    }
  };

  const unlinkQuietly = async (path: string): Promise<void> => {
    await call<void>((done) => sftp.unlink(path, done)).catch(() => undefined);
  };

  return {
    async probe() {
      try {
        const found = await statPath(root);
        if (found === null) return;
        if (!found.isDirectory()) throw new TargetFailure("failed", `${root} is a file, not a folder`);
        await call<unknown>((done) => sftp.readdir(root, done));
      } catch (e) {
        throw classifyFailure(e);
      }
    },

    async list(folder) {
      try {
        const entries = await call<{ filename: string; attrs: Stats }[]>((done) => sftp.readdir(at(folder), done));
        return entries
          .filter((entry) => entry.attrs.isFile())
          .map((entry) => toObject(`${folder}/${entry.filename}`, entry.attrs));
      } catch (e) {
        if (isMissing(e)) return [];
        throw classifyFailure(e);
      }
    },

    async stat(name) {
      const attrs = await statPath(at(name));
      return attrs === null || !attrs.isFile() ? null : toObject(name, attrs);
    },

    async read(name) {
      const attrs = await statPath(at(name));
      if (attrs === null || !attrs.isFile()) throw new TargetFailure("missing", name);
      return chunksOf(sftp.createReadStream(at(name)));
    },

    async write(name, body) {
      const target = at(name);
      const part = `${target}.${randomBytes(6).toString("hex")}.part`;
      try {
        await mkdirp(dirname(target));
        await writeObject(sftp, part, body);
        await unlinkQuietly(target);
        await call<void>((done) => sftp.rename(part, target, done));
      } catch (e) {
        await unlinkQuietly(part);
        throw classifyFailure(e);
      }
    },

    async close() {
      client.end();
    },
  };
}

async function connect(conn: SftpConnection): Promise<Client> {
  try {
    return await connectClient({
      user: conn.user,
      hostname: conn.host,
      port: conn.port,
      privateKey: conn.privateKey,
      hostKeyFingerprint: conn.hostKeyFingerprint,
    });
  } catch (e) {
    throw classifyFailure(e);
  }
}

async function sftpOf(client: Client): Promise<SFTPWrapper> {
  try {
    return await new Promise<SFTPWrapper>((resolve, reject) =>
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))),
    );
  } catch (e) {
    throw classifyFailure(e);
  }
}

/** The chunks of a readable stream. A read that fails midway is classified, and a consumer that stops early closes it. */
async function* chunksOf(stream: Readable): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of stream) yield chunk as Buffer;
  } catch (e) {
    throw classifyFailure(e);
  } finally {
    stream.destroy();
  }
}
