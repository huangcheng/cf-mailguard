import { parseThreshold } from "../src/env.ts";
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

console.log("e2e: list + env helpers OK");
