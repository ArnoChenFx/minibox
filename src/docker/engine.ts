import type Docker from "dockerode";

import { isAbortError } from "../lib/abort";
import type { ContainerInfo } from "../runtime";
import { toRuntimeError } from "./errors";

/**
 * What the resource modules share: the engine client, the container inspects that `listContainers` reuses, and
 * `mutate`, which every change made through the adapter goes through. A change clears the inspects, and bumps
 * `changes` so that an inspect started before the change is not stored.
 */
export interface Engine {
  docker: Docker;
  inspected: Map<string, { state: string; at: number; info: ContainerInfo }>;
  changes: number;
  mutate: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function createEngine(docker: Docker): Engine {
  const engine: Engine = {
    docker,
    inspected: new Map(),
    changes: 0,
    mutate: async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await call(fn);
      } finally {
        engine.changes += 1;
        engine.inspected.clear();
      }
    },
  };
  return engine;
}

/** Engine errors become RuntimeError. Cancellation stays an AbortError so a task is not reported as a Docker failure. */
export async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw toRuntimeError(e);
  }
}

/** Starting a running container, or stopping a stopped one, is a no-op rather than an error. */
export async function ignore304(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 304) throw e;
  }
}

export const labelFilter = (labels: Record<string, string>) => Object.entries(labels).map(([k, v]) => `${k}=${v}`);

/**
 * dockerode's typings omit `abortSignal`, which dockerode and docker-modem forward to the request. The key is left out
 * when there is no signal, or the query string would carry `abortSignal=`.
 */
export function withSignal<T extends object>(options: T, signal: AbortSignal | undefined): T {
  return signal ? ({ ...options, abortSignal: signal } as T) : options;
}

/** Resolves with the value, or with undefined when `ms` passes first. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
