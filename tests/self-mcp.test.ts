import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SELF_MCP_INSTRUCTIONS } from "../src/mcp/instructions";
import { silenceLogs, TEST_KEY } from "./support/app";
import { selfTokenOf } from "./support/self";
import { call, finishedTask, type Harness, startHarness } from "./support/tokens";

const SELF_TOOLS = ["ask_human", "checkpoint", "get_info", "get_question", "get_task", "report_status"];

interface BoxRef {
  readonly id: string;
  readonly boxId: string;
  readonly name: string;
}

interface RpcBody {
  result?: {
    instructions?: string;
    tools?: { name: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  error?: { code: number; message: string };
}

/** One JSON-RPC request. A session id is sent when given, so the request runs in that session's toolsets. */
function rpc(
  base: string,
  token: string,
  message: Record<string, unknown>,
  options: { session?: string; path?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.session) headers["mcp-session-id"] = options.session;
  return fetch(`${base}${options.path ?? "/mcp"}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });
}

async function initialize(base: string, token: string, path = "/mcp"): Promise<{ session: string; body: RpcBody }> {
  const res = await rpc(
    base,
    token,
    { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } },
    { path },
  );
  return { session: res.headers.get("mcp-session-id") ?? "", body: (await res.json()) as RpcBody };
}

async function toolNames(base: string, token: string, session: string): Promise<string[]> {
  const res = await rpc(base, token, { id: 2, method: "tools/list" }, { session });
  const body = (await res.json()) as RpcBody;
  return (body.result?.tools ?? []).map((tool) => tool.name);
}

async function callTool(
  base: string,
  token: string,
  session: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; result: RpcBody["result"] }> {
  const res = await rpc(base, token, { id: 3, method: "tools/call", params: { name, arguments: args } }, { session });
  const body = (await res.json()) as RpcBody;
  return { status: res.status, result: body.result };
}

describe("a box's own agent over MCP", () => {
  let harness: Harness;
  let restoreLogs: () => void;
  let alpha: BoxRef;
  let token: string;

  beforeEach(async () => {
    restoreLogs = silenceLogs();
    harness = startHarness({ mcpAllowOwnerKey: true });
    const created = await call(harness.base, "/api/boxes", {
      body: { name: "alpha", cpus: 1, memoryMb: 256, selfToken: true },
    });
    expect(created.status).toBe(201);
    alpha = created.json.box as unknown as BoxRef;
    token = await selfTokenOf(harness.runtime, alpha.id);
  });
  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  test("is offered the self tools alone, and the instructions describe them", async () => {
    const init = await initialize(harness.base, token);
    expect(init.body.result?.instructions).toBe(SELF_MCP_INSTRUCTIONS);
    expect((await toolNames(harness.base, token, init.session)).toSorted()).toEqual(SELF_TOOLS);
  });

  test("the owner is offered none of the self tools, by default or with ?toolsets=self", async () => {
    const owner = await initialize(harness.base, TEST_KEY);
    const ownerTools = await toolNames(harness.base, TEST_KEY, owner.session);
    expect(ownerTools.filter((name) => SELF_TOOLS.includes(name))).toEqual([]);
    expect(ownerTools).toContain("list_boxes");

    const selfOnly = await initialize(harness.base, TEST_KEY, "/mcp?toolsets=self");
    expect(await toolNames(harness.base, TEST_KEY, selfOnly.session)).toEqual([]);
  });

  test("get_info, report_status, ask_human and get_question act on this box alone", async () => {
    const info = await callTool(harness.base, token, "", "get_info", {});
    expect(info.result?.isError).toBeFalsy();
    expect(info.result?.structuredContent).toMatchObject({ boxId: alpha.boxId, name: "alpha", running: true });

    const status = await callTool(harness.base, token, "", "report_status", {
      state: "working",
      note: "Tests running",
    });
    expect(status.result?.structuredContent).toEqual({ ok: true });
    expect(harness.app.events.list({ op: "self.status" }, { limit: 1 }).events[0]).toMatchObject({
      principal: { type: "box-self", id: alpha.boxId },
    });

    const asked = await callTool(harness.base, token, "", "ask_human", {
      message: "Ship the release?",
      options: ["yes", "no"],
    });
    const questionId = (asked.result?.structuredContent?.question as { id?: string } | undefined)?.id ?? "";
    expect(questionId).toMatch(/^q_/);

    const pending = await callTool(harness.base, token, "", "get_question", { id: questionId });
    expect(pending.result?.structuredContent).toMatchObject({ question: { id: questionId, answer: null } });

    expect((await call(harness.base, `/api/questions/${questionId}/answer`, { body: { answer: "no" } })).status).toBe(
      200,
    );
    const answered = await callTool(harness.base, token, "", "get_question", { id: questionId });
    expect(answered.result?.structuredContent).toMatchObject({ question: { answer: "no", answeredBy: "owner" } });
  });

  test("checkpoint runs as a task that get_task reports until it succeeds", async () => {
    const started = await callTool(harness.base, token, "", "checkpoint", {
      label: "before the migration",
      reason: "A schema change",
    });
    expect(started.result?.isError).toBeFalsy();
    const taskId = String(started.result?.structuredContent?.taskId ?? "");
    expect(taskId).not.toBe("");

    await finishedTask(harness.base, taskId);
    const polled = await callTool(harness.base, token, "", "get_task", { id: taskId });
    expect(polled.result?.structuredContent).toMatchObject({ id: taskId, status: "succeeded" });
  });

  test("an owner tool is refused to the box even when its toolset is named, and a tool outside the self toolset does not run", async () => {
    const named = await initialize(harness.base, token, "/mcp?toolsets=core");
    const listed = await callTool(harness.base, token, named.session, "list_boxes", {});
    expect(listed.result).toMatchObject({ isError: true });
    expect(listed.result?.structuredContent).toMatchObject({ code: "forbidden" });

    const defaults = await initialize(harness.base, token);
    const exec = await callTool(harness.base, token, defaults.session, "exec", { box: alpha.id, argv: ["true"] });
    expect(exec.result).toMatchObject({ isError: true });
    expect(exec.result?.structuredContent).toMatchObject({ code: "validation_failed" });
  });

  test("a revoked self token ends its MCP session, and the next call is refused", async () => {
    const init = await initialize(harness.base, token);
    expect(await toolNames(harness.base, token, init.session)).toHaveLength(SELF_TOOLS.length);

    expect((await call(harness.base, `/api/boxes/${alpha.id}/self-token`, { method: "DELETE" })).status).toBe(200);

    const after = await rpc(harness.base, token, { id: 4, method: "tools/list" }, { session: init.session });
    expect(after.status).toBe(401);
  });
});
