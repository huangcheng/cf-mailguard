import PostalMime from "postal-mime";
import type { Address, Mailbox } from "postal-mime";

const BODY_MAX = 3000;

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function htmlToText(html: string): string {
  return decodeBasicEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function formatMailbox(entry: Mailbox): string {
  const address = entry.address?.trim() ?? "";
  const name = entry.name?.trim() ?? "";
  if (name && address) return `${name} <${address}>`;
  return address || name;
}

function formatHeaderFrom(from: Address | undefined): string {
  if (!from) return "";
  if ("group" in from && from.group) {
    return from.group.map(formatMailbox).filter(Boolean).join(", ");
  }
  return formatMailbox(from as Mailbox);
}

export async function parseEmail(raw: ArrayBuffer): Promise<{
  subject: string;
  text: string;
  headerFrom: string;
}> {
  const parsed = await PostalMime.parse(raw);
  const subject = parsed.subject ?? "";
  const headerFrom = formatHeaderFrom(parsed.from);
  let text = (parsed.text ?? "").trim();
  if (!text && parsed.html) {
    text = htmlToText(parsed.html);
  }
  if (text.length > BODY_MAX) text = text.slice(0, BODY_MAX);
  return { subject, text, headerFrom };
}
