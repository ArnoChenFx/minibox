import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, relative } from "node:path";

import { type AuthContext, type ParsedKey, type PublicKeyAuthContext, type SFTPWrapper, Server, utils } from "ssh2";

import { fingerprintOf } from "./ssh";

const { STATUS_CODE, OPEN_MODE } = utils.sftp;

export interface SftpDouble {
  readonly host: string;
  readonly port: number;
  /** The fingerprint the server presents, as `SHA256:…`. A target pins it. */
  readonly hostKeyFingerprint: string;
  /** The OpenSSH private key the server accepts. */
  readonly privateKey: string;
  /** The directory on disk the server serves. Its root is the login folder. */
  readonly root: string;
  /** Every SFTP request as `op path`, in order. */
  readonly requests: string[];
  close(): Promise<void>;
}

type Handle = { kind: "file"; fd: number } | { kind: "dir"; path: string; names: string[]; read: boolean };

function statusOf(e: unknown): number {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT") return STATUS_CODE.NO_SUCH_FILE;
  if (code === "EACCES" || code === "EPERM") return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function attrsOf(st: Stats) {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

/** The flags an SFTP open carries, as the POSIX flags Node opens a file with. */
function nodeFlags(flags: number): number {
  const write = (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND)) !== 0;
  let out = write ? ((flags & OPEN_MODE.READ) !== 0 ? constants.O_RDWR : constants.O_WRONLY) : constants.O_RDONLY;
  if (flags & OPEN_MODE.APPEND) out |= constants.O_APPEND;
  if (flags & OPEN_MODE.CREAT) out |= constants.O_CREAT;
  if (flags & OPEN_MODE.TRUNC) out |= constants.O_TRUNC;
  if (flags & OPEN_MODE.EXCL) out |= constants.O_EXCL;
  return out;
}

/**
 * Serves one directory over SFTP, the way an OpenSSH server does for a login folder: a rename never overwrites, and an
 * error is answered with the status code the protocol defines for it.
 */
function serveSftp(sftp: SFTPWrapper, root: string, requests: string[]): void {
  const handles = new Map<number, Handle>();
  let nextId = 1;
  const local = (remote: string): string => join(root, normalize(`/${remote}`));
  const remoteOf = (path: string): string => `/${relative(root, path)}`;
  const handleOf = (raw: Buffer): Handle | undefined => handles.get(raw.readUInt32BE(0));
  const issue = (reqid: number, handle: Handle): void => {
    const id = nextId++;
    handles.set(id, handle);
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(id, 0);
    sftp.handle(reqid, bytes);
  };
  const attempt = (reqid: number, run: () => void): void => {
    try {
      run();
    } catch (e) {
      sftp.status(reqid, statusOf(e));
    }
  };

  sftp.on("OPEN", (reqid: number, filename: string, flags: number) => {
    requests.push(`open ${filename}`);
    attempt(reqid, () => {
      const fd = openSync(local(filename), nodeFlags(flags), 0o600);
      issue(reqid, { kind: "file", fd });
    });
  });
  sftp.on("READ", (reqid: number, raw: Buffer, offset: number, length: number) => {
    const handle = handleOf(raw);
    if (handle?.kind !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
    attempt(reqid, () => {
      const buffer = Buffer.alloc(length);
      const read = readSync(handle.fd, buffer, 0, length, offset);
      if (read === 0) sftp.status(reqid, STATUS_CODE.EOF);
      else sftp.data(reqid, buffer.subarray(0, read));
    });
  });
  sftp.on("WRITE", (reqid: number, raw: Buffer, offset: number, data: Buffer) => {
    const handle = handleOf(raw);
    if (handle?.kind !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
    attempt(reqid, () => {
      writeSync(handle.fd, data, 0, data.length, offset);
      sftp.status(reqid, STATUS_CODE.OK);
    });
  });
  sftp.on("FSTAT", (reqid: number, raw: Buffer) => {
    const handle = handleOf(raw);
    if (handle?.kind !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
    attempt(reqid, () => sftp.attrs(reqid, attrsOf(fstatSync(handle.fd))));
  });
  sftp.on("CLOSE", (reqid: number, raw: Buffer) => {
    const id = raw.readUInt32BE(0);
    const handle = handles.get(id);
    if (handle?.kind === "file") closeSync(handle.fd);
    handles.delete(id);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  const stat = (reqid: number, path: string) => {
    requests.push(`stat ${path}`);
    attempt(reqid, () => sftp.attrs(reqid, attrsOf(statSync(local(path)))));
  };
  sftp.on("STAT", stat);
  sftp.on("LSTAT", stat);
  sftp.on("OPENDIR", (reqid: number, path: string) => {
    requests.push(`opendir ${path}`);
    attempt(reqid, () => {
      const dir = local(path);
      issue(reqid, { kind: "dir", path: dir, names: readdirSync(dir), read: false });
    });
  });
  sftp.on("READDIR", (reqid: number, raw: Buffer) => {
    const handle = handleOf(raw);
    if (handle?.kind !== "dir") return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (handle.read) return sftp.status(reqid, STATUS_CODE.EOF);
    handle.read = true;
    attempt(reqid, () => {
      const entries = handle.names.map((name) => ({
        filename: name,
        longname: name,
        attrs: attrsOf(lstatSync(join(handle.path, name))),
      }));
      sftp.name(reqid, entries);
    });
  });
  sftp.on("REALPATH", (reqid: number, path: string) => {
    attempt(reqid, () => {
      const resolved = remoteOf(local(path));
      sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: attrsOf(statSync(root)) }]);
    });
  });
  sftp.on("REMOVE", (reqid: number, path: string) => {
    requests.push(`remove ${path}`);
    attempt(reqid, () => {
      unlinkSync(local(path));
      sftp.status(reqid, STATUS_CODE.OK);
    });
  });
  sftp.on("RENAME", (reqid: number, from: string, to: string) => {
    requests.push(`rename ${from} ${to}`);
    attempt(reqid, () => {
      if (existsSync(local(to))) return sftp.status(reqid, STATUS_CODE.FAILURE);
      renameSync(local(from), local(to));
      sftp.status(reqid, STATUS_CODE.OK);
    });
  });
  sftp.on("MKDIR", (reqid: number, path: string) => {
    requests.push(`mkdir ${path}`);
    attempt(reqid, () => {
      mkdirSync(local(path));
      sftp.status(reqid, STATUS_CODE.OK);
    });
  });
  sftp.on("RMDIR", (reqid: number, path: string) => {
    attempt(reqid, () => {
      rmdirSync(local(path));
      sftp.status(reqid, STATUS_CODE.OK);
    });
  });
  sftp.on("SETSTAT", (reqid: number) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on("FSETSTAT", (reqid: number) => sftp.status(reqid, STATUS_CODE.OK));
}

/**
 * Accepts one login: the key must be the one the double was started with. The client's signature is checked too, so a
 * login that cannot prove it holds the private key is refused.
 */
function authenticate(expected: ParsedKey, ctx: AuthContext): void {
  if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
  const offered = ctx as PublicKeyAuthContext;
  if (offered.key.algo !== expected.type || !offered.key.data.equals(expected.getPublicSSH())) {
    return ctx.reject(["publickey"]);
  }
  if (!offered.signature || !offered.blob) return ctx.accept();
  if (expected.verify(offered.blob, offered.signature, offered.hashAlgo) !== true) return ctx.reject(["publickey"]);
  return ctx.accept();
}

/**
 * A new ed25519 private key in OpenSSH form. Under Bun, ssh2 sometimes writes a key whose public half lost a leading zero
 * byte, and then cannot read it back, so a key that does not parse is generated again.
 */
export function newEd25519Key(): string {
  for (;;) {
    const key = utils.generateKeyPairSync("ed25519").private;
    if (!(utils.parseKey(key) instanceof Error)) return key;
  }
}

/**
 * An SFTP server that serves a fresh temporary folder. Nothing outside the folder is reachable. It listens on loopback by
 * default; a Docker test binds the bridge gateway, so a container can reach it.
 */
export async function startSftpDouble(options: { host?: string } = {}): Promise<SftpDouble> {
  const host = options.host ?? "127.0.0.1";
  const hostKey = newEd25519Key();
  const clientPrivate = newEd25519Key();
  const clientKey = utils.parseKey(clientPrivate);
  if (clientKey instanceof Error) throw clientKey;
  const root = mkdtempSync(join(tmpdir(), "minibox-sftp-"));
  const requests: string[] = [];
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => authenticate(clientKey, ctx));
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => serveSftp(acceptSftp(), root, requests));
      });
    });
    client.on("error", () => {});
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("the SFTP double has no address"));
    });
  });
  const hostParsed = utils.parseKey(hostKey);
  if (hostParsed instanceof Error) throw hostParsed;
  return {
    host,
    port,
    hostKeyFingerprint: fingerprintOf(hostParsed.getPublicSSH()),
    privateKey: clientPrivate,
    root,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(root, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
