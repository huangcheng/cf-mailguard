import type { MailguardEnv } from "../env.ts";
import { llmFetchSignal } from "./fetch-timeout.ts";
import {
  buildUserPrompt,
  parseModelJson,
  resolveBaseUrl,
  SCORE_SYSTEM_PROMPT,
} from "./prompt.ts";
import type { ScoreInput, ScoreResult, Scorer } from "./types.ts";

// LLM_BASE_URL should include "/v1" (default: https://api.openai.com/v1).
const DEFAULT_BASE = "https://api.openai.com/v1";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export function createOpenAIChatScorer(env: MailguardEnv): Scorer {
  const base = resolveBaseUrl(env.LLM_BASE_URL, DEFAULT_BASE);
  return async (input: ScoreInput): Promise<ScoreResult> => {
    const url = `${base}/chat/completions`;
    const headers = {
      authorization: `Bearer ${env.LLM_API_KEY ?? ""}`,
      "content-type": "application/json",
    };
    const messages = [
      { role: "system", content: SCORE_SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ];
    const baseBody = { model: env.LLM_MODEL, messages };

    let res = await fetch(url, {
      method: "POST",
      signal: llmFetchSignal(),
      headers,
      body: JSON.stringify({
        ...baseBody,
        response_format: { type: "json_object" },
      }),
    });
    // Some OpenAI-compatible gateways reject response_format; retry bare.
    if (res.status === 400 || res.status === 422) {
      res = await fetch(url, {
        method: "POST",
        signal: llmFetchSignal(),
        headers,
        body: JSON.stringify(baseBody),
      });
    }
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
