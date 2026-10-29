import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../src/decide.ts";
import { parseThreshold } from "../src/env.ts";
import type { MailguardEnv } from "../src/env.ts";
import {
  buildAllowHeaders,
  buildErrorHeaders,
  buildSpamHeaders,
} from "../src/headers.ts";
import worker from "../src/index.ts";
import { matchSender, parseList } from "../src/lists.ts";
import { parseEmail } from "../src/parse.ts";
import { createScorer } from "../src/score/index.ts";
import {
  parseModelJson,
  resolveBaseUrl,
} from "../src/score/prompt.ts";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readFixtureArrayBuffer(name: string): ArrayBuffer {
  const bytes = readFileSync(join(projectRoot, "fixtures", name));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

// Collect results so the whole run produces a durable log artifact
// and a single non-zero exit status at the end.
const logLines: string[] = [];
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    logLines.push(`[PASS] ${message}`);
    passed++;
  } else {
    logLines.push(`[FAIL] ${message}`);
    failed++;
  }
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// List matching (Task 2)
assert(
  matchSender("a@example.com", parseList("@example.com")) === true,
  "domain @example.com matches a@example.com",
);
assert(
  matchSender("a@notexample.com", parseList("@example.com")) === false,
  "domain @example.com must not match a@notexample.com",
);
assert(
  matchSender("Friend@Example.com", parseList("friend@example.com")) === true,
  "exact address match is case-insensitive",
);
assert(parseList("").length === 0, 'parseList("") → []');
assert(parseList(undefined).length === 0, "parseList(undefined) → []");

// Threshold helper (Task 2)
assert(parseThreshold(undefined) === 5.0, "parseThreshold(undefined) → 5.0");
assert(parseThreshold("7.5") === 7.5, "parseThreshold valid number");
assert(parseThreshold("bad") === 5.0, "parseThreshold invalid → 5.0");
assert(parseThreshold("-1") === 5.0, "parseThreshold non-positive → 5.0");

// Spam headers (Task 3)
const spamHigh = buildSpamHeaders({ score: 7.2, threshold: 5 });
assert(
  spamHigh.get("X-Spam-Status")?.startsWith("Yes") === true,
  "score 7.2 @ threshold 5 → X-Spam-Status Yes",
);
assert(spamHigh.get("X-Spam-Level") === "*******", "score 7.2 → seven stars");
assert(spamHigh.get("X-Spam-Score") === "7.2", "X-Spam-Score formatted");

const spamLow = buildSpamHeaders({ score: 0.8, threshold: 5 });
assert(
  spamLow.get("X-Spam-Status")?.startsWith("No") === true,
  "score 0.8 → X-Spam-Status No",
);
assert(spamLow.get("X-Spam-Level") === "", "score 0.8 → empty X-Spam-Level");

const longReason = "x".repeat(500);
const withReason = buildSpamHeaders({
  score: 3,
  threshold: 5,
  reasoning: longReason,
});
const stored = withReason.get("X-Mailguard-Reasoning") ?? "";
assert(
  stored.length <= 200,
  "reasoning truncated to ≤200 chars in header",
);

const allow = buildAllowHeaders(5);
assert(allow.get("X-Spam-Score") === "-1.0", "allowlist score -1.0");
assert(
  allow.get("X-Mailguard-Category") === "allowlist",
  "allowlist category",
);

const err = buildErrorHeaders("fail", 5);
assert(err.get("X-Mailguard-Error") === "fail", "error header message");
assert(
  err.get("X-Spam-Status")?.startsWith("No") === true,
  "error path uses score 0 → No",
);

async function runParseFixtures(): Promise<void> {
  const ham = await parseEmail(readFixtureArrayBuffer("ham.eml"));
  assert(ham.subject.length > 0, "ham.eml → non-empty subject");
  assert(ham.text.length > 0, "ham.eml → non-empty text");

  const spam = await parseEmail(readFixtureArrayBuffer("spam.eml"));
  assert(spam.subject.length > 0, "spam.eml → non-empty subject");
  assert(spam.text.length > 0, "spam.eml → non-empty text");
}

try {
  await runParseFixtures();
} catch (e) {
  assert(false, `parse fixtures threw: ${String(e)}`);
}

// Score helpers + BYOK adapters (Task 5)
const embedded = parseModelJson(
  'Sure! Here is the JSON: {"score": 7.5, "category": "phishing", "reasoning": "credential harvest"} hope that helps',
);
assert(embedded.score === 7.5, "parseModelJson extracts embedded JSON object");
assert(
  embedded.category === "phishing",
  "parseModelJson keeps category from embedded JSON",
);
assert(
  embedded.reasoning === "credential harvest",
  "parseModelJson keeps reasoning from embedded JSON",
);
assert(parseModelJson('{"score": 42}').score === 10, "parseModelJson clamps score > 10");
assert(parseModelJson('{"score": -3}').score === 0, "parseModelJson clamps score < 0");
let parseThrew = false;
try {
  parseModelJson("no json object anywhere in here");
} catch {
  parseThrew = true;
}
assert(parseThrew, "parseModelJson throws on unparseable content");

assert(
  resolveBaseUrl("", "https://api.openai.com/v1") === "https://api.openai.com/v1",
  "empty LLM_BASE_URL falls back to provider default",
);
assert(
  resolveBaseUrl("https://proxy.example/v1/", "https://api.openai.com/v1") ===
    "https://proxy.example/v1",
  "trailing slash stripped from LLM_BASE_URL",
);

function makeEnv(provider: string): MailguardEnv {
  return {
    FORWARD_TO: "me@example.com",
    ALLOW_LIST: "",
    BLOCK_LIST: "",
    SPAM_THRESHOLD: "5",
    LLM_PROVIDER: provider,
    LLM_MODEL: "test-model",
    LLM_API_KEY: "test-key",
    LLM_BASE_URL: "https://llm.test/",
  };
}

function makeMailEnv(overrides: Partial<MailguardEnv> = {}): MailguardEnv {
  return {
    ...makeEnv("openai_chat"),
    ALLOW_LIST: "friend@example.com",
    BLOCK_LIST: "bad@example.net,@evil.com",
    ...overrides,
  };
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const scoreInput = {
  from: "spam@example.net",
  to: "me@example.com",
  subject: "URGENT verify account",
  text: "click here now",
};

const realFetch = globalThis.fetch;
let lastCall: { url: string; auth?: string; body: Record<string, unknown> } | undefined;
try {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    lastCall = {
      url: String(input),
      auth: headers.get("authorization") ?? headers.get("x-api-key") ?? undefined,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return jsonResponse(
      lastCall.url.endsWith("/chat/completions")
        ? {
            choices: [
              {
                message: {
                  content:
                    '{"score": 8.2, "category": "spam", "reasoning": "bulk unsolicited"}',
                },
              },
            ],
          }
        : lastCall.url.endsWith("/responses")
          ? {
              output: [
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      text: '{"score": 1.2, "category": "personal", "reasoning": "friend mail"}',
                    },
                  ],
                },
              ],
            }
          : {
              content: [
                {
                  type: "text",
                  text: '{"score": 9.9, "category": "phishing", "reasoning": "credential harvest"}',
                },
              ],
            },
    );
  }) as typeof fetch;

  const chatResult = await createScorer(makeEnv("openai_chat"))(scoreInput);
  assert(chatResult.score === 8.2 && chatResult.category === "spam", "openai_chat adapter parses mocked chat/completions");
  assert(
    lastCall?.url === "https://llm.test/chat/completions",
    "openai_chat uses LLM_BASE_URL with trailing slash stripped",
  );
  assert(
    lastCall?.auth === "Bearer test-key",
    "openai_chat sends Bearer LLM_API_KEY",
  );
  assert(
    (lastCall?.body as { response_format?: { type?: string } }).response_format
      ?.type === "json_object",
    "openai_chat requests json_object response format",
  );

  const responsesResult = await createScorer(makeEnv("openai_responses"))(scoreInput);
  assert(
    responsesResult.score === 1.2 && responsesResult.category === "personal",
    "openai_responses adapter walks output[] output_text parts",
  );
  assert(lastCall?.url === "https://llm.test/responses", "openai_responses posts to {base}/responses");

  const anthropicResult = await createScorer(makeEnv("anthropic_messages"))(scoreInput);
  assert(
    anthropicResult.score === 9.9 && anthropicResult.category === "phishing",
    "anthropic adapter parses mocked messages text blocks",
  );
  assert(lastCall?.url === "https://llm.test/v1/messages", "anthropic posts to {base}/v1/messages");
  assert(lastCall?.auth === "test-key", "anthropic sends x-api-key header");

  let providerThrew = false;
  try {
    createScorer(makeEnv("bogus_provider"));
  } catch {
    providerThrew = true;
  }
  assert(providerThrew, "unknown LLM_PROVIDER throws");

  // Decision pipeline + email() handler (Task 6)
  // Fake ForwardableEmailMessage: exercises the real handler entry point
  // against a mocked fetch, so the whole wire (parse → decide → act) runs.
  const hamBytes = readFixtureArrayBuffer("ham.eml");

  function makeFakeMessage(from: string) {
    const msg = {
      from,
      to: "me@example.com",
      headers: new Headers({ subject: "hello from e2e" }),
      raw: new Blob([hamBytes]).stream(),
      rejected: undefined as string | undefined,
      forwarded: undefined as { to: string; headers?: Headers } | undefined,
      setReject(reason: string) {
        this.rejected = reason;
      },
      async forward(to: string, headers?: Headers) {
        this.forwarded = { to, headers };
      },
    };
    return msg;
  }

  const ctx = {} as ExecutionContext;

  // Scenario 1: blocked sender → reject
  const blocked = makeFakeMessage("bad@example.net");
  await worker.email(blocked, makeMailEnv(), ctx);
  assert(blocked.rejected === "Address not allowed", "handler: blocked sender is rejected with 'Address not allowed'");
  assert(blocked.forwarded === undefined, "handler: blocked sender is not forwarded");

  // Blocked via domain entry
  const blockedDomain = makeFakeMessage("anyone@evil.com");
  await worker.email(blockedDomain, makeMailEnv(), ctx);
  assert(blockedDomain.rejected === "Address not allowed", "handler: @evil.com domain block rejects sub-address");

  // Scenario 2: allowlisted sender → forward with score -1.0
  const allowed = makeFakeMessage("friend@example.com");
  await worker.email(allowed, makeMailEnv(), ctx);
  assert(allowed.rejected === undefined, "handler: allowlisted sender is not rejected");
  assert(allowed.forwarded?.to === "me@example.com", "handler: allowlisted sender forwarded to FORWARD_TO");
  assert(allowed.forwarded?.headers?.get("X-Spam-Score") === "-1.0", "handler: allowlist forward carries X-Spam-Score -1.0");
  assert(allowed.forwarded?.headers?.get("X-Mailguard-Category") === "allowlist", "handler: allowlist forward carries category allowlist");

  // Scenario 3: unknown sender + score 8.5 → X-Spam-Status Yes
  globalThis.fetch = (async () =>
    jsonResponse({
      choices: [
        {
          message: {
            content:
              '{"score": 8.5, "category": "spam", "reasoning": "bulk unsolicited"}',
          },
        },
      ],
    })) as typeof fetch;
  const scored = makeFakeMessage("stranger@unknown.org");
  await worker.email(scored, makeMailEnv(), ctx);
  assert(scored.rejected === undefined, "handler: unknown sender is not rejected");
  assert(scored.forwarded !== undefined, "handler: unknown sender is forwarded");
  assert(scored.forwarded?.headers?.get("X-Spam-Status")?.startsWith("Yes") === true, "handler: score 8.5 ≥ threshold 5 → X-Spam-Status Yes");
  assert(scored.forwarded?.headers?.get("X-Spam-Score") === "8.5", "handler: scored forward carries X-Spam-Score 8.5");
  assert(scored.forwarded?.headers?.get("X-Mailguard-Category") === "spam", "handler: scored forward carries scorer category");

  // Scenario 4: throwing scorer → fail-open forward + X-Mailguard-Error
  globalThis.fetch = (async () => {
    throw new Error("LLM provider down");
  }) as typeof fetch;
  const errored = makeFakeMessage("stranger@unknown.org");
  await worker.email(errored, makeMailEnv(), ctx);
  assert(errored.rejected === undefined, "handler: scorer failure does not reject (fail-open)");
  assert(errored.forwarded !== undefined, "handler: scorer failure still forwards");
  assert(errored.forwarded?.headers?.get("X-Mailguard-Error") === "LLM provider down", "handler: scorer failure sets X-Mailguard-Error");

  // Unsupported provider must also fail open through the handler
  const bogusEnv = makeMailEnv({ LLM_PROVIDER: "bogus_provider" });
  const bogus = makeFakeMessage("stranger@unknown.org");
  await worker.email(bogus, bogusEnv, ctx);
  assert(bogus.forwarded?.headers?.get("X-Mailguard-Error") !== undefined, "handler: unsupported LLM_PROVIDER fails open with X-Mailguard-Error");
} finally {
  globalThis.fetch = realFetch;
}

// Scenario 5: domain @example.com must not substring-match notexample.com
const notExample = await decide({
  from: "someone@notexample.com",
  to: "me@example.com",
  subject: "hi",
  text: "hello",
  env: makeMailEnv({ ALLOW_LIST: "@example.com", BLOCK_LIST: "" }),
  scoreEmail: async () => ({ score: 4.2, category: "personal", reasoning: "friend" }),
});
assert(
  notExample.action === "forward" && notExample.path === "score",
  "decide: @example.com allow entry does not substring-match notexample.com → score path",
);
assert(
  notExample.action === "forward" && notExample.score === 4.2,
  "decide: notexample.com sender reaches the scorer",
);

// Allowlisted via decide() directly
const allowedDecision = await decide({
  from: "pal@example.com",
  to: "me@example.com",
  subject: "hi",
  text: "hello",
  env: makeMailEnv({ ALLOW_LIST: "@example.com" }),
  scoreEmail: async () => ({ score: 9.9 }),
});
assert(
  allowedDecision.action === "forward" && allowedDecision.path === "allow",
  "decide: allowlisted sender takes allow path without scoring",
);
assert(
  allowedDecision.action === "forward" &&
    allowedDecision.headers.get("X-Spam-Score") === "-1.0",
  "decide: allow path carries X-Spam-Score -1.0",
);

// Blocked via decide() directly
const blockedDecision = await decide({
  from: "bad@example.net",
  to: "me@example.com",
  subject: "hi",
  text: "hello",
  env: makeMailEnv(),
  scoreEmail: async () => ({ score: 0 }),
});
assert(
  blockedDecision.action === "reject" && blockedDecision.reason === "Address not allowed",
  "decide: blocked sender rejects before scoring runs",
);

const total = passed + failed;
const summary =
  failed === 0
    ? `SUMMARY: ${passed}/${total} assertions passed`
    : `SUMMARY: FAILED ${failed}/${total} assertions`;

logLines.push(summary);

const artifactsDir = join(projectRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });
const logPath = join(artifactsDir, `e2e-${stamp()}.log`);
writeFileSync(logPath, logLines.join("\n") + "\n", "utf8");

console.log(summary);
console.log(`e2e log: ${logPath}`);
if (failed > 0) {
  console.log(logLines.filter((l) => l.startsWith("[FAIL]")).join("\n"));
  process.exit(1);
}
console.log("e2e: list + env + headers + parse + score + decide OK");
