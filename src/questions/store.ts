import { readFileSync } from "node:fs";

import { z } from "zod";

import { writeFileAtomic } from "../data-dir";
import { ulid } from "../events/ulid";
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import {
  QUESTION_ANSWER_MAX,
  QUESTION_ID_PREFIX,
  QUESTION_PENDING_PER_BOX,
  QUESTION_TOTAL_MAX,
  type Question,
} from "./types";

const FILE_VERSION = 1;

const StoredQuestionSchema = z.object({
  id: z.string().min(3),
  boxId: z.string().min(1),
  message: z.string().min(1),
  options: z.array(z.string()),
  askedAt: z.string(),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
  answeredBy: z.string().nullable(),
});

const StoredFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  questions: z.array(StoredQuestionSchema),
});

export interface QuestionStoreOptions {
  /** Path of the file, normally `DATA_DIR/questions.json`. */
  readonly file: string;
  readonly now?: () => number;
}

export interface AskInput {
  readonly message: string;
  readonly options: readonly string[];
}

/**
 * The questions boxes' agents asked people. Every host of a control plane shares one store. A question is answered once,
 * and an answer with options must be one of them. The file keeps every question, so a pending one survives a restart.
 */
export class QuestionStore {
  private readonly records = new Map<string, Question>();
  private readonly now: () => number;

  constructor(private readonly opts: QuestionStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.restore();
  }

  /** Records a question for a box and returns it. A box past its pending limit is refused until a person answers. */
  ask(boxId: string, input: AskInput): Question {
    if (this.pendingFor(boxId).length >= QUESTION_PENDING_PER_BOX) {
      throw conflict(msg("question_limit", { max: QUESTION_PENDING_PER_BOX }));
    }
    this.makeRoom();
    const now = this.now();
    const question: Question = {
      id: `${QUESTION_ID_PREFIX}${ulid(now)}`,
      boxId,
      message: input.message,
      options: [...input.options],
      askedAt: new Date(now).toISOString(),
      answer: null,
      answeredAt: null,
      answeredBy: null,
    };
    this.records.set(question.id, question);
    this.save();
    return question;
  }

  get(id: string): Question | undefined {
    return this.records.get(id);
  }

  /** The box's questions, newest first. */
  forBox(boxId: string): Question[] {
    return [...this.records.values()].filter((question) => question.boxId === boxId).toReversed();
  }

  /** Records the answer. A question is answered once, and an answer with options must be one of them. */
  answer(id: string, answer: string, answeredBy: string): Question {
    const question = this.records.get(id);
    if (!question) throw notFound(msg("question_not_found", { id }));
    if (question.answer !== null) throw conflict(msg("question_answered", { id }));
    if (question.options.length > 0 && !question.options.includes(answer)) {
      throw badRequest(msg("question_option_invalid"), { field: "answer" });
    }
    if ([...answer].length > QUESTION_ANSWER_MAX) throw badRequest(msg("question_answer_long"), { field: "answer" });
    const answered: Question = {
      ...question,
      answer,
      answeredAt: new Date(this.now()).toISOString(),
      answeredBy,
    };
    this.records.set(id, answered);
    this.save();
    return answered;
  }

  /** Removes every question of a box. Called when the box is deleted. */
  forget(boxId: string): void {
    let changed = false;
    for (const question of this.records.values()) {
      if (question.boxId !== boxId) continue;
      this.records.delete(question.id);
      changed = true;
    }
    if (changed) this.save();
  }

  private pendingFor(boxId: string): Question[] {
    return [...this.records.values()].filter((question) => question.boxId === boxId && question.answer === null);
  }

  /** Drops the oldest answered questions until one more fits. Pending ones are never dropped to make room. */
  private makeRoom(): void {
    for (const question of this.records.values()) {
      if (this.records.size < QUESTION_TOTAL_MAX) return;
      if (question.answer !== null) this.records.delete(question.id);
    }
    if (this.records.size >= QUESTION_TOTAL_MAX)
      throw conflict(msg("question_limit_total", { max: QUESTION_TOTAL_MAX }));
  }

  private restore(): void {
    let text: string;
    try {
      text = readFileSync(this.opts.file, "utf8");
    } catch (e) {
      if (!isNotFound(e)) log.warn("question.store_unreadable", { path: this.opts.file, reason: "read failed" });
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      log.warn("question.store_unreadable", { path: this.opts.file, reason: "not JSON" });
      return;
    }
    const parsed = StoredFileSchema.safeParse(data);
    if (!parsed.success) {
      log.warn("question.store_unreadable", { path: this.opts.file, reason: "not a question file" });
      return;
    }
    for (const question of parsed.data.questions) this.records.set(question.id, question);
  }

  private save(): void {
    const body = JSON.stringify({ version: FILE_VERSION, questions: [...this.records.values()] }, null, 2);
    writeFileAtomic(this.opts.file, `${body}\n`);
  }
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}
