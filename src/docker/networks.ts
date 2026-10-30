import Docker from "dockerode";

import { RuntimeError, type NetworkSummary, type Runtime } from "../runtime";
import { networkOf } from "./containers";
import { call, type Engine } from "./engine";
import { toRuntimeError } from "./errors";

const ICC_OPTION = "com.docker.network.bridge.enable_icc";
/** The option a bridge takes its host interface name from, instead of the `br-<id>` the engine picks. */
const BRIDGE_NAME_OPTION = "com.docker.network.bridge.name";

interface BridgeSpec {
  interContainerComm: boolean;
  internal: boolean;
  subnet?: string;
}

function subnetsOf(network: Docker.NetworkInspectInfo): string[] {
  return (network.IPAM?.Config ?? []).flatMap((entry) => (entry.Subnet ? [entry.Subnet] : []));
}

/**
 * The host interface the bridge driver made for a network. A bridge takes the name its options give it, or
 * `br-` and the first 12 characters of the network id, which is how the engine names them. A network on another driver
 * has no such interface here.
 */
function bridgeOf(network: Docker.NetworkInspectInfo): string | null {
  if (network.Driver !== "bridge") return null;
  const named = network.Options?.[BRIDGE_NAME_OPTION]?.trim();
  if (named) return named;
  const short = (network.Id ?? "").slice(0, 12);
  return short ? `br-${short}` : null;
}

/** An existing network can be used only if it is a bridge that matches every setting the caller asked for. */
function bridgeMatches(network: Docker.NetworkInspectInfo, spec: BridgeSpec): boolean {
  const enabled = network.Options?.[ICC_OPTION] !== "false";
  if (network.Driver !== "bridge" || enabled !== spec.interContainerComm) return false;
  if (Boolean(network.Internal) !== spec.internal) return false;
  return spec.subnet === undefined || subnetsOf(network).includes(spec.subnet);
}

function networkConflict(name: string, spec: BridgeSpec): RuntimeError {
  const parts = [
    `inter-container communication ${spec.interContainerComm ? "on" : "off"}`,
    spec.internal ? "internal" : "not internal",
    spec.subnet ? `subnet ${spec.subnet}` : null,
  ].filter(Boolean);
  const message = `network ${name} exists but is not a bridge with ${parts.join(", ")}`;
  return new RuntimeError("conflict", message, message);
}

async function inspectNetwork(docker: Docker, name: string): Promise<Docker.NetworkInspectInfo | undefined> {
  try {
    return await docker.getNetwork(name).inspect();
  } catch (e) {
    const err = toRuntimeError(e);
    if (err instanceof RuntimeError && err.kind === "not_found") return undefined;
    throw err;
  }
}

type NetworkMethods = Pick<
  Runtime,
  "ensureBridgeNetwork" | "removeNetwork" | "connectNetwork" | "listNetworks" | "reattachNetwork"
>;

export function networkMethods(engine: Engine): NetworkMethods {
  const { docker, mutate } = engine;

  return {
    async ensureBridgeNetwork(name, { interContainerComm, internal = false, subnet, labels }) {
      const spec: BridgeSpec = { interContainerComm, internal, subnet };
      const existing = await inspectNetwork(docker, name);
      if (existing) {
        if (!bridgeMatches(existing, spec)) throw networkConflict(name, spec);
        return;
      }
      const ipam = subnet === undefined ? undefined : { Driver: "default", Config: [{ Subnet: subnet }] };
      try {
        await call(() =>
          docker.createNetwork({
            Name: name,
            Driver: "bridge",
            Internal: internal,
            Options: interContainerComm ? {} : { [ICC_OPTION]: "false" },
            ...(labels && Object.keys(labels).length > 0 ? { Labels: labels } : {}),
            ...(ipam ? { IPAM: ipam } : {}),
          }),
        );
      } catch (e) {
        if (!(e instanceof RuntimeError) || e.kind !== "conflict") throw e;
        // Another request created it between our inspect and create; accept it only if it matches.
        const created = await inspectNetwork(docker, name);
        if (!created || !bridgeMatches(created, spec)) throw networkConflict(name, spec);
      }
    },

    async removeNetwork(name) {
      if (!(await inspectNetwork(docker, name))) return;
      try {
        await mutate(() => docker.getNetwork(name).remove());
      } catch (e) {
        // The engine refuses with 403 while containers are attached. That is a conflict, not a bad request.
        if (e instanceof RuntimeError && e.kind === "invalid") {
          throw new RuntimeError("conflict", `network ${name} still has containers attached`, e.detail);
        }
        throw e;
      }
    },

    async connectNetwork(containerId, name, opts) {
      const info = await call(() => docker.getContainer(containerId).inspect());
      const network = await inspectNetwork(docker, name);
      if (!network) throw new RuntimeError("not_found", `network ${name} not found`);
      const endpoint = info.NetworkSettings.Networks[name];
      if (endpoint?.NetworkID === network.Id) return;
      // The engine rejects a disconnect from a network the container has no endpoint on.
      if (endpoint) await mutate(() => docker.getNetwork(name).disconnect({ Container: containerId }));
      const aliases = opts?.alias === undefined ? undefined : [opts.alias];
      await mutate(() =>
        docker.getNetwork(name).connect({
          Container: containerId,
          ...(aliases ? { EndpointConfig: { Aliases: aliases } } : {}),
        }),
      );
    },

    async listNetworks() {
      const networks = await call(() => docker.listNetworks());
      return networks.map((network): NetworkSummary => ({
        name: network.Name,
        subnets: subnetsOf(network),
        labels: network.Labels ?? {},
        bridge: bridgeOf(network),
      }));
    },

    async reattachNetwork(containerId, name) {
      const info = await call(() => docker.getContainer(containerId).inspect());
      if (networkOf(info) !== name) {
        throw new RuntimeError("invalid", `container ${containerId} is not on network ${name}`);
      }
      const network = await inspectNetwork(docker, name);
      if (!network) throw new RuntimeError("not_found", `network ${name} not found`);
      const endpoint = info.NetworkSettings.Networks[name];
      if (endpoint?.NetworkID === network.Id) return;
      // The engine rejects a disconnect from a network the container has no endpoint on.
      if (endpoint) await mutate(() => docker.getNetwork(name).disconnect({ Container: containerId }));
      await mutate(() => docker.getNetwork(name).connect({ Container: containerId }));
    },
  };
}
