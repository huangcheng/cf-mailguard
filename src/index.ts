import { decide } from "./decide.ts";
import type { MailguardEnv } from "./env.ts";
import { parseEmail } from "./parse.ts";
import { createScorer } from "./score/index.ts";

export default {
  async email(
    message: ForwardableEmailMessage,
    env: MailguardEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    let subject = message.headers.get("subject") ?? "";
    let text = "";
    try {
      const raw = await new Response(message.raw).arrayBuffer();
      const parsed = await parseEmail(raw);
      subject = parsed.subject || subject;
      text = parsed.text;
    } catch (e) {
      console.error("parse failed", e);
    }

    const decision = await decide({
      from: message.from,
      to: message.to,
      subject,
      text,
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
  },
};
