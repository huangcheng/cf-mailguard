import { llmFetchSignal } from "./fetch-timeout.ts";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type PostJsonResult = {
  json: unknown;
  status: number;
  retried: boolean;
};

/**
 * Shared LLM POST helper: timeout signal, one retry on 429/5xx, non-ok → labeled Error.
 */
export async function postForJson(
  label: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const { json } = await postForJsonDetailed(label, url, headers, body);
  return json;
}

export async function postForJsonDetailed(
  label: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<PostJsonResult> {
  const payload = JSON.stringify(body);
  let retried = false;

  const attempt = async (): Promise<Response> =>
    fetch(url, {
      method: "POST",
      signal: llmFetchSignal(),
      headers,
      body: payload,
    });

  let res = await attempt();
  if (RETRYABLE.has(res.status)) {
    retried = true;
    await sleep(RETRY_DELAY_MS);
    res = await attempt();
  }

  if (!res.ok) {
    throw new Error(
      `${label} ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  return { json: await res.json(), status: res.status, retried };
}

/**
 * Low-level fetch with one 429/5xx retry. Used by adapters that need custom
 * status handling (e.g. openai_chat response_format fallback).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<{ res: Response; retried: boolean }> {
  let retried = false;
  const attempt = async (): Promise<Response> =>
    fetch(url, {
      ...init,
      signal: init.signal ?? llmFetchSignal(),
    });

  let res = await attempt();
  if (RETRYABLE.has(res.status)) {
    retried = true;
    await sleep(RETRY_DELAY_MS);
    res = await attempt();
  }
  return { res, retried };
}
