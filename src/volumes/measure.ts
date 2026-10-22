import { randomBytes } from "node:crypto";

import type { HostCtx } from "../host/registry";
import { badRequest } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { isRuntimeError, RuntimeError, type VolumeOwner } from "../runtime";
import { assertVolumesPresent } from "./engine";

const HELPER_PATH = "/mnt";

/** The image the helpers run from. A helper cannot run without it, so a missing image is refused by name. */
async function helperImage(host: HostCtx): Promise<string> {
  try {
    await host.runtime.inspectImage(host.baseTemplateTag);
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") {
      throw badRequest(msg("helper_image_missing", { image: host.baseTemplateTag }));
    }
    throw e;
  }
  return host.baseTemplateTag;
}

/** Bytes the volume's files take, measured by a helper. Null when the helper's answer is not a number. */
export async function measureEngine(host: HostCtx, engineName: string): Promise<number | null> {
  await assertVolumesPresent(host, [engineName]);
  const image = await helperImage(host);
  const result = await host.runtime.runHelper({
    image,
    user: "0:0",
    capAdd: ["DAC_READ_SEARCH"],
    cmd: ["du", "-sb", HELPER_PATH],
    mounts: [{ source: engineName, target: HELPER_PATH }],
    timeoutSec: 120,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.exitCode !== 0) {
    throw badRequest(
      msg("volume_prepare_failed", { detail: result.logs.trim().slice(0, 400) || String(result.exitCode) }),
    );
  }
  const bytes = Number(result.logs.trim().split(/\s+/)[0]);
  return Number.isFinite(bytes) ? bytes : null;
}

/**
 * The owner of a volume's root, read through a helper that mounts it. A volume that no box mounts has no container of
 * its own to read it from, so a checkpoint of one needs this.
 */
export async function rootOwnerOf(host: HostCtx, engineName: string): Promise<VolumeOwner> {
  const image = await helperImage(host);
  const created = await host.runtime.createContainer({
    image,
    name: `${host.prefix}-owner-${randomBytes(4).toString("hex")}`,
    cmd: ["true"],
    mounts: [{ source: engineName, target: HELPER_PATH, mode: "ro", noCopy: true }],
    network: "none",
    labels: { [host.keys.internal]: "true" },
    readonlyRootfs: true,
    tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
    hardening: { capDrop: ["ALL"], noNewPrivileges: true, pidsLimit: 64 },
  });
  try {
    return await host.runtime.volumeRootOwner(created.id, HELPER_PATH);
  } finally {
    try {
      await host.runtime.removeContainer(created.id, { force: true });
    } catch (e) {
      if (!isRuntimeError(e, "not_found")) log.warn("volume.owner_helper_remove_failed", { error: String(e) });
    }
  }
}
