import { join } from "node:path";

import type { HostCtx } from "../host/registry";
import { badRequest } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { isRuntimeError } from "../runtime";

export const BASE_DESCRIPTION = "Debian 12 · Node.js 26 · Python 3 · git · tmux · build-essential · non-root dev user";

interface BuildProgress {
  readonly signal?: AbortSignal;
  log?(text: string): void;
}

interface Inflight {
  promise: Promise<{ ref: string; output: string }>;
  listeners: Set<(text: string) => void>;
}

/** Builds in flight, by engine and tag, so callers that need the base image at the same time share one build. */
const inflight = new WeakMap<object, Map<string, Inflight>>();

/**
 * Builds the bundled base template from templates/base/Dockerfile. A build already running on the same engine for the
 * same tag is joined, and its log goes to every caller. The first caller's signal cancels it.
 */
export function buildBaseTemplate(host: HostCtx, progress?: BuildProgress): Promise<{ ref: string; output: string }> {
  let builds = inflight.get(host.runtime);
  if (!builds) {
    builds = new Map();
    inflight.set(host.runtime, builds);
  }
  const tag = host.baseTemplateTag;
  const running = builds.get(tag);
  if (running) {
    const listener = progress?.log?.bind(progress);
    if (listener) running.listeners.add(listener);
    return running.promise.finally(() => {
      if (listener) running.listeners.delete(listener);
    });
  }
  const listeners = new Set<(text: string) => void>();
  if (progress?.log) listeners.add(progress.log.bind(progress));
  const k = host.keys;
  const promise = (async () => {
    const output = await host.runtime.buildImage({
      contextDir: join(host.templatesDir, "base"),
      dockerfile: "Dockerfile",
      tag,
      labels: { [k.template]: "true", [k.templateName]: "base", [k.templateDesc]: BASE_DESCRIPTION },
      onLog: (chunk) => {
        for (const listener of listeners) listener(chunk);
      },
      signal: progress?.signal,
    });
    log.info("template.built", { ref: tag });
    return { ref: tag, output };
  })().finally(() => builds.delete(tag));
  builds.set(tag, { promise, listeners });
  return promise;
}

/** Whether the host holds the base template. Errors other than a missing image are the caller's. */
export async function hasBaseImage(host: HostCtx): Promise<boolean> {
  try {
    await host.runtime.inspectImage(host.baseTemplateTag);
    return true;
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return false;
    throw e;
  }
}

/**
 * The base template's tag, built first when the host lacks it. Helpers for volumes, tools, clones and the egress proxy
 * run on it whatever template a box uses, so a host that has only an official template still gets it on first need.
 * An agent host cannot build, so there it stays an error until the template is copied over.
 */
export async function ensureBaseImage(host: HostCtx, progress?: { log?(text: string): void }): Promise<string> {
  const image = host.baseTemplateTag;
  if (await hasBaseImage(host)) return image;
  if (host.host.transport === "agent") throw badRequest(msg("helper_image_missing", { image }));
  progress?.log?.(`Base template ${image} is missing; building it from templates/base…\n`);
  log.info("template.base_building", { host: host.host.id, ref: image });
  try {
    await buildBaseTemplate(host, progress);
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).trim().slice(0, 400);
    log.warn("template.base_build_failed", { host: host.host.id, ref: image, error: detail });
    throw badRequest(msg("helper_image_build_failed", { image, detail }));
  }
  return image;
}
