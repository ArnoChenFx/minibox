import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { setLogLevel } from "../src/lib/logger";
import { latestOwnerKeyUse, OWNER_KEY_HEADER, OWNER_KEY_NOTICE_MS, OWNER_KEY_OP } from "../src/mcp/owner-key";
import { OWNER } from "../src/operations/types";
import { TEST_KEY } from "./support/app";
import { mint, startHarness } from "./support/tokens";

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {} },
});
const PING = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });

let logged: string[];
let restoreConsole: () => void;

beforeEach(() => {
  logged = [];
  setLogLevel("warn");
  const errors = spyOn(console, "error").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  const logs = spyOn(console, "log").mockImplementation(() => {});
  restoreConsole = () => {
    errors.mockRestore();
    logs.mockRestore();
  };
});

afterEach(() => {
  restoreConsole();
  setLogLevel("error");
});

/** The warnings the logger wrote with this message, oldest first. */
function warnings(msg: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of logged) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.level === "warn" && entry.msg === msg) entries.push(entry);
    } catch {
      // The console also carries lines that are not log entries.
    }
  }
  return entries;
}

function rpc(base: string, token: string, body: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body,
  });
}

describe("owner access key on /mcp while MCP_ALLOW_OWNER_KEY is on", () => {
  test("is accepted, and the response tells the client so", async () => {
    const h = startHarness({ mcpAllowOwnerKey: true });
    try {
      const res = await rpc(h.base, TEST_KEY, INIT);
      expect(res.status).toBe(200);
      expect(res.headers.get(OWNER_KEY_HEADER)).toBe("accepted");
    } finally {
      h.stop();
    }
  });

  test("an agent token is not flagged, because only the owner key is", async () => {
    const h = startHarness({ mcpAllowOwnerKey: true });
    try {
      const { secret } = mint(h.app, { name: "agent", preset: "sandboxed-agent" });
      const res = await rpc(h.base, secret, PING);
      expect(res.status).toBe(200);
      expect(res.headers.get(OWNER_KEY_HEADER)).toBeNull();
      expect(h.app.events.list({ op: OWNER_KEY_OP }, { limit: 5 }).events).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("each use is recorded as an owner event, and uses within a minute share one row", async () => {
    const h = startHarness({ mcpAllowOwnerKey: true });
    try {
      for (let i = 0; i < 3; i++) expect((await rpc(h.base, TEST_KEY, PING)).status).toBe(200);
      const events = h.app.events.list({ op: OWNER_KEY_OP }, { limit: 10 }).events;
      expect(events.reduce((total, event) => total + event.count, 0)).toBe(3);
      expect(events.every((e) => e.status === "ok" && e.tier === "activity" && e.source === "mcp")).toBe(true);
      expect(events[0]?.principal).toMatchObject({ type: OWNER.type, id: OWNER.id });
    } finally {
      h.stop();
    }
  });

  test("the first accepted use is logged once, and the log names agent tokens as the fix", async () => {
    const h = startHarness({ mcpAllowOwnerKey: true });
    try {
      for (let i = 0; i < 3; i++) await rpc(h.base, TEST_KEY, PING);
      const found = warnings("mcp.owner_key_used");
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ hint: expect.stringContaining("agent token") });
      expect(warnings("mcp.owner_key_refused")).toHaveLength(0);
    } finally {
      h.stop();
    }
  });
});

describe("owner access key on /mcp once MCP_ALLOW_OWNER_KEY is off", () => {
  test("is refused with 401, and the hint points to the agent token setup", async () => {
    const h = startHarness({ mcpAllowOwnerKey: false });
    try {
      const res = await rpc(h.base, TEST_KEY, INIT);
      expect(res.status).toBe(401);
      expect(res.headers.get(OWNER_KEY_HEADER)).toBeNull();
      expect(await res.json()).toMatchObject({
        error: {
          code: "unauthorized",
          key: "mcp_owner_key_refused",
          hint: expect.stringContaining("docs/user-guide/agents.md#create-a-token-for-an-agent"),
        },
      });
    } finally {
      h.stop();
    }
  });

  test("agent tokens keep working on /mcp", async () => {
    const h = startHarness({ mcpAllowOwnerKey: false });
    try {
      const { secret } = mint(h.app, { name: "agent", preset: "sandboxed-agent" });
      const init = await rpc(h.base, secret, INIT);
      expect(init.status).toBe(200);
      const listed = await rpc(h.base, secret, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
    } finally {
      h.stop();
    }
  });

  test("each refused use is recorded as an error, and the first refusal is logged once", async () => {
    const h = startHarness({ mcpAllowOwnerKey: false });
    try {
      for (let i = 0; i < 3; i++) expect((await rpc(h.base, TEST_KEY, PING)).status).toBe(401);
      const events = h.app.events.list({ op: OWNER_KEY_OP }, { limit: 10 }).events;
      expect(events.reduce((total, event) => total + event.count, 0)).toBe(3);
      expect(
        events.every((e) => e.status === "error" && e.error?.code === "unauthorized" && e.error.status === 401),
      ).toBe(true);
      expect(warnings("mcp.owner_key_refused")).toHaveLength(1);
      expect(warnings("mcp.owner_key_used")).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("the REST API still takes the owner key, since the setting only gates /mcp", async () => {
    const h = startHarness({ mcpAllowOwnerKey: false });
    try {
      const res = await fetch(`${h.base}/api/boxes`, { headers: { authorization: `Bearer ${TEST_KEY}` } });
      expect(res.status).toBe(200);
    } finally {
      h.stop();
    }
  });
});

describe("the owner key notice for the console", () => {
  test("is absent until the owner key is used, then names the outcome under the current setting", async () => {
    const h = startHarness({ mcpAllowOwnerKey: true });
    try {
      const system = () =>
        fetch(`${h.base}/api/system`, { headers: { authorization: `Bearer ${TEST_KEY}` } }).then(
          (res) => res.json() as Promise<{ config: Record<string, unknown>; mcpOwnerKey: unknown }>,
        );
      const before = await system();
      expect(before.config).toMatchObject({ mcpAllowOwnerKey: true });
      expect(before.mcpOwnerKey).toBeNull();
      await rpc(h.base, TEST_KEY, PING);
      expect(await system()).toMatchObject({ mcpOwnerKey: { outcome: "accepted", lastUsedAt: expect.any(String) } });
    } finally {
      h.stop();
    }
  });

  test("reads the latest use within the notice window only, and only the outcome of the setting in force", () => {
    const h = startHarness({ mcpAllowOwnerKey: true });
    try {
      const now = Date.now();
      const hostId = h.app.hosts.get().host.id;
      expect(latestOwnerKeyUse(h.app.events, true, now)).toBeNull();
      h.app.record(hostId, "mcp", OWNER, { op: OWNER_KEY_OP, kind: "read", status: "ok", summary: "used" });
      expect(latestOwnerKeyUse(h.app.events, true, now)).toMatchObject({ outcome: "accepted" });
      expect(latestOwnerKeyUse(h.app.events, false, now)).toBeNull();
      expect(latestOwnerKeyUse(h.app.events, true, now + OWNER_KEY_NOTICE_MS + 60_000)).toBeNull();
    } finally {
      h.stop();
    }
  });
});
