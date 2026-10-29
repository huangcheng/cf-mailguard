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
  resolveAnthropicBaseUrl,
  resolveBaseUrl,
  SCORE_SYSTEM_PROMPT,
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

try {
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
  assert(
    matchSender("user@mail.evil.com", parseList("@evil.com")) === true,
    "domain entry matches subdomain mail.evil.com",
  );
  assert(
    matchSender("user@evil.com.", parseList("evil.com")) === true,
    "trailing root dot on envelope domain still matches",
  );
  assert(parseList("").length === 0, 'parseList("") → []');
  assert(parseList(undefined).length === 0, "parseList(undefined) → []");
  assert(
    parseList("a@b.com\n@evil.com; c@d.com").length === 3,
    "parseList splits on whitespace/comma/semicolon",
  );

  // Threshold helper (Task 2)
  assert(parseThreshold(undefined) === 5.0, "parseThreshold(undefined) → 5.0");
  assert(parseThreshold("7.5") === 7.5, "parseThreshold valid number");
  assert(parseThreshold("bad") === 5.0, "parseThreshold invalid → 5.0");
  assert(parseThreshold("-1") === 5.0, "parseThreshold non-positive → 5.0");
  assert(parseThreshold("7abc") === 5.0, "parseThreshold partial junk → 5.0");

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

  const crlfReason = "ignore\r\nBcc: attacker@evil.test";
  const crlfHeaders = buildSpamHeaders({
    score: 3,
    threshold: 5,
    reasoning: crlfReason,
  });
  assert(
    !/[\r\n]/.test(crlfHeaders.get("X-Mailguard-Reasoning") ?? ""),
    "reasoning CRLF is stripped (no header injection)",
  );

  const cjkHeaders = buildSpamHeaders({
    score: 1,
    threshold: 5,
    category: "personal",
    reasoning: "正常邮件测试",
  });
  assert(
    (cjkHeaders.get("X-Mailguard-Reasoning") ?? "").includes("?"),
    "non-Latin-1 reasoning is sanitized for Headers.set",
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
  assert(
    buildErrorHeaders("  \n\r  ", 5).get("X-Mailguard-Error") === "scoring_failed",
    "whitespace-only error falls back to scoring_failed",
  );
  assert(
    !/[\r\n]/.test(buildErrorHeaders("x\r\ny", 5).get("X-Mailguard-Error") ?? ""),
    "error header CRLF is stripped",
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
  assert(
    parseModelJson('{"score": "7.5", "category": "spam"}').score === 7.5,
    "parseModelJson coerces numeric string scores",
  );
  assert(
    parseModelJson('{"score": 1, "category": "not-a-real-category"}').category ===
      undefined,
    "parseModelJson drops categories outside the allowlist",
  );
  let parseThrew = false;
  try {
    parseModelJson("no json object anywhere in here");
  } catch {
    parseThrew = true;
  }
  assert(parseThrew, "parseModelJson throws when no JSON object is present");

  assert(
    resolveBaseUrl("", "https://api.openai.com/v1") === "https://api.openai.com/v1",
    "resolveBaseUrl empty → fallback",
  );
  assert(
    resolveBaseUrl("https://llm.test/", "https://api.openai.com/v1") ===
      "https://llm.test",
    "resolveBaseUrl strips trailing slash",
  );
  assert(
    resolveAnthropicBaseUrl("https://proxy.test/v1", "https://api.anthropic.com") ===
      "https://proxy.test",
    "resolveAnthropicBaseUrl strips trailing /v1",
  );

  function makeEnv(
    provider: string,
    overrides: Partial<MailguardEnv> = {},
  ): MailguardEnv {
    return {
      FORWARD_TO: "me@example.com",
      ALLOW_LIST: "",
      BLOCK_LIST: "",
      SPAM_THRESHOLD: "5.0",
      LLM_PROVIDER: provider,
      LLM_MODEL: "test-model",
      LLM_API_KEY: "test-key",
      LLM_BASE_URL: "https://llm.test/",
      ...overrides,
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

  function jsonResponse(obj: unknown, status = 200): Response {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const scoreInput = {
    from: "spam@example.net",
    to: "me@example.com",
    subject: "URGENT verify account",
    text: "click here now",
  };

  const CHAT_JSON =
    '{"score": 8.2, "category": "spam", "reasoning": "bulk unsolicited"}';
  const RESPONSES_JSON =
    '{"score": 1.2, "category": "personal", "reasoning": "friend mail"}';
  const ANTHROPIC_JSON =
    '{"score": 9.9, "category": "phishing", "reasoning": "credential harvest"}';

  function mockProviderBody(url: string): unknown {
    if (url.endsWith("/chat/completions")) {
      return { choices: [{ message: { content: CHAT_JSON } }] };
    }
    if (url.endsWith("/responses")) {
      return {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: RESPONSES_JSON }],
          },
        ],
      };
    }
    if (url.endsWith("/v1/messages")) {
      return { content: [{ type: "text", text: ANTHROPIC_JSON }] };
    }
    throw new Error(`unexpected provider endpoint: ${url}`);
  }

  const realFetch = globalThis.fetch;
  let lastCall:
    | {
        url: string;
        auth?: string;
        body: Record<string, unknown>;
        signal?: AbortSignal | null;
      }
    | undefined;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      lastCall = {
        url: String(input),
        auth: headers.get("authorization") ?? headers.get("x-api-key") ?? undefined,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        signal: init?.signal ?? null,
      };
      return jsonResponse(mockProviderBody(lastCall.url));
    }) as typeof fetch;

    const chatResult = await createScorer(makeEnv("openai_chat"))(scoreInput);
    assert(
      chatResult.score === 8.2 && chatResult.category === "spam",
      "openai_chat adapter parses mocked chat/completions",
    );
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
    assert(lastCall?.signal != null, "openai_chat passes AbortSignal timeout");
    const chatMessages = (
      lastCall?.body as { messages?: Array<{ role?: string; content?: string }> }
    ).messages;
    assert(
      chatMessages?.[0]?.content === SCORE_SYSTEM_PROMPT,
      "openai_chat includes SCORE_SYSTEM_PROMPT",
    );
    assert(
      chatMessages?.[1]?.content?.includes("Envelope-From: spam@example.net") ===
        true,
      "openai_chat user prompt includes envelope from",
    );
    assert(
      chatMessages?.[1]?.content?.includes("<<<UNTRUSTED_EMAIL_BEGIN>>>") === true,
      "openai_chat fences untrusted email content",
    );

    const responsesResult = await createScorer(makeEnv("openai_responses"))(
      scoreInput,
    );
    assert(
      responsesResult.score === 1.2 && responsesResult.category === "personal",
      "openai_responses adapter walks output[] output_text parts",
    );
    assert(
      lastCall?.url === "https://llm.test/responses",
      "openai_responses posts to {base}/responses",
    );
    assert(
      (lastCall?.body as { store?: boolean }).store === false,
      "openai_responses sets store:false",
    );

    const anthropicResult = await createScorer(makeEnv("anthropic_messages"))(
      scoreInput,
    );
    assert(
      anthropicResult.score === 9.9 && anthropicResult.category === "phishing",
      "anthropic adapter parses mocked messages text blocks",
    );
    assert(
      lastCall?.url === "https://llm.test/v1/messages",
      "anthropic posts to {base}/v1/messages",
    );
    assert(lastCall?.auth === "test-key", "anthropic sends x-api-key header");

    let providerThrew = false;
    try {
      createScorer(makeEnv("bogus_provider"));
    } catch {
      providerThrew = true;
    }
    assert(providerThrew, "unknown LLM_PROVIDER throws");

    // Decision pipeline + email() handler (Task 6)
    const hamBytes = readFixtureArrayBuffer("ham.eml");

    function makeFakeMessage(from: string) {
      const msg = {
        from,
        to: "me@example.com",
        headers: new Headers({ subject: "hello from e2e" }),
        raw: new Blob([hamBytes]).stream(),
        rawSize: hamBytes.byteLength,
        rejected: undefined as string | undefined,
        forwarded: undefined as { to: string; headers?: Headers } | undefined,
        setReject(reason: string) {
          this.rejected = reason;
        },
        async forward(to: string, headers?: Headers) {
          this.forwarded = { to, headers };
        },
        async reply() {
          return {} as EmailSendResult;
        },
      };
      return msg;
    }

    const ctx = {} as ExecutionContext;

    // Scenario 1: blocked sender → reject
    const blocked = makeFakeMessage("bad@example.net");
    await worker.email(blocked as unknown as ForwardableEmailMessage, makeMailEnv(), ctx);
    assert(
      blocked.rejected === "Address not allowed",
      "handler: blocked sender is rejected with 'Address not allowed'",
    );
    assert(
      blocked.forwarded === undefined,
      "handler: blocked sender is not forwarded",
    );

    // Blocked via domain entry
    const blockedDomain = makeFakeMessage("anyone@evil.com");
    await worker.email(
      blockedDomain as unknown as ForwardableEmailMessage,
      makeMailEnv(),
      ctx,
    );
    assert(
      blockedDomain.rejected === "Address not allowed",
      "handler: @evil.com domain block rejects sub-address",
    );

    // Subdomain block
    const blockedSub = makeFakeMessage("x@mail.evil.com");
    await worker.email(
      blockedSub as unknown as ForwardableEmailMessage,
      makeMailEnv(),
      ctx,
    );
    assert(
      blockedSub.rejected === "Address not allowed",
      "handler: @evil.com also blocks mail.evil.com",
    );

    // Scenario 2: allowlisted sender → forward with score -1.0
    let allowScorerCalls = 0;
    globalThis.fetch = (async () => {
      allowScorerCalls++;
      return jsonResponse(mockProviderBody("https://llm.test/chat/completions"));
    }) as typeof fetch;
    const allowed = makeFakeMessage("friend@example.com");
    await worker.email(
      allowed as unknown as ForwardableEmailMessage,
      makeMailEnv(),
      ctx,
    );
    assert(allowed.rejected === undefined, "handler: allowlisted sender is not rejected");
    assert(
      allowed.forwarded?.to === "me@example.com",
      "handler: allowlisted sender forwarded to FORWARD_TO",
    );
    assert(
      allowed.forwarded?.headers?.get("X-Spam-Score") === "-1.0",
      "handler: allowlist forward carries X-Spam-Score -1.0",
    );
    assert(
      allowed.forwarded?.headers?.get("X-Mailguard-Category") === "allowlist",
      "handler: allowlist forward carries category allowlist",
    );
    assert(allowScorerCalls === 0, "handler: allowlist path never calls the LLM");

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
    await worker.email(
      scored as unknown as ForwardableEmailMessage,
      makeMailEnv(),
      ctx,
    );
    assert(scored.rejected === undefined, "handler: unknown sender is not rejected");
    assert(scored.forwarded !== undefined, "handler: unknown sender is forwarded");
    assert(
      scored.forwarded?.headers?.get("X-Spam-Status")?.startsWith("Yes") === true,
      "handler: score 8.5 ≥ threshold 5 → X-Spam-Status Yes",
    );
    assert(
      scored.forwarded?.headers?.get("X-Spam-Score") === "8.5",
      "handler: scored forward carries X-Spam-Score 8.5",
    );
    assert(
      scored.forwarded?.headers?.get("X-Mailguard-Category") === "spam",
      "handler: scored forward carries scorer category",
    );

    // Scenario 4: throwing scorer → fail-open forward + X-Mailguard-Error
    globalThis.fetch = (async () => {
      throw new Error("LLM provider down");
    }) as typeof fetch;
    const errored = makeFakeMessage("stranger@unknown.org");
    await worker.email(
      errored as unknown as ForwardableEmailMessage,
      makeMailEnv(),
      ctx,
    );
    assert(
      errored.rejected === undefined,
      "handler: scorer failure does not reject (fail-open)",
    );
    assert(errored.forwarded !== undefined, "handler: scorer failure still forwards");
    assert(
      errored.forwarded?.headers?.get("X-Mailguard-Error") === "LLM provider down",
      "handler: scorer failure sets X-Mailguard-Error",
    );

    // Non-2xx HTTP fail-open
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    const httpErr = makeFakeMessage("stranger@unknown.org");
    await worker.email(
      httpErr as unknown as ForwardableEmailMessage,
      makeMailEnv(),
      ctx,
    );
    assert(
      httpErr.forwarded?.headers?.get("X-Mailguard-Error")?.includes("500") === true,
      "handler: HTTP 500 fail-open sets X-Mailguard-Error",
    );

    // AbortError (timeout) fail-open
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert(init?.signal != null, "timeout path receives AbortSignal");
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;
    const timedOut = makeFakeMessage("stranger@unknown.org");
    await worker.email(
      timedOut as unknown as ForwardableEmailMessage,
      makeMailEnv(),
      ctx,
    );
    assert(
      timedOut.forwarded?.headers?.get("X-Mailguard-Error") !== undefined,
      "handler: AbortError fail-open sets X-Mailguard-Error",
    );

    // Unsupported provider must also fail open through the handler
    const bogusEnv = makeMailEnv({ LLM_PROVIDER: "bogus_provider" });
    const bogus = makeFakeMessage("stranger@unknown.org");
    await worker.email(
      bogus as unknown as ForwardableEmailMessage,
      bogusEnv,
      ctx,
    );
    assert(
      bogus.forwarded?.headers?.get("X-Mailguard-Error") !== undefined,
      "handler: unsupported LLM_PROVIDER fails open with X-Mailguard-Error",
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  // Scenario 5: domain @example.com must not substring-match notexample.com
  let scoreCalls = 0;
  const notExample = await decide({
    from: "someone@notexample.com",
    to: "me@example.com",
    subject: "hi",
    text: "hello",
    env: makeMailEnv({ ALLOW_LIST: "@example.com", BLOCK_LIST: "" }),
    scoreEmail: async () => {
      scoreCalls++;
      return { score: 4.2, category: "personal", reasoning: "friend" };
    },
  });
  assert(
    notExample.action === "forward" && notExample.path === "score",
    "decide: @example.com allow entry does not substring-match notexample.com → score path",
  );
  assert(
    notExample.action === "forward" && notExample.score === 4.2,
    "decide: notexample.com sender reaches the scorer",
  );
  assert(scoreCalls === 1, "decide: scorer invoked once for non-list sender");

  // Allowlisted via decide() directly
  let allowDecideCalls = 0;
  const allowedDecision = await decide({
    from: "pal@example.com",
    to: "me@example.com",
    subject: "hi",
    text: "hello",
    env: makeMailEnv({ ALLOW_LIST: "@example.com" }),
    scoreEmail: async () => {
      allowDecideCalls++;
      return { score: 9.9 };
    },
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
  assert(allowDecideCalls === 0, "decide: allow path does not invoke scoreEmail");

  // Blocked via decide() directly
  let blockDecideCalls = 0;
  const blockedDecision = await decide({
    from: "bad@example.net",
    to: "me@example.com",
    subject: "hi",
    text: "hello",
    env: makeMailEnv(),
    scoreEmail: async () => {
      blockDecideCalls++;
      return { score: 0 };
    },
  });
  assert(
    blockedDecision.action === "reject" &&
      blockedDecision.reason === "Address not allowed",
    "decide: blocked sender rejects before scoring runs",
  );
  assert(blockDecideCalls === 0, "decide: block path does not invoke scoreEmail");

  // Parse error path is visible fail-open
  const parseFail = await decide({
    from: "stranger@unknown.org",
    to: "me@example.com",
    subject: "hi",
    text: "",
    parseError: "mime boom",
    env: makeMailEnv({ ALLOW_LIST: "", BLOCK_LIST: "" }),
    scoreEmail: async () => ({ score: 0 }),
  });
  assert(
    parseFail.action === "forward" && parseFail.path === "error",
    "decide: parseError takes error path",
  );
  assert(
    parseFail.action === "forward" &&
      parseFail.headers.get("X-Mailguard-Error") === "mime boom",
    "decide: parseError sets X-Mailguard-Error",
  );
} catch (e) {
  assert(false, `unexpected error: ${String(e)}`);
}

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
  process.exitCode = 1;
} else {
  console.log("e2e: list + env + headers + parse + score + decide OK");
}
