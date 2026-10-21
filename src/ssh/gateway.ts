import type { Caller } from "../auth";
import type { HostCtx } from "../host/registry";
import { AppError, forbidden } from "../lib/errors";
import { msg } from "../lib/messages";
import type { ActivityPulse } from "../services/activity-pulse";
import { getBox } from "../services/boxes";
import type { RecordNote } from "../services/terminals";
import { boxVisible, scopeAllowed, viewOfBox } from "../tokens/model";
import { CommandTracker } from "./commands";
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
  private total = 0;
  private readonly commands = new CommandTracker();

  constructor(private readonly options: SshGatewayOptions) {}

  hostKeyView(): { algorithm: string; fingerprint: string; publicKey: string } {
    const { fingerprint, publicKey } = this.options.hostKey;
    return { algorithm: "ssh-ed25519", fingerprint, publicKey };
  }

  /** Whether a non-interactive command the gateway started is still running in the box. Idle sleep reads it. */
  hasCommandRunning(boxId: string): boolean {
    return this.commands.active(boxId);
  }

  async enter(host: HostCtx, ref: string, caller: Caller): Promise<SshLease> {
    if (caller.sessionId !== null) throw new AppError(401, "unauthorized", msg("ssh_bearer_required"));
    const { principal } = caller;
    if (principal.type === "token" && !scopeAllowed(principal.grants, "box:ssh")) {
      throw forbidden(msg("ssh_forbidden"), { hint: msg("ssh_forbidden_hint") });
    }
    const found = await getBox(host, ref);
    if (principal.type === "token" && !boxVisible(principal, viewOfBox(found, host.host.id))) {
      throw forbidden(msg("box_out_of_scope"));
    }
    const release = this.admit(found.boxId);
    try {
      const box = await awakeBox(host, found.boxId, this.options.record);
      const forward = principal.type === "owner" || scopeAllowed(principal.grants, "port:expose");
      return { target: { host, box, principal, source: "rest", forward }, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  connect(lease: SshLease, socket: FrameSocket): SshConnection {
    return new SshConnection(
      lease.target,
      {
        hostKey: this.options.hostKey.privateKey,
        pulse: this.options.pulse,
        record: this.options.record,
        commands: this.commands,
        onEnd: lease.release,
      },
      socket,
    );
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
