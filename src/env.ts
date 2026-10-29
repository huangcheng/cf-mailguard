export interface MailguardEnv {
  FORWARD_TO: string;
  ALLOW_LIST: string;
  BLOCK_LIST: string;
  SPAM_THRESHOLD: string;
  LLM_PROVIDER: string;
  LLM_MODEL: string;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
}

export function parseThreshold(raw: string | undefined): number {
  const n = Number.parseFloat(raw ?? "5.0");
  return Number.isFinite(n) && n > 0 ? n : 5.0;
}
