import { describe, expect, test } from "bun:test";

import {
  FORWARD_BACKENDS,
  FORWARD_PROBE_SCRIPT,
  FORWARD_REPAIR_SCRIPT,
  FORWARD_REPORT_MARKER,
  judgeForwardReport,
  parseForwardReport,
} from "../src/egress/forward";

const BRIDGE = "br-1a2b3c4d5e6f";
const PROBE = { bridge: BRIDGE, source: "240.0.0.2" };

/** A report in the shape `FORWARD_PROBE_SCRIPT` prints: the interfaces, then one `iptables -S` dump per backend. */
function report(bridges: string[], backends: Record<string, string[] | null>): string {
  const lines = [FORWARD_REPORT_MARKER, `@@bridges ${bridges.join(" ")}`];
  for (const [name, rules] of Object.entries(backends)) {
    lines.push(`@@backend ${name}`);
    if (rules === null) lines.push("@@failed");
    else lines.push(...rules);
    lines.push("@@end");
  }
  return `${lines.join("\n")}\n`;
}

/** The `FORWARD` chain a working Docker install leaves behind: accept the bridge's outgoing traffic, and its replies. */
const WORKING = [
  "-P FORWARD DROP",
  `-A FORWARD -i ${BRIDGE} -j ACCEPT`,
  `-A FORWARD -o ${BRIDGE} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
];

/** A `FORWARD` chain whose policy is ACCEPT, which forwards everything without a rule of its own. */
const OPEN_POLICY = ["-P FORWARD ACCEPT"];

describe("reading the helper's report", () => {
  test("the interfaces and each backend's chains come back in the order the helper printed them", () => {
    const parsed = parseForwardReport(
      report(["lo", "eth0", BRIDGE], { iptables: ["-P FORWARD ACCEPT", "-A FORWARD -i eth0 -j DROP"] }),
    );
    expect(parsed.bridges).toEqual(["lo", "eth0", BRIDGE]);
    expect(parsed.backends.map((backend) => backend.name)).toEqual(["iptables"]);
    expect(parsed.backends[0]?.chains.get("FORWARD")).toMatchObject({ policy: "ACCEPT" });
    expect(parsed.backends[0]?.chains.get("FORWARD")?.rules).toHaveLength(1);
  });

  test("output with no report marker is no report at all, not an empty host", () => {
    expect(parseForwardReport("")).toEqual({ bridges: [], backends: [] });
    expect(parseForwardReport("apk: not found\n")).toEqual({ bridges: [], backends: [] });
  });

  test("a backend that failed is kept, so the caller can say it was not read", () => {
    const parsed = parseForwardReport(report([BRIDGE], { iptables: null }));
    expect(parsed.backends).toHaveLength(1);
    expect(parsed.backends[0]?.failed).toBe(true);
  });
});

describe("deciding what FORWARD does with the uplink", () => {
  test("Docker's own rules forward the bridge, so the host is fine", () => {
    const verdict = judgeForwardReport(report([BRIDGE], { iptables: WORKING }), PROBE);
    expect(verdict.dropped).toBe(false);
    expect(verdict.backends[0]).toMatchObject({ backend: "iptables", verdict: "ok" });
    expect(verdict.backends[0]?.reason).toContain("accepts");
  });

  test("a DROP policy with no rule for the bridge is the condition", () => {
    const verdict = judgeForwardReport(report([BRIDGE], { iptables: ["-P FORWARD DROP"] }), PROBE);
    expect(verdict.dropped).toBe(true);
    expect(verdict.detail).toContain("policy is DROP");
  });

  test("an explicit DROP for the bridge is the condition even with an ACCEPT policy", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD ACCEPT", `-A FORWARD -i ${BRIDGE} -j DROP`] }),
      PROBE,
    );
    expect(verdict.dropped).toBe(true);
  });

  test("one backend dropping is enough, which is what a leftover legacy table looks like", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], { iptables: OPEN_POLICY, "iptables-legacy": ["-P FORWARD DROP"] }),
      PROBE,
    );
    expect(verdict.dropped).toBe(true);
    expect(verdict.detail).toContain("iptables-legacy");
  });

  test("a backend that could not be read is left out of the decision, so it never raises a false alarm", () => {
    const verdict = judgeForwardReport(report([BRIDGE], { iptables: null }), PROBE);
    expect(verdict.dropped).toBe(false);
    expect(verdict.backends[0]).toMatchObject({ verdict: "unknown" });
    expect(verdict.detail).toContain("could not be read");
  });

  test("a chain with no FORWARD of its own is not read, rather than guessed at", () => {
    const verdict = judgeForwardReport(report([BRIDGE], { iptables: ["-P INPUT ACCEPT"] }), PROBE);
    expect(verdict.dropped).toBe(false);
    expect(verdict.backends[0]?.reason).toContain("no FORWARD chain");
  });

  test("a rule that only names another interface does not decide the bridge's traffic", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD DROP", "-A FORWARD -i eth0 -j ACCEPT"] }),
      PROBE,
    );
    expect(verdict.dropped).toBe(true);
  });

  test("a bridge wildcard accepts the interface, as iptables matches it", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD DROP", "-A FORWARD -i br-+ -j ACCEPT"] }),
      PROBE,
    );
    expect(verdict.dropped).toBe(false);
  });

  test("a jump to a chain that accepts is followed, and one that falls through keeps walking", () => {
    const accepting = judgeForwardReport(
      report([BRIDGE], {
        iptables: ["-P FORWARD DROP", "-A FORWARD -i br-1a2b3c4d5e6f -j DOCKER", "-A DOCKER -j ACCEPT"],
      }),
      PROBE,
    );
    expect(accepting.dropped).toBe(false);

    const fallingThrough = judgeForwardReport(
      report([BRIDGE], {
        iptables: [
          "-P FORWARD DROP",
          "-A FORWARD -i br-1a2b3c4d5e6f -j DOCKER",
          "-A DOCKER -o br-1a2b3c4d5e6f -j ACCEPT",
        ],
      }),
      PROBE,
    );
    // The jumped-to rule is about the other direction, so the packet falls back and the DROP policy decides.
    expect(fallingThrough.dropped).toBe(true);
  });

  test("a rule the check cannot evaluate never counts as an acceptance", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], {
        iptables: ["-P FORWARD DROP", `-A FORWARD -i ${BRIDGE} -m iprange --src-range 10.0.0.1-10.0.0.9 -j ACCEPT`],
      }),
      PROBE,
    );
    expect(verdict.dropped).toBe(true);
  });

  test("a rule that matches an established connection does not decide a new one", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], {
        iptables: ["-P FORWARD DROP", `-A FORWARD -i ${BRIDGE} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`],
      }),
      PROBE,
    );
    expect(verdict.dropped).toBe(true);
  });

  test("a source outside the rule's subnet does not match, and one inside does", () => {
    const inside = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD DROP", "-A FORWARD -i br-1a2b3c4d5e6f -s 240.0.0.0/24 -j ACCEPT"] }),
      PROBE,
    );
    expect(inside.dropped).toBe(false);
    const outside = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD DROP", "-A FORWARD -i br-1a2b3c4d5e6f -s 240.0.1.0/24 -j ACCEPT"] }),
      PROBE,
    );
    expect(outside.dropped).toBe(true);
  });

  test("a negated criterion the check understands is read the other way round", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD DROP", `-A FORWARD -i ${BRIDGE} ! -s 240.0.0.0/24 -j DROP`] }),
      PROBE,
    );
    // The probe is inside that subnet, so the negated rule does not match it and the policy drops it.
    expect(verdict.dropped).toBe(true);
  });

  test("the report names every backend it read, so the detail is one line an operator can read", () => {
    const verdict = judgeForwardReport(report([BRIDGE], { iptables: OPEN_POLICY, "iptables-legacy": WORKING }), PROBE);
    expect(verdict.backends.map((backend) => backend.backend)).toEqual([...FORWARD_BACKENDS]);
    expect(verdict.dropped).toBe(false);
    expect(verdict.detail).toContain("iptables");
    expect(verdict.detail).toContain("iptables-legacy");
  });
});

describe("the helper scripts", () => {
  test("the probe only reads: no -I, -A, -D or -X against the host's chains", () => {
    for (const line of FORWARD_PROBE_SCRIPT.split("\n")) {
      expect(line).not.toMatch(/-(?:I|A|D|X|F) /);
    }
    expect(FORWARD_PROBE_SCRIPT).toContain(FORWARD_REPORT_MARKER);
  });

  test("the repair adds MiniBox's own chain and jumps to it, and names the bridge from its environment", () => {
    expect(FORWARD_REPAIR_SCRIPT).toContain('chain="$MINIBOX_FORWARD_CHAIN"');
    expect(FORWARD_REPAIR_SCRIPT).toContain('bridge="$MINIBOX_UPLINK_BRIDGE"');
    expect(FORWARD_REPAIR_SCRIPT).toContain('"$bin" -C FORWARD -j "$chain"');
    expect(FORWARD_REPAIR_SCRIPT).toContain('"$bin" -I FORWARD 1 -j "$chain"');
    expect(FORWARD_REPAIR_SCRIPT).toContain('"$bin" -A "$chain" -i "$bridge" ! -o "$bridge" -j ACCEPT');
    // It never rewrites the chain's policy, which is the host's decision and not MiniBox's.
    expect(FORWARD_REPAIR_SCRIPT).not.toContain("-P FORWARD");
  });

  test("an empty bridge removes the jump and the chain, which is how a host stops carrying the rule", () => {
    expect(FORWARD_REPAIR_SCRIPT).toContain('if [ -z "$bridge" ]; then');
    expect(FORWARD_REPAIR_SCRIPT).toContain('while "$bin" -D FORWARD -j "$chain" 2>/dev/null; do :; done');
    expect(FORWARD_REPAIR_SCRIPT).toContain('"$bin" -X "$chain" 2>/dev/null || true');
  });

  test("both scripts install iptables, since the helper image carries neither binary", () => {
    expect(FORWARD_PROBE_SCRIPT).toContain("apk add -q --no-cache iptables iptables-legacy");
    expect(FORWARD_REPAIR_SCRIPT).toContain("apk add -q --no-cache iptables iptables-legacy");
  });
});
