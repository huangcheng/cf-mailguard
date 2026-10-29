import { llmFetchSignal } from "./fetch-timeout.ts";
import type { MailguardEnv } from "../env.ts";
import {
  buildUserPrompt,
  parseModelJson,
  resolveBaseUrl,
  SCORE_SYSTEM_PROMPT,
} from "./prompt.ts";
import type { ScoreInput, ScoreResult, Scorer } from "./types.ts";

const DEFAULT_BASE = "https://api.openai.com/v1";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export function createOpenAIChatScorer(env: MailguardEnv): Scorer {
  const base = resolveBaseUrl(env.LLM_BASE_URL, DEFAULT_BASE);
  return async (input: ScoreInput): Promise<ScoreResult> => {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: llmFetchSignal(),
      headers: {
        authorization: `Bearer ${env.LLM_API_KEY ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        messages: [
          { role: "system", content: SCORE_SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      throw new Error(`openai_chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content === "") {
      throw new Error("openai_chat: missing message content");
    }
    return parseModelJson(content);
  };
}
