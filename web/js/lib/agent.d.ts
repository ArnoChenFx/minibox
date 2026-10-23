/** A question a box's agent asked a person, as `GET /api/boxes/:id/questions` returns it. */
export interface AgentQuestion {
  readonly id: string;
  readonly boxId: string;
  readonly message: string;
  readonly options: string[];
  readonly askedAt: string;
  readonly answer: string | null;
  readonly answeredAt: string | null;
  readonly answeredBy: string | null;
}

export const ANSWER_MAX: number;

export function orderQuestions(questions: AgentQuestion[]): {
  pending: AgentQuestion[];
  answered: AgentQuestion[];
};

export function answerProblem(question: AgentQuestion, answer: string): "empty" | "option" | null;
