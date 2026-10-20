import type Docker from "dockerode";

import { log } from "../lib/logger";
import type { DockerCtx } from "./client";

const ICC_OPTION = "com.docker.network.bridge.enable_icc";

function statusOf(e: unknown): number | undefined {
  return (e as { statusCode?: number }).statusCode;
}

/**
 * Make sure the shared box network exists and return its name. Boxes can reach the internet through it, but
 * inter-container traffic is disabled, so one box cannot connect to another.
 */
export async function ensureBoxNetwork(ctx: DockerCtx): Promise<string> {
  const name = ctx.boxNetwork;
  let existing: Docker.NetworkInspectInfo | null = null;
  try {
    existing = await ctx.docker.getNetwork(name).inspect();
  } catch (e) {
    if (statusOf(e) !== 404) throw e;
  }
  if (existing) {
    if (existing.Options?.[ICC_OPTION] !== "false") log.warn("network.icc_enabled", { network: name });
    return name;
  }
  try {
    await ctx.docker.createNetwork({
      Name: name,
      Driver: "bridge",
      CheckDuplicate: true,
      Options: { [ICC_OPTION]: "false" },
    });
    log.info("network.created", { network: name });
  } catch (e) {
    if (statusOf(e) !== 409) throw e;
  }
  return name;
}
