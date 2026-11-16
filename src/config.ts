import type { MailguardEnv } from "./env.ts";

const SUPPORTED_PROVIDERS = new Set([
  "openai_chat",
  "openai_responses",
  "anthropic_messages",
]);

export interface ConfigIssue {
  level: "warn" | "error";
  message: string;
}

/** Soft validation for operator misconfig — never throws. */
export function validateMailguardConfig(env: MailguardEnv): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  if (!(env.FORWARD_TO ?? "").trim()) {
    issues.push({
      level: "error",
      message: "FORWARD_TO is empty; fail-open forward will fail",
    });
  }

  if (!SUPPORTED_PROVIDERS.has((env.LLM_PROVIDER ?? "").trim())) {
    issues.push({
      level: "error",
      message: `unsupported LLM_PROVIDER: ${env.LLM_PROVIDER || "(empty)"}`,
    });
  }

  if (!(env.LLM_MODEL ?? "").trim()) {
    issues.push({
      level: "warn",
      message: "LLM_MODEL is empty",
    });
  }

  if (!(env.LLM_API_KEY ?? "").trim()) {
    issues.push({
      level: "warn",
      message: "LLM_API_KEY is missing; scored path will fail open",
    });
  }

  return issues;
}

let logged = false;

/** Log config issues once per isolate lifetime. */
export function logConfigOnce(env: MailguardEnv): void {
  if (logged) return;
  logged = true;
  const issues = validateMailguardConfig(env);
  if (issues.length === 0) {
    console.log(
      JSON.stringify({
        event: "config_ok",
        provider: env.LLM_PROVIDER,
        model: env.LLM_MODEL,
        hasBaseUrl: Boolean((env.LLM_BASE_URL ?? "").trim()),
      }),
    );
    return;
  }
  for (const issue of issues) {
    const line = JSON.stringify({
      event: "config_issue",
      level: issue.level,
      message: issue.message,
    });
    if (issue.level === "error") console.error(line);
    else console.warn(line);
  }
}

/** Test helper — reset the once-flag between e2e cases. */
export function resetConfigLogFlag(): void {
  logged = false;
}
