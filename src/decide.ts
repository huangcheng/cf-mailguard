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
    };

export async function decide(opts: {
  from: string;
  to: string;
  subject: string;
  text: string;
  env: MailguardEnv;
  scoreEmail: Scorer;
}): Promise<Decision> {
  const threshold = parseThreshold(opts.env.SPAM_THRESHOLD);

  if (matchSender(opts.from, parseList(opts.env.BLOCK_LIST))) {
    console.log(JSON.stringify({ from: opts.from, path: "block" }));
    return { action: "reject", reason: "Address not allowed" };
  }

  if (matchSender(opts.from, parseList(opts.env.ALLOW_LIST))) {
    console.log(JSON.stringify({ from: opts.from, path: "allow" }));
    return {
      action: "forward",
      headers: buildAllowHeaders(threshold),
      path: "allow",
    };
  }

  try {
    const result = await opts.scoreEmail({
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
    });
    console.log(
      JSON.stringify({ from: opts.from, path: "score", score: result.score }),
    );
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
    };
  } catch (e) {
    // Fail open: never drop mail because scoring is unavailable.
    const error = e instanceof Error ? e.message : String(e);
    console.log(JSON.stringify({ from: opts.from, path: "error", error }));
    return {
      action: "forward",
      headers: buildErrorHeaders(error, threshold),
      path: "error",
    };
  }
}
