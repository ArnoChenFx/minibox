import { dirname } from "node:path";

import type { HostCtx } from "../host/registry";
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { TaskHandle } from "../tasks/types";
import { findCatalogEntry, loadCatalog, requireCatalogEntry } from "../tools/catalog";
import { commandFor, detectCommand } from "../tools/commands";
import { TOOLS_BIN, TOOLS_PREFIX, type CatalogEntry, type ToolAction, type ToolStatus } from "../tools/types";
import { findSharedTools } from "../volumes/engine";
import { poolForRole } from "../volumes/pools";
import { getBox } from "./boxes";

const WRITER_MEMORY = 1024 * 1024 * 1024;
const WRITER_PIDS = 256;
const WRITER_TIMEOUT_SEC = 900;
const DETECT_TIMEOUT_SEC = 30;

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
    `PATH=${TOOLS_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
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

function toolsVolume(host: HostCtx): { engine: string } {
  const pool = poolForRole(host.volumes.readPools(), "tools");
  const record = findSharedTools(host, pool.name);
  if (!record) throw badRequest(msg("tool_volume_missing"));
  return { engine: record.engineName };
}

async function runToolsHelper(
  host: HostCtx,
  opts: {
    cmd: string[];
    write: boolean;
    task?: TaskHandle;
    timeoutSec?: number;
  },
): Promise<{ exitCode: number; logs: string }> {
  const volume = toolsVolume(host);
  const image = host.baseTemplateTag;
  try {
    await host.runtime.inspectImage(image);
  } catch {
    throw badRequest(msg("helper_image_missing", { image }));
  }
  opts.task?.log(`Using tools volume ${volume.engine} (${opts.write ? "read-write" : "read-only"})\n`);
  const result = await host.runtime.runHelper({
    image,
    user: "1000:1000",
    cmd: opts.cmd,
    mounts: [{ source: volume.engine, target: TOOLS_PREFIX, mode: opts.write ? "rw" : "ro" }],
    env: installEnv(),
    network: opts.write,
    readonlyRoot: false,
    memoryBytes: opts.write ? WRITER_MEMORY : undefined,
    pidsLimit: opts.write ? WRITER_PIDS : undefined,
    timeoutSec: opts.timeoutSec ?? (opts.write ? WRITER_TIMEOUT_SEC : DETECT_TIMEOUT_SEC),
    labels: { [host.keys.internal]: "true" },
  });
  if (result.logs) opts.task?.log(result.logs.endsWith("\n") ? result.logs : `${result.logs}\n`);
  return result;
}

async function detectVersion(host: HostCtx, entry: CatalogEntry): Promise<string | null> {
  const script = [`export PATH="${TOOLS_BIN}:$PATH"`, detectCommand(entry)].join("\n");
  const result = await runToolsHelper(host, {
    cmd: ["sh", "-c", script],
    write: false,
    timeoutSec: DETECT_TIMEOUT_SEC,
  });
  if (result.exitCode !== 0) return null;
  const line = result.logs
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? null;
}

export async function listToolStatuses(host: HostCtx, boxRef?: string): Promise<ToolStatus[]> {
  const catalog = loadCatalog(dirname(host.specs.dir()));
  const desired = new Map<string, string>();
  if (boxRef) {
    const box = await getBox(host, boxRef);
    const spec = host.specs.read(box.boxId);
    for (const tool of spec?.tools ?? []) desired.set(tool.id, tool.version);
  }
  const out: ToolStatus[] = [];
  for (const entry of catalog) {
    let installedVersion: string | null = null;
    let installed = false;
    try {
      installedVersion = await detectVersion(host, entry);
      installed = installedVersion !== null;
    } catch (e) {
      log.warn("tool.detect_failed", { id: entry.id, error: String(e) });
    }
    out.push({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      source: entry.source,
      package: entry.package,
      bin: entry.bin,
      estimatedMb: entry.estimatedMb,
      requires: entry.requires ?? null,
      desiredVersion: desired.get(entry.id) ?? null,
      installed,
      installedVersion,
    });
  }
  return out;
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
  const resolvedVersion = version.trim() || "latest";
  const shell = commandFor(entry, action, resolvedVersion);
  task?.log(`${action} ${entry.id}@${resolvedVersion}\n$ ${shell}\n`);
  const result = await runToolsHelper(host, {
    cmd: ["sh", "-c", shell],
    write: true,
    task,
  });
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
  const installedVersion = action === "uninstall" ? null : await detectVersion(host, entry);
  return { id: toolId, version: resolvedVersion, installedVersion };
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
 * Idempotent reconcile: install every desired tool that detect does not find.
 * Upgrade is not implied; missing tools are installed at the desired version.
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
  for (const desired of spec.tools) {
    if (task?.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const entry = findCatalogEntry(catalog, desired.id);
    if (!entry) {
      failed.push({ id: desired.id, detail: "unknown catalog id" });
      task?.log(`skip unknown tool ${desired.id}\n`);
      continue;
    }
    const current = await detectVersion(host, entry);
    if (current !== null) {
      skipped.push(desired.id);
      task?.log(`ok ${desired.id} already present (${current})\n`);
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
