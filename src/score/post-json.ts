import { llmFetchSignal } from "./fetch-timeout.ts";

/** Shared LLM POST helper: timeout signal, non-2xx → labeled Error. */
export async function postForJson(
  label: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    signal: llmFetchSignal(),
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}
