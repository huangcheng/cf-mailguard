import { clampScore } from "../headers.ts";
import type { ScoreInput, ScoreResult } from "./types.ts";

export const SCORE_SYSTEM_PROMPT = `You are Mailguard, a spam and phishing scoring engine for inbound email.
Rate the email's risk from 0.0 (clearly legitimate) to 10.0 (clearly spam or phishing).
Respond with JSON only, no prose, in exactly this shape:
{"score": 0.0, "category": "personal|newsletter|marketing|transactional|spam|phishing|unknown", "reasoning": "short"}`;

export function buildUserPrompt(input: ScoreInput): string {
  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "",
    "Body:",
    input.text,
  ].join("\n");
}

// Empty or missing base URL falls back to the provider default; trailing
// slashes are stripped so `${base}/path` always joins cleanly.
export function resolveBaseUrl(
  raw: string | undefined,
  fallback: string,
): string {
  const trimmed = (raw ?? "").trim();
  const base = trimmed === "" ? fallback : trimmed;
  return base.replace(/\/+$/, "");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Pull the first {...} out of a possibly chatty model response. Handles
// braces inside JSON strings so truncated prose around the object is ignored.
function extractFirstJsonObject(content: string): string {
  const start = content.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model response");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  throw new Error("unterminated JSON object in model response");
}

export function parseModelJson(content: string): ScoreResult {
  const trimmed = content.trim();
  let obj: Record<string, unknown>;
  try {
    const direct: unknown = JSON.parse(trimmed);
    obj = isJsonObject(direct) ? direct : extractFirstJsonObjectAsObj(trimmed);
  } catch {
    obj = extractFirstJsonObjectAsObj(trimmed);
  }

  const rawScore = obj.score;
  if (typeof rawScore !== "number") {
    throw new Error("model JSON missing numeric score");
  }
  const result: ScoreResult = { score: clampScore(rawScore) };
  if (typeof obj.category === "string" && obj.category) result.category = obj.category;
  if (typeof obj.reasoning === "string" && obj.reasoning) result.reasoning = obj.reasoning;
  return result;
}

function extractFirstJsonObjectAsObj(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(extractFirstJsonObject(content));
  if (!isJsonObject(parsed)) throw new Error("model response is not a JSON object");
  return parsed;
}
