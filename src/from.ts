/**
 * Extract the first bare email address from an envelope or header From value.
 * Handles `Name <user@domain>`, bare addresses, and angle-bracket-only forms.
 */
export function extractEmailAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const angle = trimmed.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (angle?.[1]) return angle[1].toLowerCase().replace(/\.$/, "");

  const bare = trimmed.match(/([^\s<>",;]+@[^\s<>",;]+)/);
  if (bare?.[1]) return bare[1].toLowerCase().replace(/\.$/, "");

  return undefined;
}

/**
 * True when both envelope and header From yield addresses and they differ
 * (case-insensitive). Missing/unparseable header From is not treated as a mismatch.
 */
export function detectFromMismatch(
  envelopeFrom: string,
  headerFrom?: string,
): boolean {
  const envelope = extractEmailAddress(envelopeFrom);
  const header = extractEmailAddress(headerFrom);
  if (!envelope || !header) return false;
  return envelope !== header;
}
