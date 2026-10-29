import { z } from "zod";

import { notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { accept, type Checked, reject } from "../lib/validation";
import {
  QUESTION_ANSWER_MAX,
  QUESTION_MESSAGE_MAX,
  QUESTION_OPTION_MAX,
  QUESTION_OPTIONS_MAX,
  type Question,
} from "../questions/types";
import { readBox } from "../services/boxes";
import { boxTarget } from "./boxes";
import { defineOperation } from "./define";
import { hostOfBox } from "./routing";
import { QuestionSchema } from "./schemas";
import { boxId, field } from "./validation";

const BRIEF_MAX = 60;

/** The text as an activity or event target shows it: its first characters, with an ellipsis when cut. */
function briefOf(text: string): string {
  const chars = [...text];
  return chars.length > BRIEF_MAX ? `${chars.slice(0, BRIEF_MAX).join("")}…` : text;
}

/** Control characters are refused, except the line breaks and tabs a message may use. */
const hasControl = (text: string): boolean => /\p{Cc}/u.test(text.replaceAll(/[\n\t]/g, ""));

function checkMessage(value: unknown): Checked<string> {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || [...text].length > QUESTION_MESSAGE_MAX || hasControl(text)) {
    return reject(msg("question_message_invalid", { max: QUESTION_MESSAGE_MAX }), "message");
  }
  return accept(text);
}

const optionsInvalid = () =>
  reject(msg("question_options_invalid", { max: QUESTION_OPTIONS_MAX, length: QUESTION_OPTION_MAX }), "options");

function checkOptions(value: unknown): Checked<string[]> {
  if (value === undefined || value === null) return accept([]);
  if (!Array.isArray(value) || value.length > QUESTION_OPTIONS_MAX) return optionsInvalid();
  const options: string[] = [];
  for (const item of value) {
    const text = typeof item === "string" ? item.trim() : "";
    if (text === "" || [...text].length > QUESTION_OPTION_MAX || /\p{Cc}/u.test(text) || options.includes(text)) {
      return optionsInvalid();
    }
    options.push(text);
  }
  return accept(options);
}

function checkAnswer(value: unknown): Checked<string> {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || [...text].length > QUESTION_ANSWER_MAX || hasControl(text)) {
    return reject(msg("question_answer_invalid", { max: QUESTION_ANSWER_MAX }), "answer");
  }
  return accept(text);
}

/** The question an agent asks. Line breaks are kept, so it can lay out a short list. */
export const questionMessage = () =>
  field(checkMessage, {
    type: "string",
    minLength: 1,
    maxLength: QUESTION_MESSAGE_MAX,
    description: `The question to ask the person, at most ${QUESTION_MESSAGE_MAX} characters.`,
  });

/** The choices a question offers. Omitted or empty leaves the answer free text. */
export const questionOptions = () =>
  field(checkOptions, {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: QUESTION_OPTION_MAX },
    maxItems: QUESTION_OPTIONS_MAX,
    description: `Up to ${QUESTION_OPTIONS_MAX} choices, each one line of at most ${QUESTION_OPTION_MAX} characters. The answer must be one of them. Omit it, or pass an empty list, for a free-text answer.`,
  }).default([]);

export const questionId = () =>
  z.string().min(1).max(64).meta({ description: "Question id (q_…), as the agent's ask_human call returned it." });

const answerField = () =>
  field(checkAnswer, {
    type: "string",
    minLength: 1,
    maxLength: QUESTION_ANSWER_MAX,
    description: `The answer, at most ${QUESTION_ANSWER_MAX} characters. It must be one of the question's options when it has any.`,
  });

const boxQuestions = defineOperation({
  name: "box.questions",
  tag: "questions",
  summary: "List the questions a box's agent asked",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ id: boxId() }),
  output: z.object({ questions: z.array(QuestionSchema) }),
  rest: [{ method: "GET", path: "/api/boxes/:id/questions" }],
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => readBox(host, input.id),
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, _input, box) => ({ questions: host.questions.forBox(box.boxId) }),
});

const questionAnswer = defineOperation({
  name: "question.answer",
  tag: "questions",
  summary: "Answer a question a box's agent asked",
  kind: "write",
  scope: "box:write",
  async: false,
  conflicts: true,
  input: z.object({ id: questionId(), answer: answerField() }),
  output: z.object({ question: QuestionSchema }),
  rest: [{ method: "POST", path: "/api/questions/:id/answer", body: true }],
  hostFor: (ctx, input) => {
    const question = ctx.host.questions.get(input.id);
    return question ? hostOfBox(ctx, question.boxId) : ctx.host;
  },
  resolve: async ({ host }, input): Promise<Question> => {
    const question = host.questions.get(input.id);
    if (!question) throw notFound(msg("question_not_found", { id: input.id }));
    return question;
  },
  activity: { action: () => "question.answer", target: (_input, question) => briefOf(question.message) },
  audit: {
    target: (_input, question) => question && { kind: "question", id: question.id, name: briefOf(question.message) },
    detail: (input) => ({ id: input.id }),
  },
  run: async ({ host, principal }, input) => ({
    question: host.questions.answer(input.id, input.answer, principal.id),
  }),
});

export const questionOperations = [boxQuestions, questionAnswer];
