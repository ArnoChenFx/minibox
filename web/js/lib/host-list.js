/** The host a box runs on. A box names its host only when the control plane holds more than one. */
export const hostOfBox = (box) => box.hostId ?? "local";

/** The boxes on one host, or every box when `host` is empty. */
export function boxesOnHost(boxes, host) {
  return host ? boxes.filter((box) => hostOfBox(box) === host) : boxes;
}

/** A box on a host that cannot be reached is listed with the state `unreachable`. */
export const isUnreachable = (box) => box.state === "unreachable";

/** Badge class for the status of a host, as /api/hosts reports it. */
export const HOST_BADGE = { online: "badge-success", offline: "badge-danger", unknown: "" };

/** What an agent host's connection says, as one word: revoked, upgrade, online or offline. Null for any other host. */
export function agentState(agent) {
  if (!agent) return null;
  if (agent.revoked) return "revoked";
  if (agent.upgradeRequired) return "upgrade";
  return agent.connected ? "online" : "offline";
}
