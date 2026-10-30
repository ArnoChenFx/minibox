import { hardeningFor } from "../box-profile";
import { type BoxEgress, type EgressPolicy } from "../egress/policy";
import { allocateBoxSubnet, UPLINK_SUBNET } from "../egress/pool";
import { boxProxyEnv, PROXY_ALIAS, PROXY_PROGRAM, proxyEnv, proxyEnvMatches } from "../egress/proxy";
import type { HostCtx } from "../host/registry";
import { egressNetworkName, egressProxyName, egressUplinkName } from "../labels";
import { type Ipv4Network, parseIpv4Cidr } from "../lib/cidr";
import { AppError, conflict } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { type ContainerHardening, type ContainerInfo, isRuntimeError, RuntimeError } from "../runtime";
import { ensureBaseImage } from "./base-template";

const PROXY_MEMORY_BYTES = 256 * 1024 * 1024;
const PROXY_TMPFS = "rw,noexec,nosuid,nodev,size=16m";
const PROXY_STOP_TIMEOUT_SEC = 1;

/** What egress needs to know about a box: its stable id, its container and its name. */
export interface EgressBox {
  readonly boxId: string;
  readonly id: string;
  readonly name: string;
}

/**
 * A box on a private network has no raw sockets. Packets it crafts would still stay on that network, but there is no
 * reason to let it build them.
 */
export function withoutRawSockets(hardening: ContainerHardening): ContainerHardening {
  const capDrop = [...new Set([...(hardening.capDrop ?? []), "NET_RAW"])];
  const capAdd = hardening.capAdd?.filter((cap) => cap !== "NET_RAW");
  return { ...hardening, capDrop, ...(capAdd ? { capAdd } : {}) };
}

/** The proxy settings a box is created with. A box with `proxy-only` egress uses its proxy for every request. */
export function egressEnvOf(egress: BoxEgress | null): string[] {
  return egress?.mode === "proxy-only" ? boxProxyEnv() : [];
}

/**
 * The egress a box holds under a policy, on the private subnet it keeps. A box that already holds a private network keeps
 * its subnet, so a change of tier reuses that network. Open needs neither a network nor a subnet.
 */
export async function planEgress(
  host: HostCtx,
  policy: EgressPolicy,
  current: BoxEgress | null = null,
): Promise<BoxEgress | null> {
  const mode = policy.mode;
  if (mode === "open") return null;
  const subnet = current?.subnet ?? allocateBoxSubnet(await subnetsInUse(host));
  return {
    mode,
    presets: [...policy.presets],
    domains: [...policy.domains],
    allow: [...policy.allow],
    subnet,
  };
}

/**
 * The subnets a new box must avoid: those of the networks the engine holds, and those the egress specs hold. A stopped box's
 * network may have been pruned, and its subnet still has to stay its own when it starts again.
 */
async function subnetsInUse(host: HostCtx): Promise<Ipv4Network[]> {
  const held = host.specs.list().flatMap((spec) => (spec.egress ? [spec.egress.subnet] : []));
  const engine = (await host.runtime.listNetworks()).flatMap((network) => network.subnets);
  return [...engine, ...held].flatMap((cidr) => {
    const parsed = parseIpv4Cidr(cidr);
    return parsed ? [parsed] : [];
  });
}

/**
 * Makes sure the box's private network exists on the subnet its spec names. The network is internal: nothing on it has a
 * route out of the host. Containers on it may reach each other, which is how a box reaches its own proxy.
 */
export async function ensureEgressNetwork(host: HostCtx, boxId: string, egress: BoxEgress): Promise<string> {
  const name = egressNetworkName(host.prefix, boxId);
  await ensureNetwork(host, name, { interContainerComm: true, internal: true, subnet: egress.subnet });
  return name;
}

async function ensureNetwork(
  host: HostCtx,
  name: string,
  opts: { interContainerComm: boolean; internal?: boolean; subnet?: string },
): Promise<void> {
  try {
    await host.runtime.ensureBridgeNetwork(name, opts);
  } catch (e) {
    if (isRuntimeError(e, "conflict")) throw conflict(msg("egress_network_conflict", { network: name }));
    throw e;
  }
}

function proxiesOf(host: HostCtx, boxId: string): Promise<ContainerInfo[]> {
  return host.runtime.listContainers({ labels: { [host.keys.egressProxy]: boxId } });
}

/**
 * Makes sure a proxy-only box has a running proxy. The proxy sits on the shared uplink, which reaches the internet, and it
 * joins the box's private network under the alias the box's proxy settings name. A proxy that serves another allowlist,
 * or another set of allowed private ranges, is replaced. Box, proxy and uplink are the only things that network can
 * reach.
 */
export async function ensureEgressProxy(host: HostCtx, box: EgressBox, egress: BoxEgress): Promise<void> {
  if (egress.mode !== "proxy-only") return;
  const uplink = egressUplinkName(host.prefix);
  try {
    await ensureNetwork(host, uplink, { interContainerComm: false, subnet: UPLINK_SUBNET });
    const proxyId = await proxyFor(host, box.boxId, egress);
    await host.runtime.connectNetwork(proxyId, egressNetworkName(host.prefix, box.boxId), { alias: PROXY_ALIAS });
    await host.runtime.reattachNetwork(proxyId, uplink);
    await host.runtime.startContainer(proxyId);
    host.egress.follow(host.runtime, host.host.id, { proxyId, containerId: box.id, name: box.name });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(502, "docker_error", msg("egress_proxy_failed", { box: box.name, detail: detailOf(e) }));
  }
}

async function proxyFor(host: HostCtx, boxId: string, egress: BoxEgress): Promise<string> {
  const wanted = proxyEnv(egress.allow, host.security.egressAllowRanges);
  const existing = await proxiesOf(host, boxId);
  for (const proxy of existing) {
    const env = await host.runtime.inspectEnv(proxy.id);
    if (proxyEnvMatches(env, wanted)) return proxy.id;
  }
  for (const proxy of existing) await removeProxy(host, proxy.id);
  // The proxy runs the base template, which carries Node. A host without it builds it first.
  await ensureBaseImage(host);
  const created = await host.runtime.createContainer({
    name: egressProxyName(host.prefix, boxId),
    image: host.baseTemplateTag,
    cmd: ["node", "-e", PROXY_PROGRAM],
    env: wanted,
    labels: { [host.keys.egressProxy]: boxId },
    network: egressUplinkName(host.prefix),
    restart: "unless-stopped",
    memoryBytes: PROXY_MEMORY_BYTES,
    readonlyRootfs: true,
    tmpfs: { "/tmp": PROXY_TMPFS },
    hardening: hardeningFor("strict", host.security),
  });
  return created.id;
}

async function removeProxy(host: HostCtx, proxyId: string): Promise<void> {
  host.egress.stop(host.host.id, proxyId);
  try {
    await host.runtime.removeContainer(proxyId, { force: true });
  } catch (e) {
    if (!isRuntimeError(e, "not_found")) throw e;
  }
}

/**
 * Brings a box's egress up before its container starts: its private network, its proxy, and the host firewall rules that
 * keep it off the host. A box on the default network only gets the firewall check. A stopped box is attached to its
 * network again, since a `docker network prune` may have removed the one it last used. `previous` is the egress a
 * rebuild takes the box off, so the firewall drops that source too.
 */
export async function prepareEgress(
  host: HostCtx,
  box: EgressBox & { readonly running: boolean },
  previous: BoxEgress | null = null,
): Promise<void> {
  const egress = host.specs.read(box.boxId)?.egress;
  if (egress) {
    await ensureEgressNetwork(host, box.boxId, egress);
    if (!box.running) await host.runtime.reattachNetwork(box.id, egressNetworkName(host.prefix, box.boxId));
    await ensureEgressProxy(host, box, egress);
  }
  if (egress || previous || host.security.blockHostGateway) await syncHostFirewall(host);
}

/** Stops a box's proxies once the box has stopped. A proxy that cannot stop is logged, since the box is already stopped. */
export async function stopEgressProxies(host: HostCtx, boxId: string): Promise<void> {
  try {
    for (const proxy of await proxiesOf(host, boxId)) {
      if (proxy.running) await host.runtime.stopContainer(proxy.id, { timeoutSec: PROXY_STOP_TIMEOUT_SEC });
    }
  } catch (e) {
    log.warn("egress.proxy_stop_failed", { host: host.host.id, box: boxId, error: String(e) });
  }
}

/** Removes every proxy a box has. A box with none makes only the lookup. */
export async function removeProxies(host: HostCtx, boxId: string): Promise<void> {
  for (const proxy of await proxiesOf(host, boxId)) await removeProxy(host, proxy.id);
}

/** Removes a box's proxy and private network. The box's container must be gone first, or the engine keeps the network. */
export async function removeEgress(host: HostCtx, boxId: string): Promise<void> {
  await removeProxies(host, boxId);
  await host.runtime.removeNetwork(egressNetworkName(host.prefix, boxId));
}

/**
 * Sets the host firewall to the sources that may not reach the host: the private network of each egress box on this host,
 * and the default network when BLOCK_HOST_GATEWAY is on. A host with neither makes no engine call. A host whose rules are
 * already what is wanted is not sent them again, unless `force` is set, as a reconcile does after a host reboot may have
 * cleared them. A failure is raised, so a box does not start without its block.
 */
export async function syncHostFirewall(host: HostCtx, opts: { readonly force?: boolean } = {}): Promise<void> {
  const sources = await blockedSources(host);
  try {
    await host.firewall.apply(
      sources,
      (next) => host.runtime.setHostIngressBlock(host.prefix, next),
      opts.force ?? false,
    );
  } catch (e) {
    throw new AppError(502, "docker_error", msg("egress_host_gateway_failed", { detail: detailOf(e) }));
  }
}

async function blockedSources(host: HostCtx): Promise<string[]> {
  const sources = new Set<string>();
  for (const spec of host.specs.list()) {
    if (spec.hostId === host.host.id && spec.egress) sources.add(spec.egress.subnet);
  }
  if (host.security.blockHostGateway) {
    const network = (await host.runtime.listNetworks()).find((candidate) => candidate.name === host.security.network);
    for (const subnet of network?.subnets ?? []) sources.add(subnet);
  }
  return [...sources].toSorted();
}

/**
 * Reads the logs of the proxies already running for this host's proxy-only boxes, as after a MiniBox restart, when no
 * start has asked for them. A proxy already read is not read twice.
 */
export async function followRunningProxies(host: HostCtx): Promise<void> {
  const specs = host.specs.list().filter((spec) => spec.hostId === host.host.id && spec.egress?.mode === "proxy-only");
  if (specs.length === 0) return;
  const owners = new Map(specs.map((spec) => [spec.id, spec]));
  for (const proxy of await host.runtime.listContainers({ labels: {} })) {
    const owner = owners.get(proxy.labels[host.keys.egressProxy] ?? "");
    if (!owner || !proxy.running) continue;
    host.egress.follow(host.runtime, host.host.id, {
      proxyId: proxy.id,
      containerId: owner.containerId,
      name: owner.name,
    });
  }
}

/**
 * Removes the proxies and private networks that no box spec names, such as those a crash or a deleted spec left behind.
 * Each name it removes is returned. A network that still has a container attached is kept and logged.
 */
export async function sweepEgress(host: HostCtx): Promise<string[]> {
  const prefix = `${host.prefix}-egress-`;
  const uplink = egressUplinkName(host.prefix);
  const networks = (await host.runtime.listNetworks()).filter((network) => network.name.startsWith(prefix));
  // A proxy is only ever created after the uplink exists, so a host with no egress network has no proxy either.
  if (networks.length === 0) return [];

  const specs = host.specs.list();
  const boxIds = new Set(specs.map((spec) => spec.id));
  const wanted = new Set(specs.flatMap((spec) => (spec.egress ? [egressNetworkName(host.prefix, spec.id)] : [])));
  const removed: string[] = [];

  for (const container of await host.runtime.listContainers({ labels: {} })) {
    const owner = container.labels[host.keys.egressProxy];
    if (owner === undefined || boxIds.has(owner)) continue;
    try {
      await removeProxy(host, container.id);
      removed.push(container.name);
    } catch (e) {
      log.warn("egress.sweep_failed", { host: host.host.id, container: container.name, error: String(e) });
    }
  }

  for (const network of networks) {
    if (network.name === uplink || wanted.has(network.name)) continue;
    try {
      await host.runtime.removeNetwork(network.name);
      removed.push(network.name);
    } catch (e) {
      log.warn("egress.sweep_failed", { host: host.host.id, network: network.name, error: String(e) });
    }
  }
  return removed;
}

function detailOf(e: unknown): string {
  if (e instanceof RuntimeError) return e.detail;
  return e instanceof Error ? e.message : String(e);
}
