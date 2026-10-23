import { randomBytes } from "node:crypto";
import { lstat, readdir, stat, mkdir, rename, rm } from "node:fs/promises";
import { posix, join, resolve, basename } from "node:path";

import { request, type CliIo, serverOf, fail } from "./shared";

/** A `box:/path` argument names a path inside a box. Any other argument is a path on this machine. */
const BOX_PATH = /^([^/\\:]+):(\/.*)$/;

interface BoxPath {
  box: string;
  path: string;
}

/** The volume behind a path in a box, and the path inside that volume. */
interface VolumePath {
  volume: string;
  path: string;
}

/** An answer the server refused. The command prints its message and exits 1, as the other commands do. */
class ApiRefusal extends Error {
  constructor(
    readonly status: number,
    readonly json: unknown,
    readonly text: string,
  ) {
    super(`HTTP ${status}`);
  }
}

/** A transfer that cannot finish for a reason the caller can act on, such as a file already in the way. Exit 1. */
class CommandFailure extends Error {}

function boxPathOf(arg: string): BoxPath | null {
  const match = BOX_PATH.exec(arg);
  return match ? { box: match[1] ?? "", path: match[2] ?? "/" } : null;
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Finds the volume that backs a path in a box: the mount that holds the path most deeply. A file goes through the
 * file API by volume, so it works while the box is stopped.
 */
async function volumePathOf(env: Record<string, string | undefined>, ref: BoxPath): Promise<VolumePath> {
  const res = await request(env, "GET", `/api/boxes/${encodeURIComponent(ref.box)}`);
  if (res.status >= 400) throw new ApiRefusal(res.status, res.json, res.text);
  const mounts = (res.json as { box?: { mounts?: { path: string; volumeId: string | null }[] } } | null)?.box?.mounts;
  const abs = posix.normalize(ref.path).replace(/(.)\/+$/, "$1");
  let best: { root: string; volume: string } | null = null;
  for (const mount of mounts ?? []) {
    if (!mount.volumeId) continue;
    const root = posix.normalize(mount.path).replace(/(.)\/+$/, "$1");
    const holds = abs === root || abs.startsWith(root === "/" ? "/" : `${root}/`);
    if (holds && (best === null || root.length > best.root.length)) best = { root, volume: mount.volumeId };
  }
  if (best === null) throw new CommandFailure(`${ref.box} has no mounted volume at ${abs}`);
  const inside = abs.slice(best.root.length).replace(/^\/+/, "");
  return { volume: best.volume, path: inside === "" ? "/" : inside };
}

function childOf(dir: string, name: string): string {
  return dir === "/" ? name : `${dir}/${name}`;
}

/** The same join for the `box:/path` text a transfer prints. */
function childLabel(label: string, name: string): string {
  return label.endsWith("/") ? `${label}${name}` : `${label}/${name}`;
}

/** True when the path is a folder in its volume. A path that does not exist is not one. */
async function isRemoteFolder(env: Record<string, string | undefined>, target: VolumePath): Promise<boolean> {
  const query = new URLSearchParams({ path: target.path, maxDepth: "0", limit: "1" });
  const res = await request(env, "GET", `/api/volumes/${encodeURIComponent(target.volume)}/files?${query}`);
  if (res.status === 404) return false;
  if (res.status >= 400) throw new ApiRefusal(res.status, res.json, res.text);
  const entries = (res.json as { entries?: { type: string }[] } | null)?.entries ?? [];
  return entries[0]?.type === "dir";
}

async function makeRemoteDir(env: Record<string, string | undefined>, target: VolumePath): Promise<void> {
  const res = await request(env, "POST", `/api/volumes/${encodeURIComponent(target.volume)}/files/directory`, {
    path: target.path,
  });
  if (res.status >= 400) throw new ApiRefusal(res.status, res.json, res.text);
}

async function uploadFile(
  env: Record<string, string | undefined>,
  io: CliIo,
  local: string,
  size: number,
  target: VolumePath,
  label: string,
  overwrite: boolean,
): Promise<void> {
  const { base, headers } = serverOf(env);
  const query = new URLSearchParams({ path: target.path, overwrite: String(overwrite) });
  const res = await fetch(`${base}/api/volumes/${encodeURIComponent(target.volume)}/files/stream?${query}`, {
    method: "PUT",
    // The server takes the length from Content-Length and streams the body, so it is sent from the file as it is read.
    headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(size) },
    body: Bun.file(local),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiRefusal(res.status, parseJson(text), text);
  io.stdout(`${local} -> ${label}\n`);
}

/** Uploads a file, or a folder with its tree. Symbolic links are skipped, not followed, so nothing outside the folder is sent. */
async function uploadTree(
  env: Record<string, string | undefined>,
  io: CliIo,
  local: string,
  target: VolumePath,
  label: string,
  overwrite: boolean,
): Promise<void> {
  const info = await lstat(local);
  if (info.isSymbolicLink()) {
    io.stderr(`skipped ${local}: a symbolic link is not followed\n`);
    return;
  }
  if (info.isDirectory()) {
    await makeRemoteDir(env, target);
    for (const name of (await readdir(local)).toSorted()) {
      const child = { volume: target.volume, path: childOf(target.path, name) };
      await uploadTree(env, io, join(local, name), child, childLabel(label, name), overwrite);
    }
    return;
  }
  if (!info.isFile()) {
    io.stderr(`skipped ${local}: not a file or a folder\n`);
    return;
  }
  await uploadFile(env, io, local, info.size, target, label, overwrite);
}

/** The file name the server gives a download, from its Content-Disposition, reduced to its last segment. */
function downloadNameOf(header: string | null): string {
  let name: string | null = null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header ?? "");
  const plain = /filename="([^"]*)"/i.exec(header ?? "");
  try {
    name = encoded?.[1] ? decodeURIComponent(encoded[1]) : (plain?.[1] ?? null);
  } catch {
    name = null;
  }
  const last = posix.basename((name ?? "").replace(/\\/g, "/"));
  return last === "" || last === "." || last === ".." ? "download" : last;
}

async function downloadTo(
  env: Record<string, string | undefined>,
  io: CliIo,
  remote: BoxPath,
  local: string | null,
  overwrite: boolean,
): Promise<void> {
  const target = await volumePathOf(env, remote);
  const { base, headers } = serverOf(env);
  const query = new URLSearchParams({ path: target.path });
  const res = await fetch(`${base}/api/volumes/${encodeURIComponent(target.volume)}/files/stream?${query}`, {
    headers: { ...headers, accept: "*/*" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiRefusal(res.status, parseJson(text), text);
  }
  const name = downloadNameOf(res.headers.get("content-disposition"));
  const given = local ?? ".";
  const directory = /[\\/]$/.test(given) || (await stat(given).catch(() => null))?.isDirectory() === true;
  if (directory) await mkdir(given, { recursive: true });
  const dest = directory ? join(given, name) : resolve(given);
  if (!overwrite && (await stat(dest).catch(() => null)) !== null) {
    await res.body?.cancel();
    throw new CommandFailure(`${dest} already exists. Pass --overwrite to replace it.`);
  }
  // Written under a temporary name and renamed once complete, so a cut-short download never looks finished.
  const part = `${dest}.${randomBytes(6).toString("hex")}.part`;
  try {
    await Bun.write(part, res);
    await rename(part, dest);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
  io.stdout(`${remote.box}:${remote.path} -> ${dest}\n`);
}

async function uploadTo(
  env: Record<string, string | undefined>,
  io: CliIo,
  locals: string[],
  remote: BoxPath,
  overwrite: boolean,
): Promise<void> {
  for (const local of locals) {
    if (boxPathOf(local)) throw new Error(`${local} names a path in a box. Upload takes paths on this machine.`);
  }
  const dest = await volumePathOf(env, remote);
  const label = `${remote.box}:${remote.path}`;
  const intoFolder = remote.path.endsWith("/") || locals.length > 1 || (await isRemoteFolder(env, dest));
  if (!intoFolder) {
    for (const local of locals) await uploadTree(env, io, resolve(local), dest, label, overwrite);
    return;
  }
  await makeRemoteDir(env, dest);
  for (const local of locals) {
    const from = resolve(local);
    const name = basename(from);
    const child = { volume: dest.volume, path: childOf(dest.path, name) };
    await uploadTree(env, io, from, child, childLabel(label, name), overwrite);
  }
}

/** `upload`, `download` and `cp` move files between this machine and a box. `box:/path` names a path inside a box. */
export async function transferCommand(
  command: "cp" | "upload" | "download",
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const overwrite = argv.includes("--overwrite");
  const args = argv.filter((arg) => arg !== "--overwrite");
  const unknown = args.find((arg) => arg.startsWith("--"));
  if (unknown !== undefined) throw new Error(`Unknown option ${unknown}`);
  try {
    const first = boxPathOf(args[0] ?? "");
    const last = args.at(-1) ?? "";
    const remoteLast = boxPathOf(last);
    if (command === "download") {
      if (first === null || args.length > 2) {
        throw new Error("minibox download needs a box:/path and an optional local path");
      }
      await downloadTo(env, io, first, args[1] ?? null, overwrite);
    } else if (command === "upload") {
      if (args.length < 2 || remoteLast === null) {
        throw new Error("minibox upload needs one or more local paths and a box:/path last");
      }
      await uploadTo(env, io, args.slice(0, -1), remoteLast, overwrite);
    } else if (remoteLast !== null && args.length >= 2) {
      await uploadTo(env, io, args.slice(0, -1), remoteLast, overwrite);
    } else if (first !== null && args.length === 2) {
      await downloadTo(env, io, first, last, overwrite);
    } else {
      throw new Error("minibox cp needs a box:/path on one side and a path on this machine on the other");
    }
    return 0;
  } catch (e) {
    if (e instanceof ApiRefusal) return fail(io, e.status, e.json, e.text);
    if (e instanceof CommandFailure) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
