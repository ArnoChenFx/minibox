/** The host a box runs on. A box names its host only when the control plane holds more than one. */
export const hostOfBox = (box) => box.hostId ?? "local";

/** The host filter in the top bar shows only when the control plane holds more than one host. */
export const hostFilterShown = (hosts) => hosts.length > 1;

/** The access warning shows once a host other than this machine is held: the console then reaches more than one machine. */
export const accessWarningShown = (hosts) => hosts.some((host) => host.transport !== "local");

/** The boxes on one host, or every box when `host` is empty. */
export function boxesOnHost(boxes, host) {
  return host ? boxes.filter((box) => hostOfBox(box) === host) : boxes;
}

/** A box on a host that cannot be reached is listed with the state `unreachable`. */
export const isUnreachable = (box) => box.state === "unreachable";

/** Badge class for the status of a host, as /api/hosts reports it. */
export const HOST_BADGE = { online: "badge-success", offline: "badge-danger", unknown: "" };

/** A name as compared for uniqueness: Unicode NFC, trimmed and without its case, as the server compares it. */
const foldName = (name) => String(name).normalize("NFC").trim().toLowerCase();

/**
 * A host as a person reads it: its name, which is what the console shows. A name is unique on a host added since the rule
 * existed, but a hosts file written before it can still hold two hosts of one name, and the console must not draw those
 * identically. Only then is the id added beside the name, and the id is how every call addresses a host, so the label
 * stays unambiguous without turning a name into a key. A name is compared in Unicode NFC, trimmed and without its case,
 * as the server compares it when a host is added.
 */
export function hostLabel(host, hosts) {
  const name = host?.name ?? host?.id ?? "";
  const folded = foldName(name);
  const shared = hosts.some((other) => other.id !== host?.id && foldName(other.name ?? "") === folded);
  return shared ? `${name} · ${host.id}` : name;
}

/**
 * The listed host with this id, or null while the list does not name it yet: the console reads the hosts once at boot
 * and again every 15 seconds, so a page that opens first sees an empty list.
 */
export const listedHost = (hostId, hosts) => hosts.find((host) => host.id === hostId) ?? null;

/** The host a box runs on, as /api/hosts lists it, or null while that host is not in the list yet. It is the listed host,
 * agent or not: the two questions below read its transport. */
export const listedHostOfBox = (box, hosts) => listedHost(hostOfBox(box), hosts);

/**
 * Whether the box runs on an agent host. An agent runs boxes only: it holds no image and no helper, so the file browser,
 * checkpoints and port preview are all refused there. A host the list does not name yet is not called an agent.
 */
export const boxOnAgentHost = (box, hosts) => listedHostOfBox(box, hosts)?.transport === "agent";

/** Whether the host with this id is an agent host. Anything else, including a host the list does not name yet, is not. */
export const hostOnAgentTransport = (hostId, hosts) => listedHost(hostId, hosts)?.transport === "agent";

/** What an agent host's connection says, as one word: revoked, upgrade, online or offline. Null for any other host. */
export function agentState(agent) {
  if (!agent) return null;
  if (agent.revoked) return "revoked";
  if (agent.upgradeRequired) return "upgrade";
  return agent.connected ? "online" : "offline";
}
