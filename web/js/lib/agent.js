/**
 * Helpers for the box's agent card: which questions still need a person, and whether an answer fits the question. No DOM
 * and no translation, so the tests load this module directly.
 */

/** The most an answer may hold. Mirrors `QUESTION_ANSWER_MAX` in src/questions/types.ts. */
export const ANSWER_MAX = 1000;

/** Newest first, by the time the question was asked. */
const newest = (a, b) => (a.askedAt < b.askedAt ? 1 : a.askedAt > b.askedAt ? -1 : 0);

/** Questions no one has answered come first, then the answered ones. Each group is newest first. */
export function orderQuestions(questions) {
  return {
    pending: questions.filter((question) => question.answer === null).toSorted(newest),
    answered: questions.filter((question) => question.answer !== null).toSorted(newest),
  };
}

/** Why an answer cannot be sent, or null when it can. A question with options takes only one of them. */
export function answerProblem(question, answer) {
  const text = answer.trim();
  if (text === "") return "empty";
  if (question.options.length > 0 && !question.options.includes(text)) return "option";
  return null;
}
