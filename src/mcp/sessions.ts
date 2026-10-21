import { ulid } from "../events/ulid";

interface Session {
  readonly toolsets: readonly string[];
  readonly protocol: string;
}

const MAX_SESSIONS = 1000;

/** In-memory MCP sessions. The id is also a valid `X-Minibox-Run` value. Oldest sessions are dropped past the cap. */
export class McpSessions {
  private readonly sessions = new Map<string, Session>();

  open(toolsets: readonly string[], protocol: string): string {
    const id = `mcp${ulid()}`;
    this.sessions.set(id, { toolsets, protocol });
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return id;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  close(id: string): void {
    this.sessions.delete(id);
  }
}
