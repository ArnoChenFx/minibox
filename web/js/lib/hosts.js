import { api } from "./api.js";
import { hostLabel } from "./host-list.js";

/** The hosts the control plane runs boxes on, and the host the top bar filters by ("" lists every host). */
const FILTER_KEY = "minibox.host";
const listeners = new Set();
let hosts = [];
let filter = readFilter();

function readFilter() {
  try {
    return localStorage.getItem(FILTER_KEY) ?? "";
  } catch {
    return "";
  }
}

const emit = () => {
  for (const listener of listeners) listener(hosts, filter);
};

export const hostsNow = () => hosts;
export const hostFilter = () => filter;
export const multiHost = () => hosts.length > 1;

/** A host's label, as the console shows it: its name, with its id when another host holds the same name. */
export const hostName = (id) => {
  const host = hosts.find((candidate) => candidate.id === id);
  return host ? hostLabel(host, hosts) : id;
};

/**
 * The name an activity entry shows for a host it is about: the host's label while it is listed, so a name two hosts share
 * reads with its id, or the name the entry recorded once the host is gone.
 */
export const hostTargetName = (target) =>
  hosts.some((host) => host.id === target.id) ? hostName(target.id) : (target.name ?? target.id ?? "");

export function setHostFilter(id) {
  filter = hosts.some((host) => host.id === id) ? id : "";
  try {
    localStorage.setItem(FILTER_KEY, filter);
  } catch {
    /* the filter still applies for this page view */
  }
  emit();
}

/** Calls `listener` now and on every change of the host list or the filter. Returns the unsubscribe. */
export function onHosts(listener) {
  listeners.add(listener);
  listener(hosts, filter);
  return () => listeners.delete(listener);
}

export async function refreshHosts() {
  let next;
  try {
    next = (await api("/api/hosts")).hosts;
  } catch {
    return;
  }
  hosts = next;
  if (filter && !hosts.some((host) => host.id === filter)) {
    filter = "";
    try {
      localStorage.removeItem(FILTER_KEY);
    } catch {
      /* nothing to clear when storage is unavailable */
    }
  }
  emit();
}
