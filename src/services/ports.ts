import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { DIR_MODE, writeFileAtomic } from "../data-dir";
import type { HostCtx } from "../host/registry";
import { AppError, badRequest } from "../lib/errors";
import { msg } from "../lib/messages";
import { previewLaunchPath } from "../preview/domain";
import { previewUrl } from "../preview/path";
import { type Box, getBox } from "./boxes";

export type PortSource = "listening" | "manual";

export interface BoxPort {
  readonly port: number;
  readonly source: PortSource;
  /**
   * Where the port opens, relative to the MiniBox origin. Path mode gives `/box/<name>/<port>/`. Subdomain mode gives
   * the console path that signs the browser into the port's own preview host, which then redirects there.
   */
  readonly url: string;
}

const MANUAL_FILE = "preview-ports.json";

/** Discovers listening TCP ports by reading `/proc/net/tcp{,6}` inside the box. */
const DISCOVER_SCRIPT = `python3 -c '
import pathlib
ports = set()
for path in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        lines = pathlib.Path(path).read_text().splitlines()[1:]
    except OSError:
        continue
    for line in lines:
        parts = line.split()
        if len(parts) < 4 or parts[3] != "0A":
            continue
        ports.add(int(parts[1].rsplit(":", 1)[1], 16))
print("\\n".join(str(p) for p in sorted(ports)))
'`;

function manualPath(host: HostCtx, boxId: string): string {
  // Sibling of the box spec file (`DATA_DIR/boxes/<id>.json`).
  return join(host.specs.dir(), `${boxId}.${MANUAL_FILE}`);
}

function readManual(host: HostCtx, boxId: string): number[] {
  try {
    const raw = JSON.parse(readFileSync(manualPath(host, boxId), "utf8")) as { ports?: unknown };
    if (!Array.isArray(raw.ports)) return [];
    return [
      ...new Set(
        raw.ports.filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535),
      ),
    ].toSorted((a, b) => a - b);
  } catch {
    return [];
  }
}

function writeManual(host: HostCtx, boxId: string, ports: number[]): void {
  mkdirSync(host.specs.dir(), { recursive: true, mode: DIR_MODE });
  if (ports.length === 0) {
    rmSync(manualPath(host, boxId), { force: true });
    return;
  }
  writeFileAtomic(
    manualPath(host, boxId),
    `${JSON.stringify({ ports: [...ports].toSorted((a, b) => a - b) }, null, 2)}\n`,
  );
}

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function discoverListening(host: HostCtx, box: Box): Promise<number[]> {
  if (!box.running) return [];
  const session = await host.runtime.startExec(box.id, {
    cmd: ["/bin/sh", "-c", DISCOVER_SCRIPT],
    env: [],
    workingDir: "/",
    user: "dev",
    tty: false,
  });
  const [stdout] = await Promise.all([readStream(session.stdout), readStream(session.stderr)]);
  const deadline = Date.now() + 5_000;
  let status = await session.inspect();
  while (status.running && Date.now() < deadline) {
    await Bun.sleep(50);
    status = await session.inspect();
  }
  if (status.running) {
    await session.kill().catch(() => {});
    return [];
  }
  if (status.exitCode !== 0) return [];
  return [
    ...new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => Number(line))
        .filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535),
    ),
  ].toSorted((a, b) => a - b);
}

function portUrl(box: Box, port: number, previewBaseDomain: string | null): string {
  return previewBaseDomain === null ? previewUrl(box.name || box.boxId, port) : previewLaunchPath(box.boxId, port);
}

function mergePorts(box: Box, listening: number[], manual: number[], previewBaseDomain: string | null): BoxPort[] {
  const out = new Map<number, BoxPort>();
  for (const port of listening) {
    out.set(port, { port, source: "listening", url: portUrl(box, port, previewBaseDomain) });
  }
  for (const port of manual) {
    if (out.has(port)) continue;
    out.set(port, { port, source: "manual", url: portUrl(box, port, previewBaseDomain) });
  }
  return [...out.values()].toSorted((a, b) => a.port - b.port);
}

/** Lists discovered listening ports plus manually exposed ones. */
export async function listBoxPorts(
  host: HostCtx,
  ref: string,
  previewBaseDomain: string | null = null,
): Promise<{ box: Box; ports: BoxPort[] }> {
  const box = await getBox(host, ref);
  const listening = await discoverListening(host, box);
  const manual = readManual(host, box.boxId);
  return { box, ports: mergePorts(box, listening, manual, previewBaseDomain) };
}

export function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest(msg("preview_port_invalid"));
  return port;
}

/** Remembers a port for one-click preview when automatic discovery misses it. */
export async function exposeBoxPort(
  host: HostCtx,
  ref: string,
  port: number,
  previewBaseDomain: string | null = null,
): Promise<{ box: Box; port: BoxPort }> {
  const box = await getBox(host, ref);
  const p = assertPort(port);
  const manual = new Set(readManual(host, box.boxId));
  manual.add(p);
  writeManual(host, box.boxId, [...manual]);
  return { box, port: { port: p, source: "manual", url: portUrl(box, p, previewBaseDomain) } };
}

/** Removes a manually exposed port. Listening ports keep appearing until the process stops. */
export async function unexposeBoxPort(host: HostCtx, ref: string, port: number): Promise<{ box: Box; port: number }> {
  const box = await getBox(host, ref);
  const p = assertPort(port);
  const manual = readManual(host, box.boxId);
  if (!manual.includes(p)) throw new AppError(404, "not_found", msg("preview_port_not_manual"));
  writeManual(
    host,
    box.boxId,
    manual.filter((x) => x !== p),
  );
  return { box, port: p };
}
