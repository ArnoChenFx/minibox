import { api } from "./api.js";

/** Shared host-metrics poller. Pages subscribe; polling runs while anyone listens. */
const listeners = new Set();
let latest = null;
let timer = null;
let failing = false;

async function tick() {
  try {
    latest = await api("/api/host/metrics");
    failing = false;
  } catch {
    failing = true;
  }
  for (const fn of listeners) fn(latest, failing);
}

export function onHost(fn) {
  listeners.add(fn);
  if (latest) fn(latest, failing);
  if (!timer) {
    tick();
    timer = setInterval(tick, 3000);
  }
  return () => {
    listeners.delete(fn);
  };
}

export const hostNow = () => latest;
export const refreshHost = tick;

let templatesCache = null;
export async function getTemplates(force = false) {
  if (!templatesCache || force) templatesCache = (await api("/api/templates")).templates;
  return templatesCache;
}
export const invalidateTemplates = () => {
  templatesCache = null;
};
