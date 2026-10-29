import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FORWARD_PROBE_SCRIPT, FORWARD_REPAIR_SCRIPT, judgeForwardReport } from "../egress/forward";
import { labelKeys } from "../labels";
import { formatIpv4Cidr, ipv4At, parseIpv4Cidr } from "../lib/cidr";
import { type ImageDetails, isRuntimeError, RuntimeError, type Runtime } from "../runtime";
import type { Engine } from "./engine";
import { runHelper } from "./helpers";
import { imageMethods } from "./images";

/**
 * What the helpers are built from. The base template carries no iptables, and Alpine has none either. Pinned to a
 * release line; a remote agent host pulls it on its own engine.
 */
const HOST_FIREWALL_IMAGE = "alpine:3.20";

/**
 * The forward check's helper image: that Alpine with the iptables binaries in it. The check runs on every host with a
 * `proxy-only` box every ten minutes, and installing the packages inside each helper put a download behind every pass,
 * and a failure on every pass of a host with no internet whose firewall had not changed. It is built on each engine the
 * first time a helper needs it, and again once it is a week old (see `HELPER_MAX_AGE_MS`).
 */
const HELPER_DOCKERFILE = `FROM ${HOST_FIREWALL_IMAGE}\nRUN apk add --no-cache iptables iptables-legacy\n`;

/** How long a failed build is left alone before the next helper tries again. */
const BUILD_RETRY_MS = 60 * 60 * 1000;

/**
 * How old the helper image may get before it is built again. The packages in it are whatever Alpine had on the day it
 * was built, so an image that is never rebuilt never gets a fix for iptables or for the base layers. The rebuild takes a
 * fresh base and ignores the build cache, since a cached `apk add` would give back the same packages.
 */
const HELPER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The helper image of one install. Image names are lower case, and a label prefix need not be. */
function helperImageTag(owner: string): string {
  return `${owner.toLowerCase()}-host-firewall:alpine3.20`;
}

/** The label that says when the helper image was built, as ISO time. It is how an engine's copy tells its own age. */
function helperBuiltLabel(owner: string): string {
  return `${owner}.helper.built`;
}

/**
 * Whether an image built at `built` (an ISO time, or nothing) is young enough at `now`. A time that is missing or
 * unreadable gives NaN, which is neither, and a time still to come is not trusted either: both mean build it again.
 */
function isFresh(built: string | undefined, now: number): boolean {
  const age = now - Date.parse(built ?? "");
  return age >= 0 && age < HELPER_MAX_AGE_MS;
}

/**
 * The chains MiniBox owns start with this. Each install has its own, named after a hash of its label prefix, so two
 * installs on one host, such as a test instance next to a live one, never replace each other's rules.
 */
const HOST_FIREWALL_CHAIN_PREFIX = "MINIBOX-EGRESS-";

/** An install's chain: the prefix and 8 hex digits, well inside iptables' 28-character limit. */
export function hostFirewallChain(owner: string): string {
  return `${HOST_FIREWALL_CHAIN_PREFIX}${createHash("sha256").update(owner).digest("hex").slice(0, 8)}`;
}

/** The chain that carries the forward allowance, named after the same install hash as the ingress block. */
export function hostForwardChain(owner: string): string {
  return `MINIBOX-FWD-${createHash("sha256").update(owner).digest("hex").slice(0, 8)}`;
}

/**
 * Runs as root with NET_ADMIN on the host network. The chain is emptied first and refilled, so a second run with the
 * same sources changes nothing. An empty source list removes the jump and the chain. Other chains are not touched.
 */
const FIREWALL_SCRIPT = [
  "set -eu",
  "apk add -q --no-cache iptables >/dev/null",
  'chain="$MINIBOX_FIREWALL_CHAIN"',
  'iptables -N "$chain" 2>/dev/null || true',
  'iptables -F "$chain"',
  'if [ -n "${MINIBOX_BLOCK_SOURCES:-}" ]; then',
  "  for source in $MINIBOX_BLOCK_SOURCES; do",
  '    iptables -A "$chain" -s "$source" -m conntrack --ctstate NEW -j DROP',
  "  done",
  '  iptables -C INPUT -j "$chain" 2>/dev/null || iptables -I INPUT 1 -j "$chain"',
  "else",
  '  while iptables -D INPUT -j "$chain" 2>/dev/null; do :; done',
  '  iptables -X "$chain" 2>/dev/null || true',
  "fi",
].join("\n");

const LOG_TAIL_CHARS = 512;

export function hostFirewallMethods(
  engine: Engine,
  options: { readonly now?: () => number } = {},
): Pick<Runtime, "setHostIngressBlock" | "checkHostForward" | "allowHostForward"> {
  const images = imageMethods(engine);
  const now = options.now ?? Date.now;
  // One resolution at a time per install, so a probe and a repair that start together share one build.
  const resolving = new Map<string, Promise<string>>();
  let buildFailedAt = 0;
  let buildError = "";

  async function buildHelperImage(owner: string, tag: string, refresh: boolean): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "minibox-fwimage-"));
    try {
      writeFileSync(join(dir, "Dockerfile"), HELPER_DOCKERFILE);
      // Marked as this install's and internal, so whoever clears the install's resources finds it, and with the time it
      // was built, so the next check can tell how old it is.
      const keys = labelKeys(owner);
      const labels = {
        [keys.box]: "true",
        [keys.internal]: "true",
        [helperBuiltLabel(owner)]: new Date(now()).toISOString(),
      };
      // A first build uses the Alpine the engine has, as everything else here does. A rebuild exists to pick up what
      // changed, so it asks for the current base and does not reuse the layers of the last build.
      await images.buildImage({
        contextDir: dir,
        dockerfile: "Dockerfile",
        tag,
        labels,
        ...(refresh ? { pull: true, noCache: true } : {}),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * The image a helper runs in: the one with iptables built in, built when the engine lacks it and again when it is a
   * week old. A build that fails (no internet, no registry) is not tried again for an hour, so a host that cannot build
   * does not retry on every pass. A host that has no image then falls back to plain Alpine, whose scripts try to
   * install iptables themselves; one that has an old image keeps using it, since iptables in an old image is still
   * iptables.
   */
  async function resolveHelperImage(owner: string): Promise<string> {
    const tag = helperImageTag(owner);
    let existing: ImageDetails | null = null;
    try {
      existing = await images.inspectImage(tag);
    } catch (e) {
      if (!isRuntimeError(e, "not_found")) throw e;
    }
    if (existing !== null && isFresh(existing.labels[helperBuiltLabel(owner)], now())) return tag;
    if (now() - buildFailedAt >= BUILD_RETRY_MS) {
      try {
        await buildHelperImage(owner, tag, existing !== null);
        buildError = "";
        // The tag now names the new image. The old one is nobody's, so it is removed unless a helper is still running
        // in it, which the engine refuses and which is no harm.
        if (existing !== null) await images.removeImage(existing.id, { force: false }).catch(() => undefined);
        return tag;
      } catch (e) {
        buildFailedAt = now();
        buildError = String(e).slice(-LOG_TAIL_CHARS);
      }
    }
    if (existing !== null) return tag;
    await images.pullImage(HOST_FIREWALL_IMAGE);
    return HOST_FIREWALL_IMAGE;
  }

  function helperImage(owner: string): Promise<string> {
    let pending = resolving.get(owner);
    if (!pending) {
      pending = resolveHelperImage(owner).finally(() => resolving.delete(owner));
      resolving.set(owner, pending);
    }
    return pending;
  }

  return {
    async setHostIngressBlock(owner, sources) {
      const canonical = sources.map((source) => {
        const network = parseIpv4Cidr(source);
        if (!network) throw new RuntimeError("invalid", `${source} is not an IPv4 CIDR`);
        return formatIpv4Cidr(network);
      });
      await images.pullImage(HOST_FIREWALL_IMAGE);
      const result = await runHelper(engine.docker, {
        image: HOST_FIREWALL_IMAGE,
        cmd: ["sh", "-c", FIREWALL_SCRIPT],
        env: [`MINIBOX_FIREWALL_CHAIN=${hostFirewallChain(owner)}`, `MINIBOX_BLOCK_SOURCES=${canonical.join(" ")}`],
        capAdd: ["NET_ADMIN"],
        hostNetwork: true,
        readonlyRoot: false,
        timeoutSec: 120,
      });
      if (result.exitCode !== 0) {
        const tail = result.logs.trim().slice(-LOG_TAIL_CHARS);
        throw new RuntimeError(
          "engine",
          `host firewall helper exited with ${result.exitCode}: ${tail}`,
          `the host firewall could not be updated (exit ${result.exitCode})`,
        );
      }
    },

    async checkHostForward(owner, bridge, source) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(bridge))
        throw new RuntimeError("invalid", `${bridge} is not an interface name`);
      const network = parseIpv4Cidr(source);
      if (!network) throw new RuntimeError("invalid", `${source} is not an IPv4 CIDR`);
      const image = await helperImage(owner);
      const result = await runHelper(engine.docker, {
        image,
        cmd: ["sh", "-c", FORWARD_PROBE_SCRIPT],
        env: [`MINIBOX_FORWARD_CHAIN=${hostForwardChain(owner)}`],
        capAdd: ["NET_ADMIN"],
        hostNetwork: true,
        readonlyRoot: false,
        timeoutSec: 120,
      });
      if (result.exitCode !== 0) {
        const tail = result.logs.trim().slice(-LOG_TAIL_CHARS);
        throw new RuntimeError(
          "engine",
          `host forward probe exited with ${result.exitCode}: ${tail}`,
          `the host's FORWARD rules could not be read (exit ${result.exitCode})`,
        );
      }
      // The probe packet's address is inside the uplink's subnet, which is where a proxy there would sit.
      const address = ipv4At(network, 1);
      const verdict = judgeForwardReport(result.logs, { bridge, source: address });
      if (verdict.backends.length === 0) {
        throw new RuntimeError(
          "engine",
          `the host forward probe read no iptables backend: ${result.logs.trim().slice(-LOG_TAIL_CHARS)}${
            buildError === "" ? "" : ` (the helper image could not be built: ${buildError})`
          }`,
          "the host's FORWARD rules could not be read",
        );
      }
      return { forwarding: !verdict.dropped, cause: verdict.cause, detail: verdict.detail };
    },

    async allowHostForward(owner, bridge) {
      if (bridge !== "" && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(bridge))
        throw new RuntimeError("invalid", `${bridge} is not an interface name`);
      const image = await helperImage(owner);
      const result = await runHelper(engine.docker, {
        image,
        cmd: ["sh", "-c", FORWARD_REPAIR_SCRIPT],
        env: [`MINIBOX_FORWARD_CHAIN=${hostForwardChain(owner)}`, `MINIBOX_UPLINK_BRIDGE=${bridge}`],
        capAdd: ["NET_ADMIN"],
        hostNetwork: true,
        readonlyRoot: false,
        timeoutSec: 120,
      });
      if (result.exitCode !== 0) {
        const tail = result.logs.trim().slice(-LOG_TAIL_CHARS);
        // Exit 3 is the script's own answer for a host with no IPv4 default route: there is no interface to allow, so
        // the repair cannot say what it would do and refuses instead of widening the chain.
        if (result.exitCode === 3) {
          throw new RuntimeError(
            "invalid",
            `the host has no IPv4 default route: ${tail}`,
            "the host has no IPv4 default route, so there is no interface to allow",
          );
        }
        throw new RuntimeError(
          "engine",
          `host forward helper exited with ${result.exitCode}: ${tail}`,
          `the host's FORWARD rules could not be changed (exit ${result.exitCode})`,
        );
      }
    },
  };
}
