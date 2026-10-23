import type { Caller } from "../auth";
import type { BoxFrame } from "../host/live";
import type { HostCtx } from "../host/registry";
import { AppError, forbidden } from "../lib/errors";
import { msg } from "../lib/messages";
import type { ActivityPulse } from "../services/activity-pulse";
import { type Box, getBox } from "../services/boxes";
import type { RecordNote } from "../services/terminals";
import { boxVisible, scopeAllowed, viewOfBox } from "../tokens/model";
import { awakeBox, SshConnection, type SshTarget } from "./connection";
import type { FrameSocket } from "./duplex";
import type { HostKey } from "./host-key";
import { SSH_BOX_CONNECTIONS_MAX, SSH_CONNECTIONS_MAX } from "./policy";

export interface SshGatewayOptions {
  readonly hostKey: HostKey;
  readonly pulse: ActivityPulse;
  readonly record: RecordNote;
}

/** A WebSocket's place in the connection limits. It is taken before the box wakes and given back when the socket ends. */
export interface SshLease {
  readonly target: SshTarget;
  readonly release: () => void;
}

/**
 * Admits SSH WebSockets: checks the caller's scope and box visibility, enforces the connection limits, and wakes the
 * box. Everything after the handshake belongs to the connection the socket then carries.
 */
export class SshGateway {
  private readonly perBox = new Map<string, number>();
  private readonly open = new Map<string, Set<SshConnection>>();
  private total = 0;

  constructor(private readonly options: SshGatewayOptions) {}

  hostKeyView(): { algorithm: string; fingerprint: string; publicKey: string } {
    const { fingerprint, publicKey } = this.options.hostKey;
    return { algorithm: "ssh-ed25519", fingerprint, publicKey };
  }

  /**
   * Whether an SSH connection is open to the box. Idle sleep reads it: a shell, a transfer or a forward is work in
   * progress, as an attached terminal is, so the box stays up until the client disconnects.
   */
  hasOpenConnection(boxId: string): boolean {
    return (this.perBox.get(boxId) ?? 0) > 0;
  }

  async enter(host: HostCtx, ref: string, caller: Caller): Promise<SshLease> {
    const { box, forward } = await this.authorize(host, ref, caller);
    const release = this.admit(box.boxId);
    try {
      const awake = await awakeBox(host, box.boxId, (note) =>
        this.options.record(host.host.id, "rest", caller.principal, note),
      );
      return { target: { host, box: awake, principal: caller.principal, source: "rest", forward }, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Runs the handshake's checks without waking the box or holding a slot. A plain GET of the SSH path calls it, so
   * `minibox ssh-proxy` can print a refusal as an HTTP error before it opens the WebSocket.
   */
  async probe(host: HostCtx, ref: string, caller: Caller): Promise<void> {
    const { box } = await this.authorize(host, ref, caller);
    this.admit(box.boxId)();
  }

  connect(lease: SshLease, socket: FrameSocket): SshConnection {
    const boxId = lease.target.box.boxId;
    const connection = new SshConnection(
      lease.target,
      {
        hostKey: this.options.hostKey.privateKey,
        pulse: this.options.pulse,
        record: this.options.record,
        onEnd: () => {
          const set = this.open.get(boxId);
          set?.delete(connection);
          if (set?.size === 0) this.open.delete(boxId);
          lease.release();
        },
      },
      socket,
    );
    let set = this.open.get(boxId);
    if (!set) {
      set = new Set();
      this.open.set(boxId, set);
    }
    set.add(connection);
    return connection;
  }

  /**
   * A box frame from the host's sampler. A box that was stopped (by hand, idle sleep or TTL), deleted, or given a new
   * container ends its SSH connections, so an open client cannot start it again with its next channel.
   */
  onBoxFrame(frame: BoxFrame): void {
    const set = this.open.get(frame.boxId);
    if (!set || set.size === 0) return;
    let reason: string | null = null;
    if (frame.op === "remove") reason = "box removed";
    else if (!frame.box.running && frame.box.desired === "stopped")
      reason = `box stopped (${frame.box.stopReason ?? "manual"})`;
    if (reason === null) {
      if (frame.op !== "upsert") return;
      for (const connection of Array.from(set)) {
        if (connection.containerId !== frame.containerId) connection.disconnect("box rebuilt");
      }
      return;
    }
    for (const connection of Array.from(set)) connection.disconnect(reason);
  }

  private async authorize(host: HostCtx, ref: string, caller: Caller): Promise<{ box: Box; forward: boolean }> {
    if (caller.sessionId !== null) throw new AppError(401, "unauthorized", msg("ssh_bearer_required"));
    const { principal } = caller;
    if (principal.type === "box-self") throw forbidden(msg("ssh_forbidden"), { hint: msg("ssh_forbidden_hint") });
    if (principal.type === "token" && !scopeAllowed(principal.grants, "box:ssh")) {
      throw forbidden(msg("ssh_forbidden"), { hint: msg("ssh_forbidden_hint") });
    }
    const box = await getBox(host, ref);
    if (principal.type === "token" && !boxVisible(principal, viewOfBox(box, host.host.id))) {
      throw forbidden(msg("box_out_of_scope"));
    }
    const forward = principal.type === "owner" || scopeAllowed(principal.grants, "port:expose");
    return { box, forward };
  }

  private admit(boxId: string): () => void {
    const open = this.perBox.get(boxId) ?? 0;
    if (open >= SSH_BOX_CONNECTIONS_MAX) {
      throw new AppError(429, "too_many_requests", msg("ssh_box_limit", { max: SSH_BOX_CONNECTIONS_MAX }), undefined, {
        hint: msg("ssh_limit_hint"),
      });
    }
    if (this.total >= SSH_CONNECTIONS_MAX) {
      throw new AppError(429, "too_many_requests", msg("ssh_total_limit", { max: SSH_CONNECTIONS_MAX }), undefined, {
        hint: msg("ssh_limit_hint"),
      });
    }
    this.perBox.set(boxId, open + 1);
    this.total += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.total -= 1;
      const left = (this.perBox.get(boxId) ?? 1) - 1;
      if (left > 0) this.perBox.set(boxId, left);
      else this.perBox.delete(boxId);
    };
  }
}
