import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { connect } from "node:net";

import { QUESTION_PENDING_PER_BOX } from "../src/questions/types";
import { SELF_QUOTA } from "../src/tokens/self-policy";
import { silenceLogs } from "./support/app";
import { selfTokenOf } from "./support/self";
import { call, finishedTask, type Harness, refused, startHarness } from "./support/tokens";

interface BoxRef {
  readonly id: string;
  readonly boxId: string;
  readonly name: string;
  readonly revision: number;
}

interface QuestionView {
  id: string;
  boxId: string;
  message: string;
  options: string[];
  answer: string | null;
  answeredBy: string | null;
}

describe("the self operations over REST", () => {
  let harness: Harness;
  let restoreLogs: () => void;
  let alpha: BoxRef;
  let bravo: BoxRef;
  let alphaToken: string;
  let bravoToken: string;

  beforeEach(async () => {
    restoreLogs = silenceLogs();
    harness = startHarness();
    alpha = await createBox("alpha", { selfToken: true, ttlSec: 3600 });
    bravo = await createBox("bravo", { selfToken: true });
    alphaToken = await selfTokenOf(harness.runtime, alpha.id);
    bravoToken = await selfTokenOf(harness.runtime, bravo.id);
  });
  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  async function createBox(name: string, extra: Record<string, unknown> = {}): Promise<BoxRef> {
    const res = await call(harness.base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256, ...extra } });
    expect(res.status).toBe(201);
    return res.json.box as BoxRef;
  }

  /** The box's agent, calling with its own token. */
  const agent = (token: string) => ({
    get: (path: string) => call(harness.base, path, { token, method: "GET" }),
    post: (path: string, body: unknown) => call(harness.base, path, { token, method: "POST", body }),
  });
  const owner = (path: string, method: string, body?: unknown) => call(harness.base, path, { method, body });

  async function askAs(token: string, body: Record<string, unknown>): Promise<QuestionView> {
    const res = await agent(token).post("/api/self/questions", body);
    expect(res.status).toBe(201);
    return (res.json as unknown as { question: QuestionView }).question;
  }

  describe("get_info", () => {
    test("reports the box's own name, size, state and remaining TTL", async () => {
      const res = await agent(alphaToken).get("/api/self");
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ boxId: alpha.boxId, name: "alpha", running: true, cpus: 1, memoryMb: 256 });
      const remaining = res.json.remainingTtlSec ?? -1;
      expect(remaining).toBeGreaterThan(3500);
      expect(remaining).toBeLessThanOrEqual(3600);
    });

    test("a box with no TTL reports none", async () => {
      expect((await agent(bravoToken).get("/api/self")).json.remainingTtlSec).toBeNull();
    });
  });

  describe("report_status", () => {
    test("a state is recorded as an event under the box's own principal", async () => {
      const res = await agent(alphaToken).post("/api/self/status", { state: "done", note: "Tests pass" });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true });
      const [event] = harness.app.events.list({ op: "self.status" }, { limit: 1 }).events;
      expect(event).toMatchObject({
        op: "self.status",
        principal: { type: "box-self", id: alpha.boxId },
        detail: { state: "done", note: "Tests pass", boxId: alpha.boxId },
      });
    });

    test("a state outside the four, an empty note, a note with a line break and a long note are refused", async () => {
      const status = agent(alphaToken);
      expect(refused(await status.post("/api/self/status", { state: "sleeping", note: "x" }))).toEqual({
        status: 400,
        key: "self_state_invalid",
      });
      expect(refused(await status.post("/api/self/status", { state: "working", note: "   " }))).toEqual({
        status: 400,
        key: "self_note_invalid",
      });
      expect(refused(await status.post("/api/self/status", { state: "working", note: "two\nlines" }))).toEqual({
        status: 400,
        key: "self_note_invalid",
      });
      expect(refused(await status.post("/api/self/status", { state: "working", note: "x".repeat(501) }))).toEqual({
        status: 400,
        key: "self_note_invalid",
      });
    });

    test("a token pasted into a note is redacted from the event log", async () => {
      const res = await agent(alphaToken).post("/api/self/status", {
        state: "working",
        note: `debugging with ${alphaToken}`,
      });
      expect(res.status).toBe(200);
      expect(JSON.stringify(harness.app.events.list({ op: "self.status" }, { limit: 5 }).events)).not.toContain(
        alphaToken,
      );
    });
  });

  describe("ask_human", () => {
    test("a question with options is pending until a person answers it, and the agent reads the answer", async () => {
      const asked = await askAs(alphaToken, { message: "Ship the release?", options: ["yes", "no"] });
      expect(asked.id).toMatch(/^q_/);
      expect(asked).toMatchObject({
        boxId: alpha.boxId,
        message: "Ship the release?",
        options: ["yes", "no"],
        answer: null,
        answeredBy: null,
      });

      const pending = (await agent(alphaToken).get(`/api/self/questions/${asked.id}`)).json as unknown as {
        question: QuestionView;
      };
      expect(pending.question.answer).toBeNull();

      const listed = (await owner(`/api/boxes/${alpha.id}/questions`, "GET")).json as unknown as {
        questions: QuestionView[];
      };
      expect(listed.questions.map((question) => question.id)).toEqual([asked.id]);

      const answered = await owner(`/api/questions/${asked.id}/answer`, "POST", { answer: "yes" });
      expect(answered.status).toBe(200);
      expect(answered.json).toMatchObject({ question: { answer: "yes", answeredBy: "owner" } });

      const after = (await agent(alphaToken).get(`/api/self/questions/${asked.id}`)).json as unknown as {
        question: QuestionView;
      };
      expect(after.question.answer).toBe("yes");
    });

    test("a question with no options takes any free-text answer, and an answer is given once", async () => {
      const asked = await askAs(alphaToken, { message: "Anything to add?" });
      expect(asked.options).toEqual([]);
      expect(
        (await owner(`/api/questions/${asked.id}/answer`, "POST", { answer: "use the staging host" })).status,
      ).toBe(200);
      const again = await owner(`/api/questions/${asked.id}/answer`, "POST", { answer: "use production" });
      expect(refused(again)).toEqual({ status: 409, key: "question_answered" });
    });

    test("an answer outside the offered options is refused, and nothing is recorded", async () => {
      const asked = await askAs(alphaToken, { message: "Deploy?", options: ["yes", "no"] });
      expect(refused(await owner(`/api/questions/${asked.id}/answer`, "POST", { answer: "maybe" }))).toEqual({
        status: 400,
        key: "question_option_invalid",
      });
      expect(harness.app.hosts.get().questions.get(asked.id)?.answer).toBeNull();
    });

    test("a message, an option list and an answer outside their limits are refused", async () => {
      const agentAlpha = agent(alphaToken);
      expect(refused(await agentAlpha.post("/api/self/questions", { message: "   " }))).toEqual({
        status: 400,
        key: "question_message_invalid",
      });
      expect(refused(await agentAlpha.post("/api/self/questions", { message: "ok", options: ["a", "a"] }))).toEqual({
        status: 400,
        key: "question_options_invalid",
      });
      const eleven = Array.from({ length: 11 }, (_, index) => `choice ${index}`);
      expect(refused(await agentAlpha.post("/api/self/questions", { message: "ok", options: eleven })).key).toBe(
        "question_options_invalid",
      );
      const asked = await askAs(alphaToken, { message: "Long?" });
      expect(refused(await owner(`/api/questions/${asked.id}/answer`, "POST", { answer: "x".repeat(1001) }))).toEqual({
        status: 400,
        key: "question_answer_invalid",
      });
    });

    test("a box past its pending limit is refused until a person answers one of its questions", async () => {
      for (let index = 0; index < QUESTION_PENDING_PER_BOX; index += 1) {
        await askAs(alphaToken, { message: `Question ${index}` });
      }
      const refusedAsk = await agent(alphaToken).post("/api/self/questions", { message: "One more" });
      expect(refused(refusedAsk)).toEqual({ status: 409, key: "question_limit" });

      const first = harness.app.hosts.get().questions.forBox(alpha.boxId).at(-1);
      expect(first).toBeDefined();
      await owner(`/api/questions/${first?.id}/answer`, "POST", { answer: "noted" });
      expect((await agent(alphaToken).post("/api/self/questions", { message: "One more" })).status).toBe(201);
    });

    test("a box cannot read or answer another box's question", async () => {
      const bravoQuestion = await askAs(bravoToken, { message: "Bravo's question" });
      expect(refused(await agent(alphaToken).get(`/api/self/questions/${bravoQuestion.id}`))).toEqual({
        status: 404,
        key: "question_not_found",
      });
      expect(
        refused(await agent(alphaToken).post(`/api/questions/${bravoQuestion.id}/answer`, { answer: "yes" })),
      ).toEqual({ status: 403, key: "operation_forbidden" });
      expect(harness.app.hosts.get().questions.get(bravoQuestion.id)?.answer).toBeNull();
    });

    test("the answer text stays out of the event log", async () => {
      const asked = await askAs(alphaToken, { message: "Approve?" });
      await owner(`/api/questions/${asked.id}/answer`, "POST", { answer: "approved-by-owner-7f3a" });
      const events = JSON.stringify(harness.app.events.list({ op: "question.answer" }, { limit: 5 }).events);
      expect(events).toContain("question.answer");
      expect(events).not.toContain("approved-by-owner-7f3a");
    });
  });

  describe("checkpoint", () => {
    test("a checkpoint is a task the agent polls, and the checkpoint is the box's", async () => {
      const taken = await agent(alphaToken).post("/api/self/checkpoints", {
        label: "before the migration",
        reason: "A schema change",
      });
      expect(taken.status).toBe(202);
      const taskId = taken.json.taskId ?? "";
      const done = await finishedTask(harness.base, taskId);
      expect(done).toMatchObject({ status: "succeeded" });
      expect(done.result?.checkpoint).toMatchObject({ boxId: alpha.boxId, createdBy: alpha.boxId, pinned: false });

      const polled = await agent(alphaToken).get(`/api/self/tasks/${taskId}`);
      expect(polled.status).toBe(200);
      expect(polled.json).toMatchObject({ id: taskId, status: "succeeded" });
    });

    test("a task of another box, or one the owner started, is not the agent's", async () => {
      const mine = await agent(alphaToken).post("/api/self/checkpoints", { label: "mine", reason: "Mine" });
      await finishedTask(harness.base, mine.json.taskId ?? "");
      expect(refused(await agent(bravoToken).get(`/api/self/tasks/${mine.json.taskId}`))).toEqual({
        status: 404,
        key: "task_not_found",
      });

      const ours = await owner(`/api/boxes/${alpha.id}/checkpoints`, "POST", { label: "owner's", reason: "Owner" });
      await finishedTask(harness.base, ours.json.taskId ?? "");
      expect(refused(await agent(alphaToken).get(`/api/self/tasks/${ours.json.taskId}`))).toEqual({
        status: 404,
        key: "task_not_found",
      });
    });

    test("the box cannot stop itself for a checkpoint: only live and pause are offered", async () => {
      const refusedStop = await agent(alphaToken).post("/api/self/checkpoints", {
        label: "stopped",
        reason: "Stop first",
        consistency: "stop",
      });
      expect(refusedStop.status).toBe(400);
      expect(refusedStop.json.error).toMatchObject({ code: "validation_failed" });
      expect(refusedStop.json.error?.message).toContain("live");
    });

    test("the box's own checkpoint limit is enforced", async () => {
      for (let index = 0; index < (SELF_QUOTA.maxCheckpoints ?? 0); index += 1) {
        const taken = await agent(alphaToken).post("/api/self/checkpoints", { label: `c${index}`, reason: "Batch" });
        expect(taken.status).toBe(202);
        await finishedTask(harness.base, taken.json.taskId ?? "");
      }
      const over = await agent(alphaToken).post("/api/self/checkpoints", { label: "over", reason: "Too many" });
      expect(refused(over)).toEqual({ status: 403, key: "quota_checkpoints" });
    });

    test("a checkpoint is refused while a person holds the terminal, and the agent is told it was taken over", async () => {
      const held = spyOn(harness.app.terminals, "humanHolds").mockReturnValue(true);
      try {
        const res = await agent(alphaToken).post("/api/self/checkpoints", { label: "blocked", reason: "Taken" });
        expect(res.status).toBe(409);
        expect(res.json.error?.code).toBe("taken_over");
        expect(res.json.error?.retryable).toBe(true);
      } finally {
        held.mockRestore();
      }
    });
  });

  test("the self token is limited to a rate, and a call past it is refused with 429", async () => {
    const limit = SELF_QUOTA.rateLimit ?? 0;
    for (let index = 0; index < limit; index += 1) {
      expect((await agent(alphaToken).get("/api/self")).status).toBe(200);
    }
    expect(refused(await agent(alphaToken).get("/api/self"))).toEqual({
      status: 429,
      key: "token_rate_limited",
    });
  });
});

describe("a self token reaches only its own box", () => {
  let harness: Harness;
  let restoreLogs: () => void;
  let alpha: BoxRef;
  let bravo: BoxRef;
  let alphaToken: string;

  beforeEach(async () => {
    restoreLogs = silenceLogs();
    harness = startHarness();
    alpha = await createBox("alpha", { selfToken: true });
    bravo = await createBox("bravo", { selfToken: true });
    alphaToken = await selfTokenOf(harness.runtime, alpha.id);
    await selfTokenOf(harness.runtime, bravo.id);
  });
  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  async function createBox(name: string, extra: Record<string, unknown> = {}): Promise<BoxRef> {
    const res = await call(harness.base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256, ...extra } });
    expect(res.status).toBe(201);
    return res.json.box as BoxRef;
  }

  const asAlpha = (path: string, method = "GET", body?: unknown) =>
    call(harness.base, path, { token: alphaToken, method, body });

  test("another box, its questions, its exec and the box list are refused with 403", async () => {
    expect(refused(await asAlpha(`/api/boxes/${bravo.id}`))).toEqual({ status: 403, key: "operation_forbidden" });
    expect(refused(await asAlpha(`/api/boxes/${bravo.id}/questions`))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
    expect(refused(await asAlpha(`/api/boxes/${bravo.id}/exec`, "POST", { argv: ["true"] }))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
    expect(refused(await asAlpha("/api/boxes"))).toEqual({ status: 403, key: "operation_forbidden" });
  });

  test("a box that does not exist is refused the same way, so the box list is not an oracle", async () => {
    expect(refused(await asAlpha("/api/boxes/bx_doesnotexist"))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
  });

  test("token management, secrets, system and the event log are refused with 403", async () => {
    expect(refused(await asAlpha("/api/tokens"))).toEqual({ status: 403, key: "operation_forbidden" });
    expect(refused(await asAlpha("/api/tokens", "POST", { name: "mine", preset: "admin" }))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
    expect(refused(await asAlpha("/api/secrets"))).toEqual({ status: 403, key: "operation_forbidden" });
    expect(refused(await asAlpha("/api/secrets/vault", "PUT", { value: "stolen" }))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
    expect(refused(await asAlpha("/api/system"))).toEqual({ status: 403, key: "operation_forbidden" });
    expect(refused(await asAlpha("/api/events"))).toEqual({ status: 403, key: "operation_forbidden" });
    expect(refused(await asAlpha("/api/hosts"))).toEqual({ status: 403, key: "operation_forbidden" });
  });

  test("the box cannot delete itself, revoke its token, or answer a question", async () => {
    expect(refused(await asAlpha(`/api/boxes/${alpha.id}`, "DELETE"))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
    expect(refused(await asAlpha(`/api/boxes/${alpha.id}/self-token`, "DELETE"))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
    expect((await call(harness.base, `/api/boxes/${alpha.id}`)).status).toBe(200);
    expect((await asAlpha("/api/self")).status).toBe(200);
  });

  test("the owner is refused the self operations, which only a box's own agent runs", async () => {
    expect(refused(await call(harness.base, "/api/self"))).toEqual({ status: 403, key: "operation_forbidden" });
    expect(
      refused(
        await call(harness.base, "/api/self/status", {
          method: "POST",
          body: { state: "working", note: "I am the owner" },
        }),
      ),
    ).toEqual({ status: 403, key: "operation_forbidden" });
  });

  test("the terminal WebSocket refuses a box's own agent with 403 before it upgrades", async () => {
    const attempt = await upgradeAttempt(harness.base, `/api/boxes/${alpha.id}/terminal?session=work`, {
      authorization: `Bearer ${alphaToken}`,
    });
    expect(attempt.status).toBe(403);
    expect(JSON.parse(attempt.body)).toMatchObject({ error: { key: "box_out_of_scope" } });
  });
});

/** A plain WebSocket handshake whose status line and body are read back, so the test sees the refusal and not an upgrade. */
function upgradeAttempt(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const port = Number(new URL(base).port);
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let raw = "";
    socket.on("connect", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      const end = raw.indexOf("\r\n\r\n");
      if (end === -1) return;
      const status = Number(raw.split(" ")[1]);
      const length = Number(/content-length: (\d+)/i.exec(raw)?.[1] ?? 0);
      if (raw.length < end + 4 + length) return;
      socket.destroy();
      resolve({ status, body: raw.slice(end + 4, end + 4 + length) });
    });
    socket.on("error", reject);
  });
}
