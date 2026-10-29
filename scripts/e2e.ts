import { parseThreshold } from "../src/env.ts";
import {
  buildAllowHeaders,
  buildErrorHeaders,
  buildSpamHeaders,
} from "../src/headers.ts";
import { matchSender, parseList } from "../src/lists.ts";

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

console.log("e2e: list + env + headers OK");
