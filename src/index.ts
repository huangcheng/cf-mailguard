import { decide } from "./decide.ts";
import { parseThreshold, type MailguardEnv } from "./env.ts";
import { buildErrorHeaders } from "./headers.ts";
import { parseEmail } from "./parse.ts";
import { createScorer } from "./score/index.ts";

export default {
  async email(
    message: ForwardableEmailMessage,
    env: MailguardEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      let subject = message.headers.get("subject") ?? "";
      let text = "";
      let headerFrom: string | undefined;
      let parseError: string | undefined;
      try {
        const raw = await new Response(message.raw).arrayBuffer();
        const parsed = await parseEmail(raw);
        subject = parsed.subject || subject;
        text = parsed.text;
        headerFrom = parsed.headerFrom || undefined;
      } catch (e) {
        console.error("parse failed", e);
        parseError = e instanceof Error ? e.message : String(e);
      }

      const decision = await decide({
        from: message.from,
        headerFrom,
        to: message.to,
        subject,
        text,
        parseError,
        env,
        // Deferred so an unsupported LLM_PROVIDER fails open through decide()'s
        // error path (X-Mailguard-Error) instead of crashing the handler.
        scoreEmail: (input) => createScorer(env)(input),
      });

      if (decision.action === "reject") {
        message.setReject(decision.reason);
        return;
      }
      await message.forward(env.FORWARD_TO, decision.headers);
    } catch (e) {
      // Last-resort fail-open: never let an unexpected throw drop the message.
      console.error("email handler failed", e);
      const threshold = parseThreshold(env.SPAM_THRESHOLD);
      const err = e instanceof Error ? e.message : String(e);
      try {
        await message.forward(env.FORWARD_TO, buildErrorHeaders(err, threshold));
      } catch (forwardErr) {
        console.error("fail-open forward failed", forwardErr);
      }
    }
  },
};
