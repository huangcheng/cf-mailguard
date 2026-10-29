/** Split allow/block config on commas, semicolons, or whitespace. */
export function parseList(csv: string | undefined): string[] {
  if (!csv || !csv.trim()) return [];
  return csv
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function stripRootDot(value: string): string {
  return value.replace(/\.$/, "");
}

/** Exact domain or subdomain under entry (dot-boundary). */
function domainMatches(domain: string, entryDomain: string): boolean {
  const d = stripRootDot(domain);
  const e = stripRootDot(entryDomain);
  if (!e) return false;
  return d === e || d.endsWith(`.${e}`);
}

/**
 * Match envelope from against entries.
 * Entry forms: "user@domain.tld" (exact) or "@domain.tld" / "domain.tld" (domain + subdomains).
 * Domain match uses label equality / suffix — not bare substring (`notexample.com` ≠ `example.com`).
 */
export function matchSender(from: string, entries: string[]): boolean {
  const normalized = stripRootDot(from.trim().toLowerCase());
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return false;
  const local = normalized.slice(0, at);
  const domain = stripRootDot(normalized.slice(at + 1));
  const address = `${local}@${domain}`;
  for (const entry of entries) {
    if (entry.startsWith("@")) {
      if (domainMatches(domain, entry.slice(1))) return true;
    } else if (entry.includes("@")) {
      if (address === stripRootDot(entry)) return true;
    } else if (domainMatches(domain, entry)) {
      return true;
    }
  }
  return false;
}
