import { api } from "./api.js";
import { pollWhileDown, subscribe } from "./live.js";

/** The longest host history kept in the page. The server keeps its own ring; this only bounds the client. */
const HISTORY_CAP = 720;
const POLL_MS = 3000;

/** Shared host metrics. Pages subscribe; `host` frames keep them current, and a poll runs only while the stream is down. */
const listeners = new Set();
let latest = null;
let failing = false;
let stopLive = null;

function notify() {
  for (const fn of listeners) fn(latest, failing);
}

async function tick() {
  try {
    latest = await api("/api/host/metrics");
    failing = false;
  } catch {
    failing = true;
  }
  notify();
}

function start() {
  const offFrames = subscribe("host", (frame) => {
    if (!latest) return;
    const history = frame.sample ? [...latest.history, frame.sample].slice(-HISTORY_CAP) : latest.history;
    latest = { ...frame.metrics, history };
    failing = false;
    notify();
  });
  const offPoll = pollWhileDown(tick, POLL_MS);
  void tick();
  stopLive = () => {
    offFrames();
    offPoll();
    stopLive = null;
  };
}

export function onHost(fn) {
  listeners.add(fn);
  if (latest) fn(latest, failing);
  if (!stopLive) start();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stopLive?.();
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
