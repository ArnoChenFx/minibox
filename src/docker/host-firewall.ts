import { formatIpv4Cidr, parseIpv4Cidr } from "../lib/cidr";
import { RuntimeError, type Runtime } from "../runtime";
import type { Engine } from "./engine";
import { runHelper } from "./helpers";
import { imageMethods } from "./images";

/**
 * Carries iptables, which the base template does not. Pinned to a release line; the helper pulls it on first use. A
 * remote agent host pulls it on its own engine.
 */
export const HOST_FIREWALL_IMAGE = "alpine:3.20";

/** The chain MiniBox owns. It holds the drops and is jumped to from INPUT, so it is replaced as a whole. */
export const HOST_FIREWALL_CHAIN = "MINIBOX-EGRESS";

/**
 * Runs as root with NET_ADMIN on the host network. The chain is emptied first and refilled, so a second run with the
 * same sources changes nothing. An empty source list removes the jump and the chain.
 */
const FIREWALL_SCRIPT = [
  "set -eu",
  "apk add -q --no-cache iptables >/dev/null",
  `iptables -N ${HOST_FIREWALL_CHAIN} 2>/dev/null || true`,
  `iptables -F ${HOST_FIREWALL_CHAIN}`,
  `while iptables -D INPUT -j ${HOST_FIREWALL_CHAIN} 2>/dev/null; do :; done`,
  'if [ -n "${MINIBOX_BLOCK_SOURCES:-}" ]; then',
  "  for source in $MINIBOX_BLOCK_SOURCES; do",
  `    iptables -A ${HOST_FIREWALL_CHAIN} -s "$source" -m conntrack --ctstate NEW -j DROP`,
  "  done",
  `  iptables -I INPUT 1 -j ${HOST_FIREWALL_CHAIN}`,
  "else",
  `  iptables -X ${HOST_FIREWALL_CHAIN} 2>/dev/null || true`,
  "fi",
].join("\n");

const LOG_TAIL_CHARS = 512;

export function hostFirewallMethods(engine: Engine): Pick<Runtime, "setHostIngressBlock"> {
  const images = imageMethods(engine);
  return {
    async setHostIngressBlock(sources) {
      const canonical = sources.map((source) => {
        const network = parseIpv4Cidr(source);
        if (!network) throw new RuntimeError("invalid", `${source} is not an IPv4 CIDR`);
        return formatIpv4Cidr(network);
      });
      await images.pullImage(HOST_FIREWALL_IMAGE);
      const result = await runHelper(engine.docker, {
        image: HOST_FIREWALL_IMAGE,
        cmd: ["sh", "-c", FIREWALL_SCRIPT],
        env: [`MINIBOX_BLOCK_SOURCES=${canonical.join(" ")}`],
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
  };
}
