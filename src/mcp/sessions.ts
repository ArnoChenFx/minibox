import { ulid } from "../events/ulid";
import type { Principal } from "../operations/types";

interface Session {
  /** The principal that opened the session. Only that principal may use or close it. */
  readonly principalId: string;
  readonly toolsets: readonly string[];
  readonly protocol: string;
}

/** Subscribes to a token's end: called once when it is revoked or expires. Returns a function that stops listening. */
export type TokenWatch = (id: string, listener: () => void) => () => void;

const MAX_SESSIONS = 1000;

/**
 * In-memory MCP sessions. The id is also a valid `X-Minibox-Run` value. Oldest sessions are dropped past the cap. A
 * session belongs to the principal that opened it, and a token's sessions end with the token.
 */
export class McpSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly watched = new Set<string>();

  constructor(private readonly watchToken?: TokenWatch) {}

  open(principal: Principal, toolsets: readonly string[], protocol: string): string {
    const id = `mcp${ulid()}`;
    this.sessions.set(id, { principalId: principal.id, toolsets, protocol });
    if (principal.type === "token") this.endWithToken(principal.id);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return id;
  }

  get(id: string, principal: Principal): Session | undefined {
    const session = this.sessions.get(id);
    return session?.principalId === principal.id ? session : undefined;
  }

  close(id: string, principal: Principal): void {
    if (this.get(id, principal)) this.sessions.delete(id);
  }

  private endWithToken(tokenId: string): void {
    if (!this.watchToken || this.watched.has(tokenId)) return;
    this.watched.add(tokenId);
    this.watchToken(tokenId, () => {
      this.watched.delete(tokenId);
      for (const [id, session] of this.sessions) {
        if (session.principalId === tokenId) this.sessions.delete(id);
      }
    });
  }
}
