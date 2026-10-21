/** The result of one tmux command, as the runtime reports it. */
export interface TmuxRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A terminal attached to a session. `output` receives what the session prints; `end` detaches it. */
export interface TmuxClient {
  output(text: string): void;
  end(): void;
}

interface FakeSession {
  readonly name: string;
  /** tmux's session id, such as `$3`. A session made again under the same name gets a new one. */
  readonly id: string;
  readonly created: number;
  readonly options: Map<string, string>;
  /** The pane transcript. The last line is the one being typed on. */
  readonly lines: string[];
  readonly clients: Set<TmuxClient>;
}

/** Rows a pane shows. `capture-pane` returns history followed by this many rows, blank rows included. */
const SCREEN_ROWS = 24;
const NO_SERVER = "no server running on /tmp/tmux-1000/default";

/** Which flags take a value, and which are switches, for each command the service runs. */
const SYNTAX: Record<string, { values: string[]; switches: string[] }> = {
  "new-session": { values: ["s", "c", "x", "y", "n"], switches: ["d"] },
  "has-session": { values: ["t"], switches: [] },
  "list-sessions": { values: ["F"], switches: [] },
  "set-option": { values: ["t"], switches: ["g", "s", "p", "w", "q", "a", "o"] },
  "display-message": { values: ["t"], switches: ["p"] },
  "kill-session": { values: ["t"], switches: [] },
  "capture-pane": { values: ["t", "S", "E"], switches: ["p", "J", "e"] },
  "send-keys": { values: ["t", "N"], switches: ["H", "l", "R", "X"] },
};

const KEY_TEXT: Record<string, string> = {
  Enter: "\n",
  Tab: "\t",
  Space: " ",
  BSpace: "",
  Escape: "",
  "C-c": "^C\n",
};

interface Parsed {
  readonly values: Map<string, string>;
  readonly switches: Set<string>;
  readonly positional: string[];
}

/** Splits a command's arguments the way tmux does for the flags MiniBox uses. Anything after `--` is positional. */
function parseArgs(command: string, args: readonly string[]): Parsed {
  const spec = SYNTAX[command] ?? { values: [], switches: [] };
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    const flag = /^-([A-Za-z])$/.exec(arg)?.[1];
    if (flag && spec.values.includes(flag)) {
      values.set(flag, args[++i] ?? "");
    } else if (flag && spec.switches.includes(flag)) {
      switches.add(flag);
    } else {
      positional.push(arg);
    }
  }
  return { values, switches, positional };
}

/** The session a target names: `=name`, `=name:`, or a bare `name`. */
function targetName(target: string | undefined): string {
  return (target ?? "").replace(/^=/, "").replace(/[:.].*$/, "");
}

function fail(code: number, stderr: string): TmuxRun {
  return { code, stdout: "", stderr: `${stderr}\n` };
}

function ok(stdout = ""): TmuxRun {
  return { code: 0, stdout, stderr: "" };
}

/**
 * An in-memory tmux server for each container, for unit tests. It understands the commands and targets MiniBox uses and
 * nothing more. A pane is a transcript: sent or typed text is appended, and a newline starts a new line. A server with no
 * sessions does not exist, as with tmux, so commands report that no server is running.
 */
export class FakeTmux {
  private readonly servers = new Map<string, Map<string, FakeSession>>();
  private nextSessionId = 0;

  /** Runs `tmux <args>` inside container `containerId`. A leading `-u` is accepted and ignored. */
  run(containerId: string, argv: readonly string[]): TmuxRun {
    const args = argv[0] === "-u" ? argv.slice(1) : argv;
    const [command = "", ...rest] = args;
    const sessions = this.servers.get(containerId);
    const parsed = parseArgs(command, rest);
    if (command === "new-session") return this.newSession(containerId, parsed);
    if (!sessions || sessions.size === 0) return fail(1, NO_SERVER);
    const name = targetName(parsed.values.get("t"));
    const session = sessions.get(name);
    switch (command) {
      case "has-session":
        return session ? ok() : fail(1, `can't find session: ${name}`);
      case "list-sessions":
        return ok([...sessions.values()].map((s) => expand(parsed.values.get("F") ?? "", s)).join("\n") + "\n");
      case "set-option":
        if (parsed.switches.has("s") && !parsed.values.has("t")) return ok();
        if (!session) return fail(1, `can't find session: ${name}`);
        session.options.set(parsed.positional[0] ?? "", parsed.positional[1] ?? "");
        return ok();
      case "display-message":
        // Real tmux exits 0 with an empty line for a target it cannot find; callers tell by the output.
        if (!session) return ok("\n");
        return ok(`${expand(parsed.positional[0] ?? "", session)}\n`);
      case "kill-session":
        if (!session) return fail(1, `can't find session: ${name}`);
        this.kill(containerId, session);
        return ok();
      case "capture-pane":
        if (!session) return fail(1, `can't find pane: ${name}`);
        return ok(screenOf(session).join("\n") + "\n");
      case "send-keys":
        if (!session) return fail(1, `can't find pane: ${name}`);
        this.sendKeys(session, parsed);
        return ok();
      default:
        return fail(1, `unknown command: ${command}`);
    }
  }

  /** Attaches `client` to the session. It receives the current screen at once. Returns false when there is no such session. */
  attach(containerId: string, name: string, client: TmuxClient): boolean {
    const session = this.servers.get(containerId)?.get(name);
    if (!session) return false;
    session.clients.add(client);
    client.output(screenOf(session).join("\r\n"));
    return true;
  }

  /** Detaches a client, for example when its exec ends. Does nothing for a client that is not attached. */
  detach(containerId: string, name: string, client: TmuxClient): void {
    this.servers.get(containerId)?.get(name)?.clients.delete(client);
  }

  /** A person types into the session through an attached terminal. */
  type(containerId: string, name: string, text: string): void {
    const session = this.servers.get(containerId)?.get(name);
    if (session) write(session, text);
  }

  /** The text `capture-pane` would show, without padding. Undefined when there is no such session. */
  paneText(containerId: string, name: string): string | undefined {
    const session = this.servers.get(containerId)?.get(name);
    return session?.lines.join("\n");
  }

  sessionNames(containerId: string): string[] {
    return [...(this.servers.get(containerId)?.keys() ?? [])];
  }

  /** The box stopped or was removed. Its tmux server dies with it, and attached terminals end. */
  stop(containerId: string): void {
    const sessions = this.servers.get(containerId);
    if (!sessions) return;
    this.servers.delete(containerId);
    for (const session of sessions.values()) {
      for (const client of session.clients) client.end();
    }
  }

  private newSession(containerId: string, parsed: Parsed): TmuxRun {
    let sessions = this.servers.get(containerId);
    const name = parsed.values.get("s") ?? "";
    if (sessions?.has(name)) return fail(1, `duplicate session: ${name}`);
    if (!sessions) {
      sessions = new Map();
      this.servers.set(containerId, sessions);
    }
    sessions.set(name, {
      name,
      id: `$${this.nextSessionId++}`,
      created: Math.floor(Date.now() / 1000),
      options: new Map(),
      lines: [""],
      clients: new Set(),
    });
    return ok();
  }

  private kill(containerId: string, session: FakeSession): void {
    const sessions = this.servers.get(containerId);
    sessions?.delete(session.name);
    if (sessions?.size === 0) this.servers.delete(containerId);
    for (const client of session.clients) {
      client.output("\r\n[exited]\r\n");
      client.end();
    }
  }

  private sendKeys(session: FakeSession, parsed: Parsed): void {
    if (parsed.switches.has("H")) {
      const bytes = Buffer.from(parsed.positional.map((hex) => Number.parseInt(hex, 16)));
      write(session, bytes.toString("utf8"));
      return;
    }
    for (const key of parsed.positional) write(session, KEY_TEXT[key] ?? key);
  }
}

function write(session: FakeSession, text: string): void {
  const normalized = text.replace(/\r\n?/g, "\n");
  const parts = normalized.split("\n");
  parts.forEach((part, index) => {
    if (index > 0) session.lines.push("");
    session.lines[session.lines.length - 1] += part;
  });
  for (const client of session.clients) client.output(normalized.replace(/\n/g, "\r\n"));
}

function screenOf(session: FakeSession): string[] {
  const rows = [...session.lines];
  while (rows.length < SCREEN_ROWS) rows.push("");
  return rows;
}

function expand(format: string, session: FakeSession): string {
  return format.replace(/#\{([^}]+)\}/g, (_match, key: string) => {
    if (key === "session_name") return session.name;
    if (key === "session_id") return session.id;
    if (key === "session_created") return String(session.created);
    if (key === "session_attached") return String(session.clients.size);
    return session.options.get(key) ?? "";
  });
}
