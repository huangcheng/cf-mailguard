import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseThreshold } from "../src/env.ts";
import {
  buildAllowHeaders,
  buildErrorHeaders,
  buildSpamHeaders,
} from "../src/headers.ts";
import { matchSender, parseList } from "../src/lists.ts";
import { parseEmail } from "../src/parse.ts";
import { createScorer } from "../src/score/index.ts";
import {
  parseModelJson,
  resolveBaseUrl,
} from "../src/score/prompt.ts";
import type { MailguardEnv } from "../src/env.ts";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readFixtureArrayBuffer(name: string): ArrayBuffer {
  const bytes = readFileSync(join(projectRoot, "fixtures", name));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
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

await runParseFixtures();

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
} finally {
  globalThis.fetch = realFetch;
}

console.log("e2e: list + env + headers + parse + score OK");
