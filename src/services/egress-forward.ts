import type { BoxEgress } from "../egress/policy";
import { UPLINK_SUBNET } from "../egress/pool";
import type { HostCtx, HostRegistry } from "../host/registry";
import { egressUplinkName } from "../labels";
import { AppError, conflict } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { BoxSpec } from "../specs/types";

/** The first pass runs this soon after start, so a host that lost its rules is found without waiting a full interval. */
const FIRST_PASS_MS = 30_000;

/**
 * What the last pass of one host found. `forwarding: false` is the condition the overview lists; `detail` is what the
 * host's iptables backends said, for the log and the API. A host that never ran a pass has no entry.
 */
export interface ForwardState {
  /** The uplink bridge the check read, such as `br-1a2b3c4d5e6f`. */
  readonly bridge: string;
  /** True when a new connection from the uplink would be forwarded. */
  readonly forwarding: boolean;
  /** One line per backend that answered. */
  readonly detail: string;
  /** The `proxy-only` boxes that lose the internet while `forwarding` is false. */
  readonly boxes: string[];
  /** When the pass ran, ISO 8601. */
  readonly at: string;
  /**
   * True when the owner asked MiniBox to repair the rules and the repair ran. The warning stays: it is cleared by the
   * next pass that finds the rules right, not by the repair itself.
   */
  readonly repaired: boolean;
  /** Why the check could not run on this host, when it could not. Null when it ran. */
  readonly skipped: string | null;
}

export interface ForwardOptions {
  readonly hosts: HostRegistry;
  /** Overrides `EGRESS_FORWARD_CHECK_INTERVAL_SEC`. Tests set it. */
  readonly everyMs?: number;
}

/** Why a check cannot run on a host at all, or null when it can. */
function skipReason(host: HostCtx): string | null {
  if (host.host.transport === "agent") return "agent host: its engine has no helper container for this check";
  return null;
}

/**
 * Watches the host's `FORWARD` chain for the boxes that need it. A `proxy-only` box has no route of its own: its proxy
 * reaches the internet through Docker's forwarding rules on the shared uplink bridge, which MiniBox does not write. A
 * host whose policy is `DROP`, a leftover `iptables-legacy` table or a firewall reload drops that traffic, and every
 * `proxy-only` box on it silently loses the internet while it still starts, execs and serves SSH.
 *
 * A pass reads the rules and records the verdict. It logs once when the condition appears and stays quiet on every pass
 * after that, and it changes nothing: the owner repairs the rules from the overview, or by hand. A host with no
 * `proxy-only` box, a host whose condition is already known, and a host that never had the rules read all make no
 * engine call, except that the condition is checked again when a `proxy-only` box starts or a host comes back online.
 */
export class EgressForwardWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private firstPass: ReturnType<typeof setTimeout> | undefined;
  private readonly everyMs: number;
  private readonly state = new Map<string, ForwardState>();
  /** The pass each host is running, so two passes never read the same host at once and the repair can wait for one. */
  private readonly running = new Map<string, Promise<ForwardState | null>>();
  /** Hosts asked to read again at their next opportunity, by a box starting or a host coming back online. */
  private readonly pending = new Set<string>();

  constructor(private readonly options: ForwardOptions) {
    this.everyMs = options.everyMs ?? 600_000;
  }

  start(everyMs?: number): void {
    if (this.timer) return;
    const interval = everyMs ?? this.everyMs;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
    this.firstPass = setTimeout(() => void this.tick(), Math.min(interval, FIRST_PASS_MS));
    this.firstPass.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    clearTimeout(this.firstPass);
    this.timer = undefined;
    this.firstPass = undefined;
  }

  /** What a host's last pass found, or null when it never ran one. */
  stateOf(hostId: string): ForwardState | null {
    return this.state.get(hostId) ?? null;
  }

  /** A `proxy-only` box started: read the rules again at the next pass, since the owner looks at that moment. */
  boxStarted(hostId: string): void {
    this.pending.add(hostId);
  }

  /** A host came back online: read the rules again at the next pass, whatever was known before. */
  hostOnline(hostId: string): void {
    this.pending.add(hostId);
  }

  /** Forgets a host that went away, so a host id that comes back does not inherit its verdict. */
  forget(hostId: string): void {
    this.state.delete(hostId);
    this.pending.delete(hostId);
  }

  /**
   * One pass over every host. A host with no `proxy-only` box is skipped without an engine call; a host whose condition
   * is already known is read again only when something asked for it. A failure is logged, never thrown.
   */
  async tick(): Promise<void> {
    const hosts = this.options.hosts.list().filter((host) => this.wants(host));
    await Promise.all(
      hosts.map((host) =>
        this.hostPass(host).catch((e) =>
          log.error("egress.forward_pass_failed", { host: host.host.id, error: String(e) }),
        ),
      ),
    );
  }

  /** Whether a pass would do anything for this host, which is what keeps an idle host free of engine calls. */
  private wants(host: HostCtx): boolean {
    // A host the check cannot run on is still read once, so the overview can say why it is not covered.
    if (skipReason(host) !== null) return this.state.get(host.host.id) === undefined;
    const boxes = proxyOnlyBoxes(host);
    if (boxes.length === 0) {
      this.state.delete(host.host.id);
      return false;
    }
    const known = this.state.get(host.host.id);
    if (known && !this.pending.has(host.host.id) && known.forwarding) return false;
    return true;
  }

  /** Reads one host and records what it found, or returns null when the pass could not run. */
  private async hostPass(host: HostCtx): Promise<ForwardState | null> {
    const skip = skipReason(host);
    if (skip !== null) {
      // The reason a host is not covered is worth one line, once: an operator reading the log should not have to guess
      // why a host with proxy-only boxes never reports on them.
      if (this.state.get(host.host.id)?.skipped !== skip) {
        log.info("egress.forward_skipped", { host: host.host.id, reason: skip });
      }
      const skipped: ForwardState = {
        bridge: "",
        forwarding: false,
        detail: "",
        boxes: proxyOnlyBoxes(host).map((spec) => spec.name),
        at: new Date().toISOString(),
        repaired: false,
        skipped: skip,
      };
      this.state.set(host.host.id, skipped);
      return skipped;
    }
    const boxes = proxyOnlyBoxes(host);
    if (boxes.length === 0) return null;
    // A pass already reading this host is shared rather than repeated, so a tick and a repair never overlap.
    const inFlight = this.running.get(host.host.id);
    if (inFlight) return inFlight;
    const pass = this.read(host, boxes).finally(() => this.running.delete(host.host.id));
    this.running.set(host.host.id, pass);
    return pass;
  }

  /** The engine calls of one pass: the uplink's bridge, then the host's rules. */
  private async read(host: HostCtx, boxes: readonly BoxSpec[]): Promise<ForwardState | null> {
    this.pending.delete(host.host.id);
    const uplink = egressUplinkName(host.prefix);
    const network = (await host.runtime.listNetworks()).find((candidate) => candidate.name === uplink);
    const bridge = network?.bridge ?? null;
    if (bridge === null) {
      // The uplink is missing, so no proxy has a route out. A box that starts recreates it, and that start asks for a
      // pass of its own, so this is left to the box rather than reported as a firewall problem.
      log.warn("egress.forward_uplink_missing", { host: host.host.id, network: uplink });
      return null;
    }
    const verdict = await host.runtime.checkHostForward(host.prefix, bridge, UPLINK_SUBNET);
    return this.record(host, bridge, boxes, verdict);
  }

  private record(
    host: HostCtx,
    bridge: string,
    boxes: readonly BoxSpec[],
    verdict: { forwarding: boolean; detail: string },
  ): ForwardState {
    const hostId = host.host.id;
    const names = boxes.map((spec) => spec.name);
    const previous = this.state.get(hostId);
    const state: ForwardState = {
      bridge,
      forwarding: verdict.forwarding,
      detail: verdict.detail,
      boxes: names,
      at: new Date().toISOString(),
      repaired: previous?.repaired === true && !verdict.forwarding,
      skipped: null,
    };
    this.state.set(hostId, state);
    if (verdict.forwarding) {
      if (previous !== undefined && previous.forwarding === false && previous.skipped === null) {
        log.info("egress.forward_restored", { host: hostId, bridge, boxes: names });
      }
      return state;
    }
    // One line when the condition appears, and nothing on the passes after it: a headless operator reads the log, and a
    // pass that repeats the same line every ten minutes is noise. A first reading that already finds it blocked is an
    // appearance too, which is what a restart of MiniBox on a broken host produces. A pass a box start or a host coming
    // back asked for does not repeat it either.
    if (previous?.forwarding === false) return state;
    log.error("egress.forward_blocked", {
      host: hostId,
      bridge,
      boxes: names,
      detail: verdict.detail,
      action: "confirm the repair on the overview, or add the FORWARD rule by hand (see docs/admin/network-egress.md)",
    });
    return state;
  }

  /**
   * Adds MiniBox's own `FORWARD` chain for the host's uplink, which is what the overview's button does after the owner
   * confirms it. Nothing runs before that. The warning stays until a pass finds the rules right, so a repair that does
   * not work is still visible.
   */
  async repair(host: HostCtx): Promise<ForwardState> {
    const skip = skipReason(host);
    if (skip !== null) throw conflict(msg("egress_forward_unsupported", { reason: skip }));
    if (proxyOnlyBoxes(host).length === 0) throw conflict(msg("egress_forward_no_boxes"));
    const state = this.state.get(host.host.id);
    if (state?.bridge === undefined || state.bridge === "") {
      throw conflict(msg("egress_forward_unchecked"));
    }
    await host.runtime.allowHostForward(host.prefix, state.bridge);
    // A pass that was already reading the host when the rule went in could answer with the rules before it, so it is
    // waited out and a fresh one reads what the repair left behind.
    await this.running.get(host.host.id)?.catch(() => null);
    const next = await this.hostPass(host);
    if (next === null) throw new AppError(502, "docker_error", msg("egress_forward_unchecked"));
    // The repair is a fact about the reading it answered with, not a verdict of its own: the next pass decides again.
    const repaired: ForwardState = { ...next, repaired: true };
    this.state.set(host.host.id, repaired);
    return repaired;
  }
}

/** The boxes whose egress needs the host's forwarding rules: `proxy-only` boxes of this host. */
export function proxyOnlyBoxes(host: HostCtx): BoxSpec[] {
  return host.specs.list().filter((spec) => spec.hostId === host.host.id && needsForward(spec.egress));
}

const needsForward = (egress: BoxEgress | undefined): boolean => egress?.mode === "proxy-only";
