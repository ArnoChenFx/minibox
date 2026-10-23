import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";
import { QUESTION_ANSWER_MAX } from "../src/questions/types";
import { ANSWER_MAX, answerProblem, orderQuestions } from "../web/js/lib/agent.js";

const CARD = join(ROOT, "web", "js", "components", "box-agent.js");

/** The browser globals the card's modules read when they load, with an English navigator. */
const BROWSER = [
  `const stub = { documentElement: {}, body: {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), addEventListener() {}, removeEventListener() {} };`,
  `Object.defineProperty(globalThis, "document", { configurable: true, value: stub });`,
  `Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });`,
  `Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });`,
  `Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US" } });`,
  `Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost" } });`,
];

/**
 * Renders the agent card's markup for each model in one fresh process, as the page loads the module. A model's `drafts`
 * is a plain object, since a Map does not survive JSON.
 */
function cardMarkup(models: Record<string, unknown>[]): string[] {
  const script = [
    ...BROWSER,
    `const { agentCardHtml } = await import(${JSON.stringify(CARD)});`,
    `const models = ${JSON.stringify(models)}.map((model) => ({ ...model, drafts: new Map(Object.entries(model.drafts ?? {})) }));`,
    `console.log(JSON.stringify(models.map((model) => agentCardHtml(model))));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as string[];
}

function questionOf(patch: Record<string, unknown>) {
  return {
    id: "q_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    boxId: "bx_01arz3ndektsv4rrffq69g5fav",
    message: "Ship the release?",
    options: [] as string[],
    askedAt: "2026-10-23T10:00:00.000Z",
    answer: null,
    answeredAt: null,
    answeredBy: null,
    ...patch,
  };
}

describe("questions in the agent card", () => {
  test("a question no one has answered comes first, newest first, then the answered ones", () => {
    const older = questionOf({ id: "q_old", askedAt: "2026-10-23T09:00:00.000Z" });
    const newer = questionOf({ id: "q_new", askedAt: "2026-10-23T11:00:00.000Z" });
    const done = questionOf({
      id: "q_done",
      askedAt: "2026-10-23T12:00:00.000Z",
      answer: "yes",
      answeredAt: "2026-10-23T12:05:00.000Z",
      answeredBy: "owner",
    });
    const { pending, answered } = orderQuestions([older, done, newer]);
    expect(pending.map((question) => question.id)).toEqual(["q_new", "q_old"]);
    expect(answered.map((question) => question.id)).toEqual(["q_done"]);
  });

  test("an answer is refused when it is empty, or when the question offers options and it is not one of them", () => {
    const choice = questionOf({ options: ["yes", "no"] });
    expect(answerProblem(choice, "   ")).toBe("empty");
    expect(answerProblem(choice, "maybe")).toBe("option");
    expect(answerProblem(choice, " yes ")).toBeNull();
    const freeText = questionOf({});
    expect(answerProblem(freeText, "use the staging host")).toBeNull();
  });

  test("the card's answer limit is the server's", () => {
    expect(ANSWER_MAX).toBe(QUESTION_ANSWER_MAX);
  });
});

describe("the agent card markup", () => {
  test("a question's text is escaped, and a question with options offers each one as a button", () => {
    const [html] = cardMarkup([
      {
        selfToken: true,
        pending: [
          questionOf({
            message: "<img src=x onerror=alert(1)> Deploy?",
            options: ["yes", "<no>"],
          }),
        ],
        answered: [],
      },
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; Deploy?");
    expect(html).toContain('data-agent-answer="yes"');
    expect(html).toContain('data-agent-answer="&lt;no&gt;"');
    expect(html).not.toContain("data-agent-reply");
  });

  test("a free-text question gets a reply field that keeps the draft the person typed", () => {
    const [html] = cardMarkup([
      {
        selfToken: true,
        pending: [questionOf({ id: "q_free" })],
        answered: [],
        drafts: { q_free: "use staging" },
      },
    ]);
    expect(html).toContain("data-agent-reply");
    expect(html).toContain('value="use staging"');
    expect(html).toContain(`maxlength="${QUESTION_ANSWER_MAX}"`);
  });

  test("the revoke button is offered only while the box has a self token", () => {
    const [on, off] = cardMarkup([
      { selfToken: true, pending: [], answered: [] },
      { selfToken: false, pending: [questionOf({})], answered: [] },
    ]);
    expect(on).toContain('data-agent-action="revoke"');
    expect(on).toContain("badge-success");
    expect(off).not.toContain('data-agent-action="revoke"');
    expect(off).toContain("Questions it already asked");
  });

  test("answered questions show their answer, and the card names an empty pending list", () => {
    const [html] = cardMarkup([
      {
        selfToken: true,
        pending: [],
        answered: [
          questionOf({
            id: "q_a",
            message: "Use which host?",
            answer: "staging",
            answeredAt: "2026-10-23T12:00:00.000Z",
          }),
        ],
      },
    ]);
    expect(html).toContain("Use which host?");
    expect(html).toContain("<strong>staging</strong>");
    expect(html).toContain("No question is waiting for an answer.");
  });

  test("a load error is shown as a callout, escaped", () => {
    const [html] = cardMarkup([{ selfToken: true, pending: [], answered: [], loadError: "<b>offline</b>" }]);
    expect(html).toContain("&lt;b&gt;offline&lt;/b&gt;");
    expect(html).toContain("callout danger");
  });
});
