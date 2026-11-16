import type { AuthSignals } from "../auth.ts";

export interface ScoreInput {
  from: string;
  /** Display/header From when available (may differ from envelope). */
  headerFrom?: string;
  to: string;
  subject: string;
  text: string;
  /** SPF/DKIM/DMARC summary when Authentication-Results is present. */
  auth?: AuthSignals;
  /** Envelope-From address differs from Header-From address. */
  fromMismatch?: boolean;
}

export interface ScoreResult {
  score: number;
  category?: string;
  reasoning?: string;
}

export type Scorer = (input: ScoreInput) => Promise<ScoreResult>;
