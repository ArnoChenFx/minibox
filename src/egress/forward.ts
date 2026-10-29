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
}

export interface BackendVerdict {
  readonly backend: string;
  /** `ok` accepts the uplink, `drop` drops it, `unknown` means the backend was not read. */
  readonly verdict: "ok" | "drop" | "unknown";
  readonly reason: string;
}

export interface ForwardVerdict {
  /** Interfaces the helper found on the host. */
  readonly bridges: string[];
  /** One entry per backend that answered, in the order the helper asked. */
  readonly backends: BackendVerdict[];
  /** True when at least one backend drops traffic arriving on the uplink bridge. */
  readonly dropped: boolean;
  /** The verdicts as one line, for the log and the API. */
  readonly detail: string;
}

interface Criterion {
  readonly option: string;
  readonly value: string | null;
  readonly negate: boolean;
}

type Target = { readonly kind: "accept" | "drop" | "return" | "chain" | "other"; readonly name: string };

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

function targetOf(name: string): Target {
  if (name === "ACCEPT") return { kind: "accept", name };
  if (name === "DROP" || name === "REJECT") return { kind: "drop", name };
  if (name === "RETURN") return { kind: "return", name };
  return { kind: "chain", name };
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
    if (option === "-j" || option === "-g") target = targetOf(value ?? "");
    else criteria.push({ option, value, negate });
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
 * Whether one criterion is consistent with the probe packet: a new TCP connection that arrives on the uplink bridge and
 * leaves for another interface. A criterion the check cannot evaluate makes the whole rule one it does not read, so a
 * rule with an unfamiliar match never counts as an acceptance.
 */
function criterionMatch(criterion: Criterion, probe: ForwardProbe, source: number): Match {
  const base = (): Match => {
    switch (criterion.option) {
      case "-i":
        return criterion.value === null ? "unknown" : interfaceMatch(criterion.value, probe.bridge);
      case "-o":
        // The probe leaves on whichever interface routes to the internet. Only a rule that names the bridge itself is
        // certainly about the other direction.
        return criterion.value === null ? "unknown" : criterion.value === probe.bridge ? "no" : "unknown";
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
        return "yes";
      default:
        return "unknown";
    }
  };
  const verdict = base();
  if (verdict === "unknown" || !criterion.negate) return verdict;
  return verdict === "yes" ? "no" : "yes";
}

/** Whether a rule certainly applies to the probe. A rule the check cannot fully evaluate does not apply. */
function ruleMatches(rule: ParsedRule, probe: ForwardProbe, source: number): boolean {
  let matched = true;
  for (const criterion of rule.criteria) {
    const verdict = criterionMatch(criterion, probe, source);
    if (verdict === "no") return false;
    if (verdict === "unknown") matched = false;
  }
  return matched;
}

/** The chains iptables itself owns. A `RETURN` means something different in one of these. */
const BUILT_IN_CHAINS = new Set(["INPUT", "FORWARD", "OUTPUT"]);

/**
 * What one chain decided. `return` is the packet leaving this chain without a verdict: back to the chain that jumped here,
 * or, from a built-in chain, to its policy. `none` is the chain falling off its end, which also returns to the caller.
 */
type Decision = "accept" | "drop" | "return" | "none";

/**
 * Walks one chain, following jumps, and stops at the first verdict. iptables' `RETURN` is two different things, and both
 * directions were wrong before: in a chain of MiniBox's own it ends that chain only, so the chain that jumped here goes on
 * with its next rule, while in `FORWARD` itself it ends the traversal, so the policy decides. Reading it as "skip to the
 * next rule of the same chain" both reported a drop on a host that forwards (Docker's `DOCKER-USER` returns first) and
 * missed a real drop when `FORWARD` returned before its accept rules.
 */
function decide(chains: Map<string, Chain>, name: string, probe: ForwardProbe, source: number, depth = 0): Decision {
  if (depth > MAX_DEPTH) return "none";
  const chain = chains.get(name);
  if (!chain) return "none";
  for (const rule of chain.rules) {
    if (!ruleMatches(rule, probe, source)) continue;
    switch (rule.target.kind) {
      case "accept":
        return "accept";
      case "drop":
        return "drop";
      case "return":
        // `RETURN` in a built-in chain ends the traversal, which leaves the packet to the chain's policy.
        if (BUILT_IN_CHAINS.has(name)) return "return";
        // In a chain of its own it ends only that chain, and the caller carries on with its next rule.
        return "none";
      case "chain": {
        const inner = decide(chains, rule.target.name, probe, source, depth + 1);
        // A jump that returns decides nothing, so the caller keeps walking; one that accepted or dropped is the answer.
        if (inner === "accept" || inner === "drop") return inner;
        break;
      }
      default:
        // LOG, MARK and the rest do not decide a packet, so it keeps traversing the chain.
        break;
    }
  }
  return "none";
}

function verdictOf(backend: Backend, probe: ForwardProbe, source: number): BackendVerdict {
  if (backend.failed) return { backend: backend.name, verdict: "unknown", reason: `${backend.name} could not be read` };
  const forward = backend.chains.get("FORWARD");
  if (!forward) return { backend: backend.name, verdict: "unknown", reason: `${backend.name} has no FORWARD chain` };
  const decided = decide(backend.chains, "FORWARD", probe, source);
  if (decided === "accept") {
    return { backend: backend.name, verdict: "ok", reason: `${backend.name} accepts ${probe.bridge}` };
  }
  if (decided === "drop") {
    return { backend: backend.name, verdict: "drop", reason: `${backend.name} drops traffic from ${probe.bridge}` };
  }
  if (forward.policy === "ACCEPT") {
    return { backend: backend.name, verdict: "ok", reason: `${backend.name} FORWARD policy is ACCEPT` };
  }
  if (forward.policy === "DROP" || forward.policy === "REJECT") {
    return {
      backend: backend.name,
      verdict: "drop",
      reason: `${backend.name} FORWARD policy is ${forward.policy} and no rule accepts ${probe.bridge}`,
    };
  }
  return { backend: backend.name, verdict: "unknown", reason: `${backend.name} FORWARD policy is not readable` };
}

interface ParsedReport {
  readonly bridges: string[];
  readonly backends: Backend[];
}

/** Reads the helper's report: the interfaces it saw, then one `iptables -S` dump per backend. */
export function parseForwardReport(output: string): ParsedReport {
  const lines = output.split("\n").map((line) => line.trimEnd());
  if (!lines.some((line) => line === FORWARD_REPORT_MARKER)) return { bridges: [], backends: [] };
  const bridges: string[] = [];
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
  return { bridges, backends };
}

/**
 * The verdict for one host: whether a new connection from the uplink bridge would be forwarded, per backend. A backend
 * the check could not read is left out of the decision, so a host with no readable backend reports nothing rather than a
 * false alarm.
 */
export function judgeForwardReport(output: string, probe: ForwardProbe): ForwardVerdict {
  const report = parseForwardReport(output);
  const source = addressOf(probe.source);
  const backends = report.backends.map((backend) => verdictOf(backend, probe, source ?? 0));
  const dropped = backends.some((entry) => entry.verdict === "drop");
  const detail =
    backends.length === 0 ? "no iptables backend answered" : backends.map((entry) => entry.reason).join("; ");
  return { bridges: report.bridges, backends, dropped, detail };
}

/** The `iptables` binaries the helper installs. `iptables` reads the nft table on a modern host; the legacy one may exist. */
const INSTALL = "apk add -q --no-cache iptables iptables-legacy >/dev/null";

/**
 * Reads the host's filter table without changing it: every interface name, then the rules of each backend. The
 * decision is made in TypeScript (`judgeForwardReport`), so the parsing is testable without an engine.
 */
export const FORWARD_PROBE_SCRIPT = [
  "set -u",
  INSTALL,
  `echo "${FORWARD_REPORT_MARKER}"`,
  'printf "@@bridges"',
  "for name in $(ls /sys/class/net 2>/dev/null); do printf ' %s' \"$name\"; done",
  "echo",
  "for bin in iptables iptables-legacy; do",
  '  command -v "$bin" >/dev/null 2>&1 || continue',
  '  echo "@@backend $bin"',
  '  if ! "$bin" -S 2>&1; then echo "@@failed"; fi',
  '  echo "@@end"',
  "done",
].join("\n");

/**
 * Adds MiniBox's own chain to every readable backend and jumps to it from the top of `FORWARD`, so the uplink is
 * accepted whatever the chain's policy is. Traffic from the bridge that leaves for another interface is accepted, and
 * the replies that come back into it are accepted; nothing else is. The chain is emptied first, so a second run with
 * another bridge replaces the rule instead of adding one. An empty bridge removes the jump and the chain, which is how a
 * host stops carrying a rule it no longer needs.
 */
export const FORWARD_REPAIR_SCRIPT = [
  "set -eu",
  INSTALL,
  'chain="$MINIBOX_FORWARD_CHAIN"',
  'bridge="$MINIBOX_UPLINK_BRIDGE"',
  "for bin in iptables iptables-legacy; do",
  '  command -v "$bin" >/dev/null 2>&1 || continue',
  '  "$bin" -S FORWARD >/dev/null 2>&1 || continue',
  '  if [ -z "$bridge" ]; then',
  '    while "$bin" -D FORWARD -j "$chain" 2>/dev/null; do :; done',
  '    "$bin" -F "$chain" 2>/dev/null || true',
  '    "$bin" -X "$chain" 2>/dev/null || true',
  "    continue",
  "  fi",
  '  "$bin" -N "$chain" 2>/dev/null || true',
  '  "$bin" -F "$chain"',
  '  "$bin" -A "$chain" -i "$bridge" ! -o "$bridge" -j ACCEPT',
  '  "$bin" -A "$chain" -o "$bridge" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
  '  "$bin" -C FORWARD -j "$chain" 2>/dev/null || "$bin" -I FORWARD 1 -j "$chain"',
  "done",
].join("\n");
