import Docker from "dockerode";

import { RuntimeError, type Runtime } from "../runtime";
import { networkOf } from "./containers";
import { call, type Engine } from "./engine";
import { toRuntimeError } from "./errors";

const ICC_OPTION = "com.docker.network.bridge.enable_icc";

/** An existing network can be used only if it is a bridge with the requested inter-container communication setting. */
function bridgeMatches(network: Docker.NetworkInspectInfo, interContainerComm: boolean): boolean {
  const enabled = network.Options?.[ICC_OPTION] !== "false";
  return network.Driver === "bridge" && enabled === interContainerComm;
}

function networkConflict(name: string, interContainerComm: boolean): RuntimeError {
  const message = `network ${name} exists but is not a bridge with inter-container communication ${interContainerComm ? "on" : "off"}`;
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

type NetworkMethods = Pick<Runtime, "ensureBridgeNetwork" | "reattachNetwork">;

export function networkMethods(engine: Engine): NetworkMethods {
  const { docker, mutate } = engine;

  return {
    async ensureBridgeNetwork(name, { interContainerComm }) {
      const existing = await inspectNetwork(docker, name);
      if (existing) {
        if (!bridgeMatches(existing, interContainerComm)) throw networkConflict(name, interContainerComm);
        return;
      }
      try {
        await call(() =>
          docker.createNetwork({
            Name: name,
            Driver: "bridge",
            Options: interContainerComm ? {} : { [ICC_OPTION]: "false" },
          }),
        );
      } catch (e) {
        if (!(e instanceof RuntimeError) || e.kind !== "conflict") throw e;
        // Another request created it between our inspect and create; accept it only if it matches.
        const created = await inspectNetwork(docker, name);
        if (!created || !bridgeMatches(created, interContainerComm)) throw networkConflict(name, interContainerComm);
      }
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
