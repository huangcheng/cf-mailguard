/** Split comma-separated allow/block config into trimmed lowercase entries. */
export function parseList(csv: string | undefined): string[] {
  if (!csv || !csv.trim()) return [];
  return csv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Match envelope from against entries.
 * Entry forms: "user@domain.tld" (exact) or "@domain.tld" / "domain.tld" (domain).
 * Domain match is exact label equality after @ — not substring.
 */
export function matchSender(from: string, entries: string[]): boolean {
  const normalized = from.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = normalized.slice(at + 1);
  for (const entry of entries) {
    if (entry.startsWith("@")) {
      if (domain === entry.slice(1)) return true;
    } else if (entry.includes("@")) {
      if (normalized === entry) return true;
    } else if (domain === entry) {
      return true;
    }
  }
  return false;
}
