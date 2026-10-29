import { createHash } from "node:crypto";

import { FORWARD_PROBE_SCRIPT, FORWARD_REPAIR_SCRIPT, judgeForwardReport } from "../egress/forward";
import { formatIpv4Cidr, ipv4At, parseIpv4Cidr } from "../lib/cidr";
import { RuntimeError, type Runtime } from "../runtime";
import type { Engine } from "./engine";
import { runHelper } from "./helpers";
import { imageMethods } from "./images";

/**
 * Carries iptables, which the base template does not. Pinned to a release line; the helper pulls it on first use. A
 * remote agent host pulls it on its own engine.
 */
const HOST_FIREWALL_IMAGE = "alpine:3.20";

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
): Pick<Runtime, "setHostIngressBlock" | "checkHostForward" | "allowHostForward"> {
  const images = imageMethods(engine);
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
      await images.pullImage(HOST_FIREWALL_IMAGE);
      const result = await runHelper(engine.docker, {
        image: HOST_FIREWALL_IMAGE,
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
          `the host forward probe read no iptables backend: ${result.logs.trim().slice(-LOG_TAIL_CHARS)}`,
          "the host's FORWARD rules could not be read",
        );
      }
      return { forwarding: !verdict.dropped, cause: verdict.cause, detail: verdict.detail };
    },

    async allowHostForward(owner, bridge) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(bridge))
        throw new RuntimeError("invalid", `${bridge} is not an interface name`);
      await images.pullImage(HOST_FIREWALL_IMAGE);
      const result = await runHelper(engine.docker, {
        image: HOST_FIREWALL_IMAGE,
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
