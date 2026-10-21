import { dirname } from "node:path";

import type { HostCtx } from "../host/registry";
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { TaskHandle } from "../tasks/types";
import { findCatalogEntry, loadCatalog, requireCatalogEntry } from "../tools/catalog";
import { commandFor, resolveToolVersion } from "../tools/commands";
import { detectScript, parseDetectOutput, type DetectResult } from "../tools/detect";
import { TOOLS_PREFIX, type CatalogEntry, type ToolAction, type ToolStatus } from "../tools/types";
import { findSharedTools } from "../volumes/engine";
import { poolForRole } from "../volumes/pools";
import { getBox, type Box } from "./boxes";

const WRITER_MEMORY = 1024 * 1024 * 1024;
const WRITER_PIDS = 256;
const WRITER_TIMEOUT_SEC = 900;
const DETECT_TIMEOUT_SEC = 300;

/** Proxy and package-manager env forwarded into the tools writer when the host process has them. */
export function installEnv(): string[] {
  const names = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "ALL_PROXY",
    "all_proxy",
  ];
  const env: string[] = [
    `PATH=${TOOLS_PREFIX}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `NPM_CONFIG_PREFIX=${TOOLS_PREFIX}`,
    `npm_config_cache=/tmp/npm-cache`,
    `PIP_CACHE_DIR=/tmp/pip-cache`,
    "HOME=/tmp",
  ];
  for (const name of names) {
    const value = process.env[name];
    if (value) env.push(`${name}=${value}`);
  }
  return env;
}

function sharedToolsEngine(host: HostCtx): string | null {
  const pool = poolForRole(host.volumes.readPools(), "tools");
  return findSharedTools(host, pool.name)?.engineName ?? null;
}

async function runToolsWriter(
  host: HostCtx,
  opts: { cmd: string[]; task?: TaskHandle },
): Promise<{ exitCode: number; logs: string }> {
  const engine = sharedToolsEngine(host);
  if (!engine) throw badRequest(msg("tool_volume_missing"));
  const image = host.baseTemplateTag;
  try {
    await host.runtime.inspectImage(image);
  } catch {
    throw badRequest(msg("helper_image_missing", { image }));
  }
  opts.task?.log(`Using tools volume ${engine} (read-write)\n`);
  const result = await host.runtime.runHelper({
    image,
    user: "1000:1000",
    cmd: opts.cmd,
    mounts: [{ source: engine, target: TOOLS_PREFIX, mode: "rw" }],
    env: installEnv(),
    network: true,
    readonlyRoot: false,
    memoryBytes: WRITER_MEMORY,
    pidsLimit: WRITER_PIDS,
    timeoutSec: WRITER_TIMEOUT_SEC,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.logs) opts.task?.log(result.logs.endsWith("\n") ? result.logs : `${result.logs}\n`);
  return result;
}

interface DetectTarget {
  image: string;
  mounts: { source: string; target: string; mode: "ro" }[];
}

/**
 * Where detection runs. With a box, that is the box's own image with the box's home volume and the shared tools volume
 * mounted read-only, so a tool baked into the image or installed in the home volume is found the way the box finds it.
 * Without a box, the base template stands in for the image.
 */
async function detectTarget(host: HostCtx, box: Box | null): Promise<DetectTarget> {
  const mounts: DetectTarget["mounts"] = [];
  const engine = sharedToolsEngine(host);
  if (engine) mounts.push({ source: engine, target: TOOLS_PREFIX, mode: "ro" });
  let image = host.baseTemplateTag;
  if (box) {
    const home = box.mounts.find((mount) => mount.role === "home");
    if (home) mounts.push({ source: home.volume, target: home.path, mode: "ro" });
    if (box.image && (await imageExists(host, box.image))) image = box.image;
  }
  return { image, mounts };
}

async function imageExists(host: HostCtx, ref: string): Promise<boolean> {
  try {
    await host.runtime.inspectImage(ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the detect command of each entry in one helper. An entry the helper does not answer for is reported as not
 * installed; a helper failure is logged and leaves every entry not installed rather than failing the request.
 */
export async function detectTools(
  host: HostCtx,
  entries: CatalogEntry[],
  box: Box | null,
): Promise<Map<string, DetectResult>> {
  if (entries.length === 0) return new Map();
  try {
    const target = await detectTarget(host, box);
    const result = await host.runtime.runHelper({
      image: target.image,
      user: "1000:1000",
      cmd: ["sh", "-c", detectScript(entries)],
      mounts: target.mounts,
      network: false,
      timeoutSec: DETECT_TIMEOUT_SEC,
      labels: { [host.keys.internal]: "true" },
    });
    return parseDetectOutput(result.logs);
  } catch (e) {
    log.warn("tool.detect_failed", { boxId: box?.boxId ?? null, error: String(e) });
    return new Map();
  }
}

function statusOf(entry: CatalogEntry, desiredVersion: string | null, found: DetectResult | undefined): ToolStatus {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    source: entry.source,
    package: entry.package,
    bin: entry.bin,
    estimatedMb: entry.estimatedMb,
    requires: entry.requires ?? null,
    needsRoot: entry.needsRoot,
    desiredVersion,
    installed: found?.installed ?? false,
    installedVersion: found?.installedVersion ?? null,
    managed: found?.managed ?? false,
  };
}

export async function listToolStatuses(host: HostCtx, boxRef?: string): Promise<ToolStatus[]> {
  const catalog = loadCatalog(dirname(host.specs.dir()));
  const box = boxRef ? await getBox(host, boxRef) : null;
  const desired = new Map<string, string>();
  for (const tool of (box && host.specs.read(box.boxId)?.tools) || []) desired.set(tool.id, tool.version);
  const found = await detectTools(host, catalog, box);
  return catalog.map((entry) => statusOf(entry, desired.get(entry.id) ?? null, found.get(entry.id)));
}

function setDesiredTool(host: HostCtx, boxId: string, id: string, version: string | null): void {
  const spec = host.specs.read(boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  const rest = spec.tools.filter((tool) => tool.id !== id);
  const tools = (version === null ? rest : [...rest, { id, version }]).toSorted((a, b) => a.id.localeCompare(b.id));
  host.specs.write({
    ...spec,
    tools,
    revision: spec.revision + 1,
    updatedAt: new Date().toISOString(),
  });
}

async function runAction(
  host: HostCtx,
  boxRef: string,
  toolId: string,
  action: ToolAction,
  version: string,
  task?: TaskHandle,
): Promise<{ id: string; version: string; installedVersion: string | null }> {
  const box = await getBox(host, boxRef);
  const catalog = loadCatalog(dirname(host.specs.dir()));
  const entry = requireCatalogEntry(catalog, toolId);
  const resolvedVersion = resolveToolVersion(entry, version);
  if (action !== "install") {
    const current = (await detectTools(host, [entry], box)).get(entry.id);
    if (current?.installed && !current.managed) throw badRequest(msg("tool_unmanaged", { id: toolId }));
  }
  const shell = commandFor(entry, action, resolvedVersion);
  task?.log(`${action} ${entry.id}@${resolvedVersion}\n$ ${shell}\n`);
  const result = await runToolsWriter(host, { cmd: ["sh", "-c", shell], task });
  if (result.exitCode === 124) throw conflict(msg("tool_install_timeout", { id: toolId }));
  if (result.exitCode !== 0) {
    throw badRequest(
      msg("tool_install_failed", {
        id: toolId,
        detail: result.logs.trim().slice(0, 400) || String(result.exitCode),
      }),
    );
  }
  if (action === "uninstall") {
    await host.specs.exclusive(async () => setDesiredTool(host, box.boxId, toolId, null));
  } else {
    await host.specs.exclusive(async () => setDesiredTool(host, box.boxId, toolId, resolvedVersion));
  }
  if (action === "uninstall") return { id: toolId, version: resolvedVersion, installedVersion: null };
  const found = await detectTools(host, [entry], box);
  return { id: toolId, version: resolvedVersion, installedVersion: found.get(entry.id)?.installedVersion ?? null };
}

export function installTool(
  host: HostCtx,
  boxRef: string,
  toolId: string,
  version: string,
  task?: TaskHandle,
): Promise<{ id: string; version: string; installedVersion: string | null }> {
  return runAction(host, boxRef, toolId, "install", version, task);
}

export function upgradeTool(
  host: HostCtx,
  boxRef: string,
  toolId: string,
  version: string,
  task?: TaskHandle,
): Promise<{ id: string; version: string; installedVersion: string | null }> {
  return runAction(host, boxRef, toolId, "upgrade", version || "latest", task);
}

export function uninstallTool(
  host: HostCtx,
  boxRef: string,
  toolId: string,
  task?: TaskHandle,
): Promise<{ id: string; version: string; installedVersion: string | null }> {
  return runAction(host, boxRef, toolId, "uninstall", "latest", task);
}

/**
 * Idempotent reconcile: install every desired tool the box does not already have. Detection uses the box's own image
 * and home volume, so a tool baked into the image is skipped. Upgrade is not implied.
 */
export async function reconcileTools(
  host: HostCtx,
  boxRef: string,
  task?: TaskHandle,
): Promise<{ installed: string[]; skipped: string[]; failed: { id: string; detail: string }[] }> {
  const box = await getBox(host, boxRef);
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  const catalog = loadCatalog(dirname(host.specs.dir()));
  const installed: string[] = [];
  const skipped: string[] = [];
  const failed: { id: string; detail: string }[] = [];
  const entries = spec.tools.flatMap((desired) => {
    const entry = findCatalogEntry(catalog, desired.id);
    return entry ? [entry] : [];
  });
  const found = await detectTools(host, entries, box);
  for (const desired of spec.tools) {
    if (task?.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const entry = findCatalogEntry(catalog, desired.id);
    if (!entry) {
      failed.push({ id: desired.id, detail: "unknown catalog id" });
      task?.log(`skip unknown tool ${desired.id}\n`);
      continue;
    }
    const current = found.get(entry.id);
    if (current?.installed) {
      skipped.push(desired.id);
      task?.log(
        `ok ${desired.id} already present${current.installedVersion ? ` (${current.installedVersion})` : ""}\n`,
      );
      continue;
    }
    try {
      await runAction(host, box.boxId, desired.id, "install", desired.version, task);
      installed.push(desired.id);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      failed.push({ id: desired.id, detail });
      task?.log(`failed ${desired.id}: ${detail}\n`);
    }
  }
  if (failed.length && installed.length === 0 && skipped.length === 0) {
    throw badRequest(msg("tool_reconcile_failed", { detail: failed.map((item) => item.id).join(", ") }));
  }
  return { installed, skipped, failed };
}

/** After create/rebuild: record desired tools on the spec (create path) without installing yet. */
export function desiredToolsOf(ids: string[] | undefined, catalog: CatalogEntry[]): { id: string; version: string }[] {
  if (!ids?.length) return [];
  if (ids.length > 32) throw badRequest(msg("tool_ids_invalid"));
  const seen = new Set<string>();
  const out: { id: string; version: string }[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) throw badRequest(msg("tool_ids_invalid"));
    requireCatalogEntry(catalog, id);
    seen.add(id);
    out.push({ id, version: "latest" });
  }
  return out;
}
