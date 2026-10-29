import type { MailguardEnv } from "../env.ts";
import { postForJson } from "./post-json.ts";
import {
  buildUserPrompt,
  parseModelJson,
  resolveBaseUrl,
  SCORE_SYSTEM_PROMPT,
} from "./prompt.ts";
import type { ScoreInput, ScoreResult, Scorer } from "./types.ts";

// LLM_BASE_URL should include "/v1" (default: https://api.openai.com/v1).
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
    const data = (await postForJson(
      "openai_responses",
      `${base}/responses`,
      {
        authorization: `Bearer ${env.LLM_API_KEY ?? ""}`,
        "content-type": "application/json",
      },
      {
        model: env.LLM_MODEL,
        instructions: SCORE_SYSTEM_PROMPT,
        input: buildUserPrompt(input),
        // Opt out of default ~30-day response storage for private mail content.
        store: false,
      },
    )) as ResponsesApiResult;
    const text = extractText(data);
    if (text === "") {
      throw new Error("openai_responses: no output text");
    }
    return parseModelJson(text);
  };
}
