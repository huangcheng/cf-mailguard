import type { MailguardEnv } from "../env.ts";
import { postForJson } from "./post-json.ts";
import {
  buildUserPrompt,
  parseModelJson,
  resolveAnthropicBaseUrl,
  SCORE_SYSTEM_PROMPT,
} from "./prompt.ts";
import type { ScoreInput, ScoreResult, Scorer } from "./types.ts";

// LLM_BASE_URL must NOT include "/v1" — this adapter appends /v1/messages.
// resolveAnthropicBaseUrl also strips a trailing /v1 if an OpenAI-style URL is reused.
const DEFAULT_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
// Enough tokens for the single-line JSON verdict the prompt asks for.
const MAX_TOKENS = 300;

interface AnthropicContentBlock {
  type?: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
}

export function createAnthropicScorer(env: MailguardEnv): Scorer {
  const base = resolveAnthropicBaseUrl(env.LLM_BASE_URL, DEFAULT_BASE);
  return async (input: ScoreInput): Promise<ScoreResult> => {
    const data = (await postForJson(
      "anthropic",
      `${base}/v1/messages`,
      {
        "x-api-key": env.LLM_API_KEY ?? "",
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      {
        model: env.LLM_MODEL,
        max_tokens: MAX_TOKENS,
        system: SCORE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(input) }],
      },
    )) as AnthropicResponse;
    const text = (data.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    if (text === "") {
      throw new Error("anthropic: no text content blocks");
    }
    return parseModelJson(text);
  };
}
