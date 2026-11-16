import type { AuthSignals } from "./auth.ts";
import { parseThreshold, type MailguardEnv } from "./env.ts";
import {
  buildAllowHeaders,
  buildErrorHeaders,
  buildSpamHeaders,
} from "./headers.ts";
import { matchSender, parseList } from "./lists.ts";
import type { Scorer } from "./score/types.ts";

export type Decision =
  | { action: "reject"; reason: string }
  | {
      action: "forward";
      headers: Headers;
      path: "allow" | "score" | "error";
      score?: number;
      category?: string;
    };

function logEvent(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

export async function decide(opts: {
  from: string;
  headerFrom?: string;
  to: string;
  subject: string;
  text: string;
  parseError?: string;
  fromMismatch?: boolean;
  auth?: AuthSignals;
  env: MailguardEnv;
  scoreEmail: Scorer;
}): Promise<Decision> {
  const threshold = parseThreshold(opts.env.SPAM_THRESHOLD);
  const baseLog = {
    from: opts.from,
    to: opts.to,
    fromMismatch: Boolean(opts.fromMismatch),
    spf: opts.auth?.spf,
    dkim: opts.auth?.dkim,
    dmarc: opts.auth?.dmarc,
  };

  if (matchSender(opts.from, parseList(opts.env.BLOCK_LIST))) {
    logEvent({ ...baseLog, path: "block" });
    return { action: "reject", reason: "Address not allowed" };
  }

  if (matchSender(opts.from, parseList(opts.env.ALLOW_LIST))) {
    logEvent({ ...baseLog, path: "allow" });
    return {
      action: "forward",
      headers: buildAllowHeaders(threshold),
      path: "allow",
      category: "allowlist",
    };
  }

  // Visible fail-open when MIME parse failed — do not score an empty body as ham.
  if (opts.parseError) {
    logEvent({ ...baseLog, path: "error", error: opts.parseError });
    return {
      action: "forward",
      headers: buildErrorHeaders(opts.parseError, threshold),
      path: "error",
    };
  }

  try {
    const result = await opts.scoreEmail({
      from: opts.from,
      headerFrom: opts.headerFrom,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      auth: opts.auth,
      fromMismatch: opts.fromMismatch,
    });
    logEvent({
      ...baseLog,
      path: "score",
      score: result.score,
      category: result.category,
      model: opts.env.LLM_MODEL,
      provider: opts.env.LLM_PROVIDER,
    });
    return {
      action: "forward",
      headers: buildSpamHeaders({
        score: result.score,
        threshold,
        category: result.category,
        reasoning: result.reasoning,
      }),
      path: "score",
      score: result.score,
      category: result.category,
    };
  } catch (e) {
    // Fail open: never drop mail because scoring is unavailable.
    const error = e instanceof Error ? e.message : String(e);
    logEvent({
      ...baseLog,
      path: "error",
      error,
      model: opts.env.LLM_MODEL,
      provider: opts.env.LLM_PROVIDER,
    });
    return {
      action: "forward",
      headers: buildErrorHeaders(error, threshold),
      path: "error",
    };
  }
}
