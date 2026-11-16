/** Normalized auth verdicts from Authentication-Results / Received-SPF. */
export type AuthVerdict =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror"
  | "unknown";

export interface AuthSignals {
  spf?: AuthVerdict;
  dkim?: AuthVerdict;
  dmarc?: AuthVerdict;
  /** Raw Authentication-Results value(s), truncated for the LLM prompt. */
  raw?: string;
}

const VERDICTS = new Set<string>([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
]);

function asVerdict(raw: string | undefined): AuthVerdict | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (VERDICTS.has(v)) return v as AuthVerdict;
  return "unknown";
}

/**
 * Parse SPF/DKIM/DMARC results from Authentication-Results and optional
 * Received-SPF header values. Prefer the first explicit verdict seen for each.
 */
export function parseAuthSignals(opts: {
  authenticationResults?: string[];
  receivedSpf?: string[];
}): AuthSignals {
  const signals: AuthSignals = {};
  const authParts = (opts.authenticationResults ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  if (authParts.length > 0) {
    signals.raw = authParts.join(" | ").slice(0, 500);
  }

  for (const value of authParts) {
    // Typical: "mx.cloudflare.net; dkim=pass header.d=…; spf=pass …; dmarc=pass"
    const dkim = value.match(/\bdkim\s*=\s*([a-zA-Z]+)/i);
    const spf = value.match(/\bspf\s*=\s*([a-zA-Z]+)/i);
    const dmarc = value.match(/\bdmarc\s*=\s*([a-zA-Z]+)/i);
    if (!signals.dkim) signals.dkim = asVerdict(dkim?.[1]);
    if (!signals.spf) signals.spf = asVerdict(spf?.[1]);
    if (!signals.dmarc) signals.dmarc = asVerdict(dmarc?.[1]);
  }

  for (const value of opts.receivedSpf ?? []) {
    if (signals.spf) break;
    const m = value.trim().match(/^([a-zA-Z]+)\b/);
    signals.spf = asVerdict(m?.[1]);
  }

  return signals;
}

/** Collect all values for a header name (case-insensitive). */
export function headerValues(
  headers: Headers,
  name: string,
): string[] {
  const target = name.toLowerCase();
  const out: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === target && value.trim()) out.push(value);
  });
  return out;
}

export function authSignalsFromHeaders(headers: Headers): AuthSignals {
  return parseAuthSignals({
    authenticationResults: headerValues(headers, "authentication-results"),
    receivedSpf: headerValues(headers, "received-spf"),
  });
}
