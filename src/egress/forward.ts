import { parseIpv4Cidr } from "../lib/cidr";

/**
 * The host's `FORWARD` chain is what lets a `proxy-only` box reach the internet. The box itself has no route out: its
 * proxy sits on the shared uplink bridge and Docker's own rules forward that bridge's traffic. MiniBox never writes
 * those rules, so a host whose `FORWARD` policy is `DROP`, a leftover `iptables-legacy` table, or a firewall reload can
 * drop the uplink's traffic without anything else noticing.
 *
 * This module reads what the helper container printed and decides whether a new connection arriving on the uplink
 * bridge would be accepted. It is pure: the engine call and the helper live in `src/docker/host-firewall.ts`.
 */

/** The first line of a probe report. A helper that printed no report at all is a helper that did not run. */
export const FORWARD_REPORT_MARKER = "@@minibox-forward 1";

/** Every backend whose `FORWARD` chain the check reads. `iptables` is the nft one on Alpine and modern distributions. */
export const FORWARD_BACKENDS = ["iptables", "iptables-legacy"] as const;

/** Longest chain of jumps the check follows before it gives up on a chain that never decides. */
const MAX_DEPTH = 4;

/** A rule criterion the check understands. Anything else makes the rule one the check does not read. */
type Match = "yes" | "no" | "unknown";

export interface ForwardProbe {
  /** The uplink network's bridge interface, such as `br-1a2b3c4d5e6f`. */
  readonly bridge: string;
  /** The address a probe packet would carry: an address inside the uplink's subnet. */
  readonly source: string;
  /**
   * The interfaces the host's default route leaves through, which is where the forwarded packet goes next. Empty when
   * the host has no IPv4 default route, and then no rule that names an output interface can be judged.
   */
  readonly egress: readonly string[];
}

/**
 * Why a backend says the packet goes or does not. `policy` is a chain that fell off its end with nothing to accept the
 * packet, which is the accident this check exists for: nothing on the host asks for that drop in particular.
 * `rule` is a `DROP` or `REJECT` that a person (or Docker) wrote on purpose, so the host is doing what it was told and
 * MiniBox must not widen it.
 */
export type DropCause = "policy" | "rule";

export interface BackendVerdict {
  readonly backend: string;
  /** `ok` accepts the uplink, `drop` drops it, `unknown` means the backend was not read or not fully understood. */
  readonly verdict: "ok" | "drop" | "unknown";
  /** Which kind of decision dropped the packet. Null unless `verdict` is `drop`. */
  readonly cause: DropCause | null;
  /** True when a rule the check cannot read might have accepted the packet, so a `drop` is only a guess. */
  readonly unsure: boolean;
  readonly reason: string;
}

export interface ForwardVerdict {
  /** Interfaces the helper found on the host. */
  readonly bridges: string[];
  /** The interfaces the host's default route leaves through. */
  readonly egress: string[];
  /** One entry per backend that answered, in the order the helper asked. */
  readonly backends: BackendVerdict[];
  /** True when at least one backend certainly drops traffic arriving on the uplink bridge. */
  readonly dropped: boolean;
  /**
   * Why it drops, when every backend that drops agrees and none of them is unsure. `policy` is the case a repair
   * fixes, `rule` is a drop somebody asked for, and null is the ambiguous case: nothing is offered there.
   */
  readonly cause: DropCause | null;
  /** The verdicts as one line, for the log and the API. */
  readonly detail: string;
}

interface Criterion {
  readonly option: string;
  readonly value: string | null;
  readonly negate: boolean;
}

interface Target {
  readonly kind: "accept" | "drop" | "return" | "chain" | "other";
  readonly name: string;
  /** `-g`: the packet does not come back, so when the chain it went to ends the chain that left is not walked on. */
  readonly goto?: boolean;
}

interface ParsedRule {
  readonly criteria: readonly Criterion[];
  readonly target: Target;
}

interface Chain {
  policy: string | null;
  readonly rules: ParsedRule[];
}

interface Backend {
  readonly name: string;
  readonly chains: Map<string, Chain>;
  readonly failed: boolean;
}

function targetOf(name: string, goto: boolean): Target {
  if (name === "ACCEPT") return { kind: "accept", name };
  if (name === "DROP" || name === "REJECT") return { kind: "drop", name };
  if (name === "RETURN") return { kind: "return", name };
  return { kind: "chain", name, goto };
}

/**
 * Splits an `iptables -S` rule into tokens. Output quotes only a comment or a chain label, and a quoted word is never
 * an option the check reads, so quotes are dropped and the words inside kept.
 */
function tokensOf(text: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (word !== "") tokens.push(word);
      word = "";
      continue;
    }
    word += char;
  }
  if (word !== "") tokens.push(word);
  return tokens;
}

/** A value is the next token unless that token is another option or a negation. */
const isValue = (token: string | undefined): token is string =>
  token !== undefined && !token.startsWith("-") && token !== "!";

function parseRule(tokens: readonly string[]): ParsedRule | null {
  if (tokens[0] !== "-A" || tokens[1] === undefined) return null;
  const criteria: Criterion[] = [];
  let target: Target | null = null;
  let negate = false;
  for (let index = 2; index < tokens.length; index += 1) {
    const option = tokens[index] ?? "";
    if (option === "!") {
      negate = !negate;
      continue;
    }
    const value = isValue(tokens[index + 1]) ? (tokens[index + 1] ?? null) : null;
    if (value !== null) index += 1;
    if (option === "-j" || option === "-g") {
      target = targetOf(value ?? "", option === "-g");
      // iptables prints the target last, and what follows it (`--reject-with`, `--log-prefix`, `--set-mark`) belongs to
      // the target. Those are not conditions on the packet: read as criteria they made a plain REJECT look like a rule
      // the check could not evaluate, so a host that rejects everything was reported as forwarding.
      break;
    }
    criteria.push({ option, value, negate });
    negate = false;
  }
  return target === null ? null : { criteria, target };
}

/** The address of a plain IPv4 literal or CIDR, as an integer, or null. */
function addressOf(text: string): number | null {
  const parsed = parseIpv4Cidr(text.includes("/") ? text : `${text}/32`);
  return parsed === null ? null : parsed.base;
}

function containsCidr(cidr: string, address: number): boolean | null {
  const network = parseIpv4Cidr(cidr);
  if (network === null) return null;
  const mask = network.prefix === 0 ? 0 : (0xffffffff << (32 - network.prefix)) >>> 0;
  return (address & mask) >>> 0 === network.base;
}

function interfaceMatch(pattern: string, name: string): Match {
  // A trailing `+` makes iptables match every interface whose name starts with the rest.
  if (pattern.endsWith("+")) return name.startsWith(pattern.slice(0, -1)) ? "yes" : "no";
  return pattern === name ? "yes" : "no";
}

const PROTOCOLS = new Set(["tcp", "6", "all", "0"]);
const SAFE_MODULES = new Set(["conntrack", "state", "tcp", "comment", "icmp", "icmpv6"]);

/**
 * Whether an output interface criterion is consistent with the probe packet, which leaves through the host's default
 * route. A rule naming an interface the packet cannot leave through certainly does not apply. A host with no default
 * route leaves the question open rather than guessing.
 */
function outputMatch(pattern: string, probe: ForwardProbe): Match {
  if (pattern === probe.bridge) return "no";
  // A host with no IPv4 default route leaves the question open rather than guessing.
  if (probe.egress.length === 0) return "unknown";
  const leaving = probe.egress.filter((name) => interfaceMatch(pattern, name) === "yes");
  if (leaving.length === 0) return "no";
  // Several default routes mean the packet may leave through any of them, so a rule for one is not certain.
  return probe.egress.length === 1 ? "yes" : "unknown";
}

/**
 * Whether one criterion is consistent with the probe packet: a new TCP connection that arrives on the uplink bridge and
 * leaves for the internet. A criterion the check cannot evaluate makes the rule one it does not fully understand, and
 * a rule it cannot fully understand never counts as an acceptance or as a drop.
 */
function criterionMatch(criterion: Criterion, probe: ForwardProbe, source: number): Match {
  const base = (): Match => {
    switch (criterion.option) {
      case "-i":
        return criterion.value === null ? "unknown" : interfaceMatch(criterion.value, probe.bridge);
      case "-o":
        return criterion.value === null ? "unknown" : outputMatch(criterion.value, probe);
      case "-s": {
        if (criterion.value === null) return "unknown";
        const contained = containsCidr(criterion.value, source);
        return contained === null ? "unknown" : contained ? "yes" : "no";
      }
      case "-p":
        return criterion.value === null || !PROTOCOLS.has(criterion.value) ? "no" : "yes";
      case "--ctstate":
      case "--state": {
        const states = (criterion.value ?? "").split(",");
        return states.includes("NEW") ? "yes" : "no";
      }
      case "-m":
        return criterion.value !== null && SAFE_MODULES.has(criterion.value) ? "yes" : "unknown";
      case "--syn":
      case "--comment":
        // A comment is a label, never a condition, so a commented rule is read like the same rule without it.
        return "yes";
      default:
        return "unknown";
    }
  };
  const verdict = base();
  if (verdict === "unknown" || !criterion.negate) return verdict;
  return verdict === "yes" ? "no" : "yes";
}

/**
 * Whether a rule applies to the probe: `yes`, `no`, or `unknown` when a criterion the check cannot read leaves it open.
 * An unknown rule is neither an acceptance nor a drop: it only makes the reading around it unsure.
 */
function ruleMatches(rule: ParsedRule, probe: ForwardProbe, source: number): Match {
  let unknown = false;
  for (const criterion of rule.criteria) {
    const verdict = criterionMatch(criterion, probe, source);
    if (verdict === "no") return "no";
    if (verdict === "unknown") unknown = true;
  }
  return unknown ? "unknown" : "yes";
}

/** The chains iptables itself owns. A `RETURN` means something different in one of these. */
const BUILT_IN_CHAINS = new Set(["INPUT", "FORWARD", "OUTPUT"]);

/**
 * What one chain decided. `accept` and `drop` are verdicts, with the cause of a drop. `none` is the chain falling off
 * its end, which returns to the caller. `return` is a `RETURN` in a built-in chain, which hands the packet to the
 * policy. `unsure` marks a walk where a rule it could not read might have decided otherwise, so nothing certain can be
 * said about a packet that reaches the end of it.
 */
type Decision =
  | { readonly kind: "accept" }
  | { readonly kind: "drop"; readonly cause: DropCause }
  | { readonly kind: "return" }
  | { readonly kind: "none"; readonly unsure: boolean };

/**
 * Walks one chain, following jumps, and stops at the first verdict. iptables' `RETURN` is two different things, and
 * both directions were wrong before: in a chain of MiniBox's own it ends that chain only, so the chain that jumped here
 * goes on with its next rule, while in `FORWARD` itself it ends the traversal, so the policy decides.
 */
function decide(chains: Map<string, Chain>, name: string, probe: ForwardProbe, source: number, depth = 0): Decision {
  if (depth > MAX_DEPTH) return { kind: "none", unsure: true };
  const chain = chains.get(name);
  if (!chain) return { kind: "none", unsure: false };
  let unsure = false;
  for (const rule of chain.rules) {
    const matched = ruleMatches(rule, probe, source);
    if (matched === "no") continue;
    // A rule the check cannot fully read is skipped, but it leaves the rest of this walk open: it may have accepted or
    // dropped the packet, and MiniBox must not claim either.
    if (matched === "unknown") {
      unsure = true;
      continue;
    }
    switch (rule.target.kind) {
      case "accept":
        return { kind: "accept" };
      case "drop":
        return { kind: "drop", cause: "rule" };
      case "return":
        // `RETURN` in a built-in chain ends the traversal, which leaves the packet to the chain's policy.
        if (BUILT_IN_CHAINS.has(name)) return { kind: "return" };
        // In a chain of its own it ends only that chain, and the caller carries on with its next rule.
        return { kind: "none", unsure };
      case "chain": {
        const inner = decide(chains, rule.target.name, probe, source, depth + 1);
        // A jump that returns decides nothing, so the caller keeps walking; one that accepted or dropped is the answer.
        if (inner.kind === "accept" || inner.kind === "drop") return inner;
        if (inner.kind === "none" && inner.unsure) unsure = true;
        if (inner.kind === "return") unsure = true;
        // `-g` never comes back: when the chain it went to ends, the packet carries on from where this chain was called,
        // so this chain's later rules are not walked. In `FORWARD` that leaves the packet to the policy.
        if (rule.target.goto === true) return { kind: "none", unsure };
        break;
      }
      default:
        // LOG, MARK and the rest do not decide a packet, so it keeps traversing the chain.
        break;
    }
  }
  return { kind: "none", unsure };
}

function verdictOf(backend: Backend, probe: ForwardProbe, source: number): BackendVerdict {
  if (backend.failed) {
    return {
      backend: backend.name,
      verdict: "unknown",
      cause: null,
      unsure: false,
      reason: `${backend.name} could not be read`,
    };
  }
  const forward = backend.chains.get("FORWARD");
  if (!forward) {
    return {
      backend: backend.name,
      verdict: "unknown",
      cause: null,
      unsure: false,
      reason: `${backend.name} has no FORWARD chain`,
    };
  }
  const decided = decide(backend.chains, "FORWARD", probe, source);
  if (decided.kind === "accept") {
    return {
      backend: backend.name,
      verdict: "ok",
      cause: null,
      unsure: false,
      reason: `${backend.name} accepts ${probe.bridge}`,
    };
  }
  if (decided.kind === "drop") {
    return {
      backend: backend.name,
      verdict: "drop",
      cause: decided.cause,
      unsure: false,
      reason:
        decided.cause === "rule"
          ? `${backend.name} drops traffic from ${probe.bridge} by a rule of its own`
          : `${backend.name}: its FORWARD policy drops traffic from ${probe.bridge}`,
    };
  }
  // Nothing in FORWARD accepted the packet, so the chain's own policy decides it.
  return policyVerdict(backend.name, forward, decided.kind === "none" ? decided.unsure : true, probe);
}

/**
 * The verdict when nothing in `FORWARD` accepted the packet. The policy decides it, and that is the case MiniBox may
 * offer to repair: nobody wrote a rule asking for this drop. A rule the check could not read leaves the cause open, so
 * the reading is reported as a drop with no cause: worth a warning, never worth a button.
 */
function policyVerdict(name: string, forward: Chain, unsure: boolean, probe: ForwardProbe): BackendVerdict {
  if (forward.policy === "ACCEPT") {
    return { backend: name, verdict: "ok", cause: null, unsure, reason: `${name} FORWARD policy is ACCEPT` };
  }
  if (forward.policy === "DROP" || forward.policy === "REJECT") {
    return {
      backend: name,
      verdict: "drop",
      cause: unsure ? null : "policy",
      unsure,
      reason: unsure
        ? `${name} FORWARD policy is ${forward.policy}, and a rule MiniBox does not read may accept ${probe.bridge}`
        : `${name} FORWARD policy is ${forward.policy} and no rule accepts ${probe.bridge}`,
    };
  }
  return {
    backend: name,
    verdict: "unknown",
    cause: null,
    unsure: true,
    reason: `${name} FORWARD policy is not readable`,
  };
}

interface ParsedReport {
  readonly bridges: string[];
  readonly egress: string[];
  readonly backends: Backend[];
}

/** Reads the helper's report: the interfaces it saw, the default route's interfaces, then one `iptables -S` per backend. */
export function parseForwardReport(output: string): ParsedReport {
  const lines = output.split("\n").map((line) => line.trimEnd());
  if (!lines.some((line) => line === FORWARD_REPORT_MARKER)) return { bridges: [], egress: [], backends: [] };
  const bridges: string[] = [];
  const egress: string[] = [];
  const backends: Backend[] = [];
  let current: { name: string; chains: Map<string, Chain>; failed: boolean } | null = null;
  const chainOf = (name: string): Chain => {
    const existing = current?.chains.get(name);
    if (existing) return existing;
    const created: Chain = { policy: null, rules: [] };
    current?.chains.set(name, created);
    return created;
  };
  for (const line of lines) {
    if (line.startsWith("@@bridges")) {
      bridges.push(...line.slice("@@bridges".length).trim().split(/\s+/).filter(Boolean));
      continue;
    }
    if (line.startsWith("@@egress")) {
      egress.push(...line.slice("@@egress".length).trim().split(/\s+/).filter(Boolean));
      continue;
    }
    if (line.startsWith("@@backend ")) {
      current = { name: line.slice("@@backend ".length).trim(), chains: new Map(), failed: false };
      continue;
    }
    if (line === "@@end") {
      if (current) backends.push(current);
      current = null;
      continue;
    }
    if (current === null) continue;
    if (line === "@@failed") {
      current.failed = true;
      continue;
    }
    if (line.startsWith("-P ")) {
      const parts = line.split(/\s+/);
      const chain = parts[1];
      if (chain !== undefined) chainOf(chain).policy = parts[2] ?? null;
      continue;
    }
    const rule = parseRule(tokensOf(line));
    if (!rule) continue;
    const chainName = line.split(/\s+/)[1] ?? "";
    chainOf(chainName).rules.push(rule);
  }
  if (current) backends.push(current);
  return { bridges, egress, backends };
}

/**
 * The verdict for one host: whether a new connection from the uplink bridge would be forwarded, per backend. A backend
 * the check could not read is left out of the decision, so a host with no readable backend reports nothing rather than
 * a false alarm.
 */
export function judgeForwardReport(
  output: string,
  probe: Omit<ForwardProbe, "egress"> & { egress?: readonly string[] },
): ForwardVerdict {
  const report = parseForwardReport(output);
  const full: ForwardProbe = { ...probe, egress: probe.egress ?? report.egress };
  const source = addressOf(full.source);
  const backends = report.backends.map((backend) => verdictOf(backend, full, source ?? 0));
  const dropped = backends.some((entry) => entry.verdict === "drop");
  const causes = new Set(backends.filter((entry) => entry.verdict === "drop").map((entry) => entry.cause));
  const unsure = backends.some((entry) => entry.unsure);
  const cause = dropped && causes.size === 1 && !unsure ? ([...causes][0] ?? null) : null;
  const detail =
    backends.length === 0 ? "no iptables backend answered" : backends.map((entry) => entry.reason).join("; ");
  return { bridges: report.bridges, egress: report.egress, backends, dropped, cause, detail };
}

/**
 * The `iptables` binaries the helper needs. `iptables` reads the nft table on a modern host; the legacy one may exist.
 * They are installed only when the image does not already carry them, and a failed install is not fatal: an image built
 * with the binaries, or a cached layer, needs no mirror, and a host with no internet must still get a reading rather
 * than a failed check on every pass. What the host could not answer is reported by the verdict itself.
 */
const INSTALL =
  "command -v iptables >/dev/null 2>&1 || apk add -q --no-cache iptables iptables-legacy >/dev/null 2>&1 || true";

/**
 * The interfaces the host's IPv4 default route leaves through, one per line. This is where a forwarded packet goes
 * next, so it is the only output interface a repair may name: accepting the uplink towards any other interface would
 * let a box past Docker's own isolation between bridges.
 */
export const FORWARD_EGRESS_SNIPPET = `ip -4 route show default 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") print $(i + 1)}' | sort -u`;

/**
 * Whether the legacy table is in use, asked without creating it: `iptables-legacy -S` would load the legacy modules and
 * make the host report a legacy table it never had. `/proc/net/ip_tables_names` lists the legacy tables that exist, and
 * with `hostNetwork` it is the host's own, since iptables tables belong to a network namespace.
 */
const LEGACY_EXISTS = "grep -qx filter /proc/net/ip_tables_names 2>/dev/null";

/**
 * Reads the host's filter table without changing it: every interface name, the default route's interfaces, then the
 * rules of each backend. The decision is made in TypeScript (`judgeForwardReport`), so the parsing is testable without
 * an engine.
 */
export const FORWARD_PROBE_SCRIPT = [
  "set -u",
  "umask 077",
  INSTALL,
  `echo "${FORWARD_REPORT_MARKER}"`,
  'printf "@@bridges"',
  "for name in $(ls /sys/class/net 2>/dev/null); do printf ' %s' \"$name\"; done",
  "echo",
  'printf "@@egress "',
  `{ ${FORWARD_EGRESS_SNIPPET} ; } | tr '\\n' ' '`,
  "echo",
  "for bin in iptables iptables-legacy; do",
  '  command -v "$bin" >/dev/null 2>&1 || continue',
  // A legacy table exists only if its modules are already loaded, and reading it must not load them.
  '  if [ "$bin" = iptables-legacy ]; then',
  `    ${LEGACY_EXISTS} || continue`,
  "  fi",
  '  echo "@@backend $bin"',
  '  if ! "$bin" -S 2>&1; then echo "@@failed"; fi',
  '  echo "@@end"',
  "done",
].join("\n");

/**
 * Adds MiniBox's own chain to every readable backend and **appends** a jump to it at the end of `FORWARD`, so a packet
 * reaches MiniBox's rule only when nothing above it decided, and the policy has its say first. Appending is what keeps
 * the repair from widening a host that is already tight: Docker's `DOCKER-USER` and the inter-network isolation chains
 * are walked before it, so a `DROP` someone wrote there still wins and the warning stays.
 *
 * The chain accepts a new connection that arrives on the uplink bridge and leaves through the host's default route, and
 * the replies that come back into it. Its `-o` is the interface the route actually uses, never "anything but the
 * bridge", so another bridge on the same host stays unreachable. An empty bridge removes the jump and the chain, which
 * is how a host stops carrying a rule it no longer needs. A second run replaces the rules instead of adding more.
 */
export const FORWARD_REPAIR_SCRIPT = [
  "set -eu",
  INSTALL,
  'chain="$MINIBOX_FORWARD_CHAIN"',
  'bridge="$MINIBOX_UPLINK_BRIDGE"',
  // A repair must not report success without changing anything, so a helper with no binary at all is a failure.
  "command -v iptables >/dev/null 2>&1 || { echo 'no iptables binary in the helper image' >&2; exit 4; }",
  // The interface to allow is found before anything is touched: a host that has none keeps the rules it already has,
  // instead of losing the jump the loop below removes first.
  'egress=""',
  'if [ -n "$bridge" ]; then',
  '  egress="$(',
  `    ${FORWARD_EGRESS_SNIPPET}`,
  '  )"',
  '  if [ -z "$egress" ]; then',
  "    echo 'the host has no IPv4 default route, so there is no interface to allow' >&2",
  "    exit 3",
  "  fi",
  "fi",
  "for bin in iptables iptables-legacy; do",
  '  command -v "$bin" >/dev/null 2>&1 || continue',
  // The legacy table is only touched when it already exists, since loading it would create one the host never had.
  '  if [ "$bin" = iptables-legacy ]; then',
  `    ${LEGACY_EXISTS} || continue`,
  "  fi",
  '  "$bin" -S FORWARD >/dev/null 2>&1 || continue',
  // Our jump is removed and re-added either way, so one installed above the isolation chains by an older MiniBox is
  // moved to the end rather than left where it was.
  '  while "$bin" -D FORWARD -j "$chain" 2>/dev/null; do :; done',
  '  if [ -z "$bridge" ]; then',
  '    "$bin" -F "$chain" 2>/dev/null || true',
  '    "$bin" -X "$chain" 2>/dev/null || true',
  "    continue",
  "  fi",
  '  "$bin" -N "$chain" 2>/dev/null || true',
  '  "$bin" -F "$chain"',
  "  for name in $egress; do",
  '    "$bin" -A "$chain" -i "$bridge" -o "$name" -j ACCEPT',
  '    "$bin" -A "$chain" -i "$name" -o "$bridge" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
  "  done",
  '  "$bin" -A FORWARD -j "$chain"',
  "done",
].join("\n");
