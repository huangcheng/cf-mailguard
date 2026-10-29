import PostalMime from "postal-mime";

const BODY_MAX = 3000;

export async function parseEmail(
  raw: ArrayBuffer,
): Promise<{ subject: string; text: string }> {
  const parsed = await PostalMime.parse(raw);
  const subject = parsed.subject ?? "";
  let text = (parsed.text ?? "").trim();
  if (!text && parsed.html) {
    text = parsed.html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (text.length > BODY_MAX) text = text.slice(0, BODY_MAX);
  return { subject, text };
}
