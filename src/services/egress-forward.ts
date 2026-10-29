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
  /**
   * What dropped the packet, when the reading is certain about it. `policy` is a chain falling off its end, which is
   * what MiniBox may offer to repair; `rule` is a drop somebody asked for; null is the case with no button.
   */
  readonly cause: "policy" | "rule" | null;
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
  /**
   * True when MiniBox's chain is on the host because a repair ran and nothing has removed it since. A host with no
   * `proxy-only` box left does not keep a rule it no longer needs, and the chain goes with the host.
   */
  readonly installed: boolean;
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
 * `proxy-only` box makes no engine call at all; a host that has one is read on **every** pass, because the rule that
 * carries its boxes can vanish while nobody is looking.
 */
export class EgressForwardWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private firstPass: ReturnType<typeof setTimeout> | undefined;
  private readonly everyMs: number;
  private readonly state = new Map<string, ForwardState>();
  /** The pass each host is running, so two passes never read the same host at once and the repair can wait for one. */
  private readonly running = new Map<string, Promise<ForwardState | null>>();

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

  /**
   * A `proxy-only` box started on this host, which is the moment its owner looks at it, so the rules are read now
   * rather than at the next pass. A pass already reading the host is shared instead of repeated.
   */
  boxStarted(hostId: string): void {
    void this.readNow(hostId);
  }

  /** A host came back online, so its firewall may have reloaded while it was away: read it now. See `boxStarted`. */
  hostOnline(hostId: string): void {
    void this.readNow(hostId);
  }

  /** Reads one host out of turn, for a box that just started or a host that just came back. Never throws. */
  private async readNow(hostId: string): Promise<void> {
    // A watcher that was never started has no interval to keep, so a nudge before start() is dropped rather than
    // leaving a pass that nothing scheduled.
    if (!this.timer) return;
    const found = this.options.hosts.list().find((host) => host.host.id === hostId);
    if (!found || !this.wants(found)) return;
    try {
      await this.hostPass(found);
    } catch (e) {
      log.error("egress.forward_pass_failed", { host: hostId, error: String(e) });
    }
  }

  /**
   * Forgets a host that went away, so a host id that comes back does not inherit its verdict. A chain the install put on
   * that host is removed first: the engine is still reachable at this point, and leaving MiniBox's rule on a host it no
   * longer manages is a leftover nobody would look for.
   */
  forget(hostId: string): void {
    const host = this.options.hosts.list().find((candidate) => candidate.host.id === hostId);
    const installed = this.state.get(hostId)?.installed === true;
    this.state.delete(hostId);
    if (host && installed) void this.dropRule(host);
  }

  /**
   * One pass over every host. A host with no `proxy-only` box is skipped without an engine call; every other host is
   * read, whatever the last pass found, so a rule that disappears between passes is noticed. A failure is logged, never
   * thrown, and one host failing does not stop the others.
   */
  async tick(): Promise<void> {
    await this.dropIdleRules();
    const hosts = this.options.hosts.list().filter((host) => this.wants(host));
    await Promise.all(
      hosts.map((host) =>
        this.hostPass(host).catch((e) =>
          log.error("egress.forward_pass_failed", { host: host.host.id, error: String(e) }),
        ),
      ),
    );
  }

  /**
   * Whether a pass would do anything for this host. A host with no `proxy-only` box costs nothing and is skipped
   * outright; a host that has one is read on every pass, because the rule that carries its boxes can disappear when
   * nobody is looking (a firewall reload at three in the morning) and a reading taken only once would leave the
   * overview saying a host that has been broken for hours is fine.
   */
  private wants(host: HostCtx): boolean {
    // A host the check cannot run on is still read once, so the overview can say why it is not covered.
    if (skipReason(host) !== null) return this.state.get(host.host.id) === undefined;
    const boxes = proxyOnlyBoxes(host);
    if (boxes.length === 0) {
      this.state.delete(host.host.id);
      return false;
    }
    return true;
  }

  /**
   * Removes MiniBox's chain from a host that no longer needs it. A chain left behind after the last `proxy-only` box
   * was deleted keeps accepting traffic to the uplink bridge, which is no longer what this install wants, and it is the
   * kind of leftover a person finds later and cannot explain. One host failing does not stop the others.
   */
  private async dropIdleRules(): Promise<void> {
    const hosts = this.options.hosts.list();
    for (const host of hosts) {
      if (this.state.get(host.host.id)?.installed !== true) continue;
      if (proxyOnlyBoxes(host).length > 0) continue;
      await this.dropRule(host);
    }
  }

  /** Removes the chain from one host and forgets that it was installed there. Never throws. */
  private async dropRule(host: HostCtx): Promise<void> {
    try {
      await host.runtime.allowHostForward(host.prefix, "");
      const state = this.state.get(host.host.id);
      if (state) this.state.set(host.host.id, { ...state, installed: false });
      log.info("egress.forward_rule_removed", { host: host.host.id });
    } catch (e) {
      log.warn("egress.forward_rule_remove_failed", { host: host.host.id, error: String(e) });
    }
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
        cause: null,
        detail: "",
        boxes: proxyOnlyBoxes(host).map((spec) => spec.name),
        at: new Date().toISOString(),
        repaired: false,
        skipped: skip,
        installed: this.state.get(host.host.id)?.installed === true,
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
    verdict: { forwarding: boolean; cause: "policy" | "rule" | null; detail: string },
  ): ForwardState {
    const hostId = host.host.id;
    const names = boxes.map((spec) => spec.name);
    const previous = this.state.get(hostId);
    const state: ForwardState = {
      bridge,
      forwarding: verdict.forwarding,
      cause: verdict.cause,
      detail: verdict.detail,
      boxes: names,
      at: new Date().toISOString(),
      repaired: previous?.repaired === true && !verdict.forwarding,
      skipped: null,
      installed: previous?.installed === true,
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
    // Nothing to do when the last reading found the rules right: the button is only drawn for a warning, but the API
    // is open to anyone who asks.
    if (state.forwarding) throw conflict(msg("egress_forward_not_blocked"));
    // Only a drop nobody asked for may be widened. A `DROP` written on purpose, and a reading that left a rule unread,
    // are the host doing what it was told: adding MiniBox's rule there would undo that decision.
    if (state.cause !== "policy") {
      throw conflict(
        msg(state.cause === "rule" ? "egress_forward_not_repairable_rule" : "egress_forward_not_repairable_unclear"),
      );
    }
    await host.runtime.allowHostForward(host.prefix, state.bridge);
    // A pass that was already reading the host when the rule went in could answer with the rules before it, so it is
    // waited out and a fresh one reads what the repair left behind.
    await this.running.get(host.host.id)?.catch(() => null);
    const next = await this.hostPass(host);
    if (next === null) throw new AppError(502, "docker_error", msg("egress_forward_unchecked"));
    // The repair is a fact about the reading it answered with, not a verdict of its own: the next pass decides again.
    const repaired: ForwardState = { ...next, repaired: true, installed: true };
    this.state.set(host.host.id, repaired);
    return repaired;
  }
}

/** The boxes whose egress needs the host's forwarding rules: `proxy-only` boxes of this host. */
export function proxyOnlyBoxes(host: HostCtx): BoxSpec[] {
  return host.specs.list().filter((spec) => spec.hostId === host.host.id && needsForward(spec.egress));
}

const needsForward = (egress: BoxEgress | undefined): boolean => egress?.mode === "proxy-only";
