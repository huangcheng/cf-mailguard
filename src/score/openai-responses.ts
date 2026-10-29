import type { MailguardEnv } from "../env.ts";
import {
  buildUserPrompt,
  parseModelJson,
  resolveBaseUrl,
  SCORE_SYSTEM_PROMPT,
} from "./prompt.ts";
import type { ScoreInput, ScoreResult, Scorer } from "./types.ts";

const DEFAULT_BASE = "https://api.openai.com/v1";

interface ResponsesOutputPart {
  type?: string;
  text?: string;
}

interface ResponsesOutputItem {
  type?: string;
  content?: ResponsesOutputPart[];
}

interface ResponsesApiResult {
  output_text?: string;
  output?: ResponsesOutputItem[];
}

function extractText(data: ResponsesApiResult): string {
  if (typeof data.output_text === "string" && data.output_text !== "") {
    return data.output_text;
  }
  return (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function createOpenAIResponsesScorer(env: MailguardEnv): Scorer {
  const base = resolveBaseUrl(env.LLM_BASE_URL, DEFAULT_BASE);
  return async (input: ScoreInput): Promise<ScoreResult> => {
    const res = await fetch(`${base}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.LLM_API_KEY ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        instructions: SCORE_SYSTEM_PROMPT,
        input: buildUserPrompt(input),
      }),
    });
    if (!res.ok) {
      throw new Error(`openai_responses ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as ResponsesApiResult;
    const text = extractText(data);
    if (text === "") {
      throw new Error("openai_responses: no output text");
    }
    return parseModelJson(text);
  };
}
