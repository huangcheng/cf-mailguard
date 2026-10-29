import { llmFetchSignal } from "./fetch-timeout.ts";
import type { MailguardEnv } from "../env.ts";
import {
  buildUserPrompt,
  parseModelJson,
  resolveBaseUrl,
  SCORE_SYSTEM_PROMPT,
} from "./prompt.ts";
import type { ScoreInput, ScoreResult, Scorer } from "./types.ts";

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
  const base = resolveBaseUrl(env.LLM_BASE_URL, DEFAULT_BASE);
  return async (input: ScoreInput): Promise<ScoreResult> => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      signal: llmFetchSignal(),
      headers: {
        "x-api-key": env.LLM_API_KEY ?? "",
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        max_tokens: MAX_TOKENS,
        system: SCORE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(input) }],
      }),
    });
    if (!res.ok) {
      throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as AnthropicResponse;
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
