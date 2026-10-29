const REASONING_MAX = 200;
const TRUNC_SUFFIX = "...";

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(10, Math.max(0, score));
}

export function spamLevel(score: number): string {
  const n = Math.min(10, Math.max(0, Math.floor(clampScore(score))));
  return "*".repeat(n);
}

// Header values must stay ISO-8859-1 and free of C0 controls so Headers.set
// never throws (which would break fail-open) and SMTP parsers cannot smuggle.
function trunc(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const cleaned = Array.from(
    s
      .replace(/[\u0000-\u001F\u007F]+/g, " ")
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?"),
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  const chars = Array.from(cleaned);
  return chars.length <= REASONING_MAX
    ? cleaned
    : chars.slice(0, REASONING_MAX - TRUNC_SUFFIX.length).join("") +
        TRUNC_SUFFIX;
}

export function buildSpamHeaders(opts: {
  score: number;
  threshold: number;
  category?: string;
  reasoning?: string;
}): Headers {
  const score = clampScore(opts.score);
  const yes = score >= opts.threshold;
  const headers = new Headers();
  headers.set("X-Spam-Score", score.toFixed(1));
  headers.set(
    "X-Spam-Status",
    `${yes ? "Yes" : "No"}, score=${score.toFixed(1)} required=${opts.threshold.toFixed(1)}`,
  );
  headers.set("X-Spam-Level", spamLevel(score));
  const cat = trunc(opts.category);
  const reason = trunc(opts.reasoning);
  if (cat) headers.set("X-Mailguard-Category", cat);
  if (reason) headers.set("X-Mailguard-Reasoning", reason);
  return headers;
}

export function buildAllowHeaders(threshold: number): Headers {
  const headers = new Headers();
  headers.set("X-Spam-Score", "-1.0");
  headers.set("X-Spam-Status", `No, score=-1.0 required=${threshold.toFixed(1)}`);
  headers.set("X-Spam-Level", "");
  headers.set("X-Mailguard-Category", "allowlist");
  return headers;
}

export function buildErrorHeaders(message: string, threshold: number): Headers {
  const headers = buildSpamHeaders({ score: 0, threshold });
  headers.set("X-Mailguard-Error", trunc(message) || "scoring_failed");
  return headers;
}
