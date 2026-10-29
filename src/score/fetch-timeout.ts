// Abort the provider call if it hangs, so decide() can fail open instead of
// stalling the email handler until the platform kills it.
export const LLM_FETCH_TIMEOUT_MS = 15_000;

export function llmFetchSignal(): AbortSignal {
  return AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS);
}
