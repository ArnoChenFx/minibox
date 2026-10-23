/**
 * A question a box's agent asked a person with `ask_human`. A person answers it once, from the console or the API. With
 * options, the answer must be one of them. Without, it is free text.
 */
export interface Question {
  /** Stable id (`q_…`). */
  readonly id: string;
  /** The box that asked. A question is removed with its box. */
  readonly boxId: string;
  readonly message: string;
  readonly options: string[];
  readonly askedAt: string;
  readonly answer: string | null;
  readonly answeredAt: string | null;
  /** The principal that answered: `owner`, or a token id. Null while pending. */
  readonly answeredBy: string | null;
}

export const QUESTION_ID_PREFIX = "q_";
export const QUESTION_MESSAGE_MAX = 1000;
export const QUESTION_OPTIONS_MAX = 10;
export const QUESTION_OPTION_MAX = 200;
export const QUESTION_ANSWER_MAX = 1000;
/** Unanswered questions one box may hold. A box that asks past this is refused until a person answers. */
export const QUESTION_PENDING_PER_BOX = 20;
/** Every question the store keeps. Past this, the oldest answered ones go first. */
export const QUESTION_TOTAL_MAX = 500;

export const QUESTION_ID_RE = /^q_[0-9A-HJKMNP-TV-Z]{26}$/;
