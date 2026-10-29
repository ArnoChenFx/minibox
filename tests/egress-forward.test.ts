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
const ETH = "eth0";
const PROBE = { bridge: BRIDGE, source: "240.0.0.2", egress: [ETH] };

/**
 * A report in the shape `FORWARD_PROBE_SCRIPT` prints: the interfaces, the default route's interface, then one
 * `iptables -S` dump per backend.
 */
function report(bridges: string[], backends: Record<string, string[] | null>, egress: string[] = [ETH]): string {
  const lines = [FORWARD_REPORT_MARKER, `@@bridges ${bridges.join(" ")}`, `@@egress ${egress.join(" ")}`];
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
    expect(parseForwardReport("")).toEqual({ bridges: [], egress: [], backends: [] });
    expect(parseForwardReport("apk: not found\n")).toEqual({ bridges: [], egress: [], backends: [] });
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

  test("a RETURN inside a jumped-to chain hands the packet back, so FORWARD's next rule still decides", () => {
    // Docker leaves DOCKER-USER as RETURN-then-nothing; a user who put a DROP after the RETURN there must not be read as
    // dropping the uplink, since iptables never reaches that DROP once RETURN matched.
    const verdict = judgeForwardReport(
      report([BRIDGE], {
        iptables: [
          "-P FORWARD DROP",
          "-A FORWARD -j DOCKER-USER",
          `-A FORWARD -i ${BRIDGE} -j ACCEPT`,
          "-A DOCKER-USER -j RETURN",
          "-A DOCKER-USER -j DROP",
        ],
      }),
      PROBE,
    );
    expect(verdict.dropped).toBe(false);
    expect(verdict.backends[0]?.reason).toContain("accepts");
  });

  test("a RETURN in FORWARD itself ends the traversal, so the policy decides and an accept below it never runs", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD DROP", "-A FORWARD -j RETURN", `-A FORWARD -i ${BRIDGE} -j ACCEPT`] }),
      PROBE,
    );
    expect(verdict.dropped).toBe(true);
    expect(verdict.backends[0]?.reason).toContain("policy is DROP");
  });

  test("a jump that returns leaves the caller's own accept rule to decide, and one that drops is the answer", () => {
    const afterReturn = judgeForwardReport(
      report([BRIDGE], {
        iptables: [
          "-P FORWARD DROP",
          `-A FORWARD -i ${BRIDGE} -j MINIBOX-CHECK`,
          `-A FORWARD -i ${BRIDGE} -j ACCEPT`,
          "-A MINIBOX-CHECK -j RETURN",
        ],
      }),
      PROBE,
    );
    expect(afterReturn.dropped).toBe(false);

    const dropped = judgeForwardReport(
      report([BRIDGE], {
        iptables: [
          "-P FORWARD ACCEPT",
          `-A FORWARD -i ${BRIDGE} -j MINIBOX-CHECK`,
          `-A FORWARD -i ${BRIDGE} -j ACCEPT`,
          "-A MINIBOX-CHECK -j DROP",
        ],
      }),
      PROBE,
    );
    expect(dropped.dropped).toBe(true);
  });
});

describe("telling a host that was asked to drop from one that lost the rule by accident", () => {
  test("a policy with nothing to accept the packet is the accident a repair is for", () => {
    const verdict = judgeForwardReport(report([BRIDGE], { iptables: ["-P FORWARD DROP"] }), PROBE);
    expect(verdict).toMatchObject({ dropped: true, cause: "policy" });
    expect(verdict.backends[0]).toMatchObject({ verdict: "drop", cause: "policy", unsure: false });
  });

  test("a DROP written on purpose is a decision, and MiniBox must not offer to undo it", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD ACCEPT", `-A FORWARD -i ${BRIDGE} -o ${ETH} -j DROP`] }),
      PROBE,
    );
    expect(verdict).toMatchObject({ dropped: true, cause: "rule" });
    expect(verdict.backends[0]?.reason).toContain("rule of its own");
  });

  test("a host whose rules already carry the uplink is not a drop at all", () => {
    // A DROP policy with an accept for the bridge is a host somebody locked down correctly. Reading it as a drop is
    // what made the old check offer a repair that would have widened the host.
    const verdict = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD DROP", `-A FORWARD -i ${BRIDGE} -o ${ETH} -j ACCEPT`] }),
      PROBE,
    );
    expect(verdict).toMatchObject({ dropped: false, cause: null });
  });

  test("a host whose DOCKER-USER drops the bridge on purpose is not repairable either", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], {
        iptables: [
          "-P FORWARD DROP",
          "-A FORWARD -j DOCKER-USER",
          `-A FORWARD -i ${BRIDGE} -o ${ETH} -j ACCEPT`,
          `-A DOCKER-USER -i ${BRIDGE} -j DROP`,
        ],
      }),
      PROBE,
    );
    expect(verdict).toMatchObject({ dropped: true, cause: "rule" });
  });

  test("a rule the check cannot read leaves the cause open, so there is a warning but no button", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], {
        iptables: ["-P FORWARD DROP", `-A FORWARD -i ${BRIDGE} -m iprange --src-range 240.0.0.1-240.0.0.9 -j ACCEPT`],
      }),
      PROBE,
    );
    expect(verdict).toMatchObject({ dropped: true, cause: null });
    expect(verdict.backends[0]).toMatchObject({ cause: null, unsure: true });
    expect(verdict.backends[0]?.reason).toContain("may accept");
  });

  test("two backends that disagree drop for different reasons, which is no certain cause", () => {
    const verdict = judgeForwardReport(
      report([BRIDGE], {
        iptables: ["-P FORWARD DROP"],
        "iptables-legacy": ["-P FORWARD ACCEPT", `-A FORWARD -i ${BRIDGE} -j DROP`],
      }),
      PROBE,
    );
    expect(verdict.dropped).toBe(true);
    expect(verdict.cause).toBeNull();
  });

  test("an output interface the packet cannot leave through does not decide it", () => {
    // The packet leaves through the default route, so a rule naming another uplink certainly does not match.
    const other = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD DROP", `-A FORWARD -i ${BRIDGE} -o wg0 -j DROP`] }),
      PROBE,
    );
    expect(other).toMatchObject({ dropped: true, cause: "policy" });

    // ... and one naming the interface it does leave through is the match that decides.
    const leaving = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD DROP", `-A FORWARD -i ${BRIDGE} -o ${ETH} -j ACCEPT`] }),
      PROBE,
    );
    expect(leaving.dropped).toBe(false);
  });

  test("a host with no default route leaves the output interface open rather than guessing", () => {
    const verdict = judgeForwardReport(report([BRIDGE], { iptables: ["-P FORWARD DROP"] }, []), {
      bridge: BRIDGE,
      source: "240.0.0.2",
    });
    expect(verdict.backends[0]?.cause).toBe("policy");
    // ... and a rule that names an output interface cannot be judged at all.
    const named = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD ACCEPT", `-A FORWARD -i ${BRIDGE} -o ${ETH} -j DROP`] }, []),
      { bridge: BRIDGE, source: "240.0.0.2" },
    );
    expect(named.backends[0]).toMatchObject({ cause: null, unsure: true });
  });

  test("the default route's interfaces are read from the report, not assumed", () => {
    const parsed = parseForwardReport(report([BRIDGE], { iptables: ["-P FORWARD ACCEPT"] }, ["eth0", "eth1"]));
    expect(parsed.egress).toEqual(["eth0", "eth1"]);
    // Two default routes mean the packet may leave through either, so no rule naming one is certain.
    const verdict = judgeForwardReport(
      report([BRIDGE], { iptables: ["-P FORWARD DROP", `-A FORWARD -i ${BRIDGE} -o ${ETH} -j ACCEPT`] }, [
        "eth0",
        "eth1",
      ]),
      { bridge: BRIDGE, source: "240.0.0.2" },
    );
    expect(verdict.backends[0]).toMatchObject({ cause: null, unsure: true });
    expect(
      judgeForwardReport(report([BRIDGE], { iptables: ["-P FORWARD DROP"] }, ["eth0", "eth1"]), {
        bridge: BRIDGE,
        source: "240.0.0.2",
      }).cause,
    ).toBe("policy");
  });
});

/** The verdict for one `iptables -S` dump of the `FORWARD` chain and whatever chains it names. */
const judge = (rules: string[]) => judgeForwardReport(report([BRIDGE], { iptables: rules }), PROBE);

/** A `FORWARD` that sends the uplink to `ZONE` with `jump` (`-j` or `-g`), and has its own accept rule after it. */
const zoneRules = (jump: string) => [
  "-P FORWARD DROP",
  `-A FORWARD -i ${BRIDGE} ${jump} ZONE`,
  `-A FORWARD -i ${BRIDGE} -o ${ETH} -j ACCEPT`,
  "-A ZONE -p udp -j ACCEPT",
];

describe("reading a rule the way iptables prints it", () => {
  test("a REJECT's own option is not a condition, so a host that rejects everything is not called fine", () => {
    // CentOS and RHEL ship exactly this as the last rule of FORWARD.
    const verdict = judge(["-P FORWARD ACCEPT", "-A FORWARD -j REJECT --reject-with icmp-host-prohibited"]);
    expect(verdict).toMatchObject({ dropped: true, cause: "rule" });
  });

  test("a reload that wiped Docker's rules and left the distribution's own is a drop by rule, which is not widened", () => {
    const verdict = judge([
      "-P FORWARD ACCEPT",
      "-A FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT",
      "-A FORWARD -j REJECT --reject-with icmp-host-prohibited",
    ]);
    expect(verdict).toMatchObject({ dropped: true, cause: "rule" });
  });

  test("the options of a LOG target are not conditions either, so logging does not make the reading unsure", () => {
    const verdict = judge(["-P FORWARD DROP", `-A FORWARD -i ${BRIDGE} -j LOG --log-prefix "fwd: " --log-level 4`]);
    expect(verdict).toMatchObject({ dropped: true, cause: "policy" });
    expect(verdict.backends[0]?.unsure).toBe(false);
  });

  test("a goto does not come back: when its chain ends, the rules after it in FORWARD are not walked", () => {
    // A jump comes back to the next rule, which accepts. A goto does not, so the policy decides.
    expect(judge(zoneRules("-j")).dropped).toBe(false);
    expect(judge(zoneRules("-g"))).toMatchObject({ dropped: true, cause: "policy" });
  });

  test("a goto to a chain that accepts is still an accept", () => {
    const verdict = judge(["-P FORWARD DROP", `-A FORWARD -i ${BRIDGE} -g ZONE`, `-A ZONE -o ${ETH} -j ACCEPT`]);
    expect(verdict.dropped).toBe(false);
  });

  test("a comment is a label, so a commented rule reads like the same rule without it", () => {
    const verdict = judge([
      "-P FORWARD DROP",
      `-A FORWARD -i ${BRIDGE} -o ${ETH} -m comment --comment "uplink out" -j ACCEPT`,
    ]);
    expect(verdict.dropped).toBe(false);
    expect(verdict.backends[0]?.unsure).toBe(false);
  });
});

describe("the helper scripts", () => {
  test("the probe only reads: no -I, -A, -D or -X against the host's chains", () => {
    for (const line of FORWARD_PROBE_SCRIPT.split("\n")) {
      expect(line).not.toMatch(/-(?:I|A|D|X|F) /);
    }
    expect(FORWARD_PROBE_SCRIPT).toContain(FORWARD_REPORT_MARKER);
  });

  test("the repair appends its jump instead of inserting it, so every rule above it still decides first", () => {
    expect(FORWARD_REPAIR_SCRIPT).toContain('chain="$MINIBOX_FORWARD_CHAIN"');
    expect(FORWARD_REPAIR_SCRIPT).toContain('bridge="$MINIBOX_UPLINK_BRIDGE"');
    // Appended, never inserted: Docker's isolation chains and DOCKER-USER are walked before MiniBox's rule.
    expect(FORWARD_REPAIR_SCRIPT).toContain('"$bin" -A FORWARD -j "$chain"');
    expect(FORWARD_REPAIR_SCRIPT).not.toContain("-I FORWARD");
    // An older MiniBox inserted it; the repair moves it rather than leaving it above the isolation chains.
    expect(FORWARD_REPAIR_SCRIPT).toContain('while "$bin" -D FORWARD -j "$chain" 2>/dev/null; do :; done');
    // It never rewrites the chain's policy, which is the host's decision and not MiniBox's.
    expect(FORWARD_REPAIR_SCRIPT).not.toContain("-P FORWARD");
  });

  test("the repair names the default route's interface, never every interface that is not the bridge", () => {
    // A rule of the shape `! -o $bridge` lets a box reach another bridge on the same host, past Docker's isolation.
    expect(FORWARD_REPAIR_SCRIPT).not.toContain('! -o "$bridge"');
    expect(FORWARD_REPAIR_SCRIPT).toContain('egress="$(');
    expect(FORWARD_REPAIR_SCRIPT).toContain("for name in $egress; do");
    expect(FORWARD_REPAIR_SCRIPT).toContain('"$bin" -A "$chain" -i "$bridge" -o "$name" -j ACCEPT');
    expect(FORWARD_REPAIR_SCRIPT).toContain(
      '"$bin" -A "$chain" -i "$name" -o "$bridge" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    );
    // A host with no default route has no interface to allow, so the repair refuses instead of widening the chain.
    expect(FORWARD_REPAIR_SCRIPT).toContain('if [ -z "$egress" ]; then');
    expect(FORWARD_REPAIR_SCRIPT).toContain("exit 3");
  });

  test("the legacy table is only read when it already exists, so the probe does not create one", () => {
    expect(FORWARD_PROBE_SCRIPT).toContain('if [ "$bin" = iptables-legacy ]; then');
    expect(FORWARD_PROBE_SCRIPT).toContain("grep -qx filter /proc/net/ip_tables_names");
    expect(FORWARD_REPAIR_SCRIPT).toContain("grep -qx filter /proc/net/ip_tables_names");
    // Reading it with the legacy binary is what loads the modules and leaves a table behind.
    expect(FORWARD_PROBE_SCRIPT).not.toMatch(/-S$/m);
    expect(FORWARD_PROBE_SCRIPT).toContain('"@@egress "');
  });

  test("an empty bridge removes the jump and the chain, which is how a host stops carrying the rule", () => {
    expect(FORWARD_REPAIR_SCRIPT).toContain('if [ -z "$bridge" ]; then');
    expect(FORWARD_REPAIR_SCRIPT).toContain('while "$bin" -D FORWARD -j "$chain" 2>/dev/null; do :; done');
    expect(FORWARD_REPAIR_SCRIPT).toContain('"$bin" -X "$chain" 2>/dev/null || true');
  });

  test("both scripts install iptables only when it is missing, and survive a host with no mirror", () => {
    // A host with no internet must still get a reading: the check is the thing that would tell its owner why.
    for (const script of [FORWARD_PROBE_SCRIPT, FORWARD_REPAIR_SCRIPT]) {
      expect(script).toContain("command -v iptables >/dev/null 2>&1 || apk add -q --no-cache iptables iptables-legacy");
      expect(script).toMatch(/apk add -q --no-cache iptables iptables-legacy >\/dev\/null 2>&1 \|\| true/);
    }
    // The probe reads what it can; a repair that changed nothing must not report success.
    expect(FORWARD_PROBE_SCRIPT).not.toContain("exit 4");
    expect(FORWARD_REPAIR_SCRIPT).toContain("exit 4");
  });
});
