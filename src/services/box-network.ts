import type { HostCtx } from "../host/registry";
import { conflict } from "../lib/errors";
import { msg } from "../lib/messages";
import { RuntimeError } from "../runtime";
import type { Box } from "./box-model";

/** Boxes share one bridge network with inter-container communication off. A network that differs is never reused. */
export async function ensureBoxNetwork(host: HostCtx): Promise<void> {
  try {
    await host.runtime.ensureBridgeNetwork(host.security.network, { interContainerComm: false });
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "conflict") {
      throw conflict(msg("box_network_conflict", { network: host.security.network }));
    }
    throw e;
  }
}

/**
 * A stopped box keeps the ID of the network it last ran on. After `docker network prune` removes that network, the box
 * starts only once it is attached to the network that now has the same name. A running box's network is in use, so it
 * cannot have been removed and is left alone.
 */
export async function attachToBoxNetwork(host: HostCtx, box: Box): Promise<void> {
  if (box.network !== host.security.network || box.running) return;
  await ensureBoxNetwork(host);
  await host.runtime.reattachNetwork(box.id, host.security.network);
}
