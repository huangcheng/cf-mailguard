import type { MailguardEnv } from "../env.ts";
import { createAnthropicScorer } from "./anthropic.ts";
import { createOpenAIChatScorer } from "./openai-chat.ts";
import { createOpenAIResponsesScorer } from "./openai-responses.ts";
import type { Scorer } from "./types.ts";

export type { ScoreInput, ScoreResult, Scorer } from "./types.ts";
export { parseModelJson } from "./prompt.ts";

export function createScorer(env: MailguardEnv): Scorer {
  switch (env.LLM_PROVIDER) {
    case "openai_chat":
      return createOpenAIChatScorer(env);
    case "openai_responses":
      return createOpenAIResponsesScorer(env);
    case "anthropic_messages":
      return createAnthropicScorer(env);
    default:
      throw new Error(`unsupported LLM_PROVIDER: ${env.LLM_PROVIDER}`);
  }
}
