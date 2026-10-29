export interface ScoreInput {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface ScoreResult {
  score: number;
  category?: string;
  reasoning?: string;
}

export type Scorer = (input: ScoreInput) => Promise<ScoreResult>;
