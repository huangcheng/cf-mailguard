# Mailguard Email Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single Cloudflare Email Worker that allow/block-lists via env, BYOK-scores unknown mail, stamps `X-Spam-*` headers, and forwards (or `setReject`s) per the design spec.

**Architecture:** One TypeScript Worker with a pure decision pipeline (`decide`) fed by list matching, header builders, and a pluggable `scoreEmail` (OpenAI Chat / Responses / Anthropic). The `email()` handler only buffers MIME, calls `decide`, then `forward` or `setReject`. E2E scripts drive `decide` + a fake message with a mocked LLM; Cloudflare logs cover production observability.

**Tech Stack:** Cloudflare Workers (Email Routing `email()` handler), TypeScript, Wrangler (`wrangler.jsonc`), `postal-mime`, Node-compatible `fetch` to BYOK APIs. Package manager: npm.

**Spec:** `docs/superpowers/specs/2026-10-29-mailguard-design.md`

## Global Constraints

- No D1, R2, Durable Objects, dashboard, or quarantine UI in v1.
- Only add `X-*` headers on `message.forward()` (Cloudflare Email API rule).
- Envelope `message.from` is authoritative for allow/block matching.
- Fail-open on LLM errors: forward with `X-Spam-Score: 0` and `X-Mailguard-Error`.
- Block list → `setReject("Address not allowed")`; never silently drop.
- Score scale **0.0–10.0**; default `SPAM_THRESHOLD` **5.0**.
- Config names exactly: `FORWARD_TO`, `ALLOW_LIST`, `BLOCK_LIST`, `SPAM_THRESHOLD`, `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL`.
- `LLM_PROVIDER` values: `openai_chat` | `openai_responses` | `anthropic_messages`.
- Testing: E2E only (fixtures + script → `artifacts/`); do not add a unit-test suite.
- Engineering artifacts (code, commits, README) in English.
- GitHub remote: `huangcheng/cf-mailguard`; local folder may remain `mailguard`.

## Review Focus

- Empty or malformed `ALLOW_LIST` / `BLOCK_LIST` → treat as empty lists; never throw before forward/reject.
- Missing `FORWARD_TO` or `LLM_API_KEY` on the AI path → fail-open forward with `X-Mailguard-Error` (block/allow paths still work without LLM).
- LLM returns non-JSON or out-of-range score → clamp score to 0–10 or fail-open with error header.
- Reasoning/category headers longer than ~200 chars → truncate so forward headers stay valid.
- Domain allow `@example.com` must not match `notexample.com`; match only exact email or domain label after `@`.

## File structure

| Path | Responsibility |
|------|----------------|
| `package.json` | Scripts: `deploy`, `types`, `e2e`; deps: `postal-mime`, `wrangler`, typescript |
| `wrangler.jsonc` | Worker name `cf-mailguard`, compat date, `[vars]` placeholders |
| `tsconfig.json` | Strict TS for Workers |
| `src/env.ts` | `Env` type + parse lists / threshold helpers |
| `src/lists.ts` | `matchList(from, listCsv) → boolean` |
| `src/headers.ts` | Build `Headers` from score / allow / error |
| `src/parse.ts` | Buffer raw → subject + truncated plain text via postal-mime |
| `src/score/types.ts` | `ScoreInput`, `ScoreResult`, `Scorer` |
| `src/score/prompt.ts` | Shared system/user prompt + JSON parse/clamp |
| `src/score/openai-chat.ts` | Chat Completions adapter |
| `src/score/openai-responses.ts` | Responses API adapter |
| `src/score/anthropic.ts` | Messages API adapter |
| `src/score/index.ts` | `createScorer(env) → Scorer` |
| `src/decide.ts` | Pure pipeline: lists → score → action + headers |
| `src/index.ts` | `email()` handler wiring |
| `fixtures/*.eml` | Minimal ham/spam/allow/block samples |
| `scripts/e2e.mjs` | Runs pipeline scenarios; writes `artifacts/e2e-*.log` |
| `artifacts/.gitkeep` | Durable E2E output dir (logs gitignored) |
| `README.md` | Install, config, Email Routing, client rules |
| `.gitignore` | `node_modules`, `.wrangler`, `.dev.vars`, `artifacts/*.log` |

---

### Task 1: Scaffold Worker project

**Files:**
- Create: `package.json`, `wrangler.jsonc`, `tsconfig.json`, `.gitignore`, `artifacts/.gitkeep`, `src/index.ts` (stub)
- Test: `npm run types` (after install)

**Interfaces:**
- Consumes: none
- Produces: deployable empty Worker named `cf-mailguard` with `Env` vars declared in config

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "cf-mailguard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "types": "wrangler types",
    "e2e": "node scripts/e2e.mjs"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20251011.0",
    "typescript": "^5.9.0",
    "wrangler": "^4.42.0"
  },
  "dependencies": {
    "postal-mime": "^2.4.3"
  }
}
```

- [ ] **Step 2: Create `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-mailguard",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-29",
  "compatibility_flags": [],
  "vars": {
    "FORWARD_TO": "you@example.com",
    "ALLOW_LIST": "",
    "BLOCK_LIST": "",
    "SPAM_THRESHOLD": "5.0",
    "LLM_PROVIDER": "openai_chat",
    "LLM_MODEL": "gpt-4.1-mini",
    "LLM_BASE_URL": ""
  }
}
```

Do **not** put `LLM_API_KEY` in vars. Document `wrangler secret put LLM_API_KEY` and local `.dev.vars`.

- [ ] **Step 3: Create `tsconfig.json` and `.gitignore`**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts", "worker-configuration.d.ts"]
}
```

`.gitignore`:

```
node_modules/
.wrangler/
.dev.vars
dist/
artifacts/*.log
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 4: Stub `src/index.ts`**

```typescript
export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`mailguard stub: from=${message.from} to=${message.to}`);
    await message.forward(env.FORWARD_TO);
  },
};
```

- [ ] **Step 5: Install and generate types**

```bash
npm install
npx wrangler types
```

Expected: `worker-configuration.d.ts` (or equivalent) includes `FORWARD_TO` and friends. If `Env` is incomplete, add `src/env.ts` with an explicit interface and use it until types catch up.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json wrangler.jsonc tsconfig.json .gitignore artifacts/.gitkeep src/index.ts worker-configuration.d.ts
git commit -m "chore: scaffold cf-mailguard Email Worker"
```

---

### Task 2: List matching + env helpers

**Files:**
- Create: `src/lists.ts`, `src/env.ts`
- Modify: (none yet)
- Test: extend `scripts/e2e.mjs` scenarios for lists (created fully in Task 6; for this task add a temporary assert block or run node -e)

**Interfaces:**
- Consumes: CSV strings from env
- Produces:
  - `parseList(csv: string): string[]`
  - `matchSender(from: string, entries: string[]): boolean`
  - `parseThreshold(raw: string | undefined): number` → default `5.0`

- [ ] **Step 1: Implement `src/lists.ts`**

```typescript
/** Split comma-separated allow/block config into trimmed lowercase entries. */
export function parseList(csv: string | undefined): string[] {
  if (!csv || !csv.trim()) return [];
  return csv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Match envelope from against entries.
 * Entry forms: "user@domain.tld" (exact) or "@domain.tld" / "domain.tld" (domain).
 * Domain match is exact label equality after @ — not substring.
 */
export function matchSender(from: string, entries: string[]): boolean {
  const normalized = from.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = normalized.slice(at + 1);
  for (const entry of entries) {
    if (entry.startsWith("@")) {
      if (domain === entry.slice(1)) return true;
    } else if (entry.includes("@")) {
      if (normalized === entry) return true;
    } else if (domain === entry) {
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 2: Implement threshold helper in `src/env.ts`**

```typescript
export interface MailguardEnv {
  FORWARD_TO: string;
  ALLOW_LIST: string;
  BLOCK_LIST: string;
  SPAM_THRESHOLD: string;
  LLM_PROVIDER: string;
  LLM_MODEL: string;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
}

export function parseThreshold(raw: string | undefined): number {
  const n = Number.parseFloat(raw ?? "5.0");
  return Number.isFinite(n) && n > 0 ? n : 5.0;
}
```

- [ ] **Step 3: Verify list edge cases (inline E2E probe)**

```bash
node --input-type=module -e '
import { parseList, matchSender } from "./src/lists.ts";
// If TS import fails under node, temporarily compile with wrangler/vite or rewrite probe as .mjs duplicating logic until Task 6 bundles e2e.
'
```

Prefer: in Task 6 the E2E script imports built logic. For Task 2 verification, add assertions inside `scripts/e2e.mjs` early skeleton:

```javascript
import { matchSender, parseList } from "../src/lists.ts"; // use tsx if needed: npx tsx scripts/e2e.ts
```

If Node cannot import `.ts`, add `tsx` as a devDependency and set `"e2e": "tsx scripts/e2e.ts"`. **Do that now if needed.**

Required assertions:
- `matchSender("a@example.com", parseList("@example.com")) === true`
- `matchSender("a@notexample.com", parseList("@example.com")) === false`
- `matchSender("Friend@Example.com", parseList("friend@example.com")) === true`
- `parseList("")` / `parseList(undefined)` → `[]`

- [ ] **Step 4: Commit**

```bash
git add src/lists.ts src/env.ts package.json package-lock.json
git commit -m "feat: add allow/block list matching helpers"
```

---

### Task 3: Spam header builders

**Files:**
- Create: `src/headers.ts`
- Test: E2E assertions in `scripts/e2e.ts` (header shape)

**Interfaces:**
- Consumes: score number, threshold, optional category/reasoning/error
- Produces:
  - `buildSpamHeaders(opts): Headers`
  - `buildAllowHeaders(threshold): Headers`
  - `buildErrorHeaders(message: string, threshold: number): Headers`

- [ ] **Step 1: Implement `src/headers.ts`**

```typescript
const REASONING_MAX = 200;

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(10, Math.max(0, score));
}

export function spamLevel(score: number): string {
  const n = Math.min(10, Math.max(0, Math.floor(clampScore(score))));
  return "*".repeat(n);
}

function trunc(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/[\r\n]+/g, " ").trim();
  return t.length <= REASONING_MAX ? t : t.slice(0, REASONING_MAX - 1) + "…";
}

export function buildSpamHeaders(opts: {
  score: number;
  threshold: number;
  category?: string;
  reasoning?: string;
}): Headers {
  const score = clampScore(opts.score);
  const yes = score >= opts.threshold;
  const headers = new Headers();
  headers.set("X-Spam-Score", score.toFixed(1));
  headers.set(
    "X-Spam-Status",
    `${yes ? "Yes" : "No"}, score=${score.toFixed(1)} required=${opts.threshold.toFixed(1)}`,
  );
  headers.set("X-Spam-Level", spamLevel(score));
  const cat = trunc(opts.category);
  const reason = trunc(opts.reasoning);
  if (cat) headers.set("X-Mailguard-Category", cat);
  if (reason) headers.set("X-Mailguard-Reasoning", reason);
  return headers;
}

export function buildAllowHeaders(threshold: number): Headers {
  const headers = new Headers();
  headers.set("X-Spam-Score", "-1.0");
  headers.set("X-Spam-Status", `No, score=-1.0 required=${threshold.toFixed(1)}`);
  headers.set("X-Spam-Level", "");
  headers.set("X-Mailguard-Category", "allowlist");
  return headers;
}

export function buildErrorHeaders(message: string, threshold: number): Headers {
  const headers = buildSpamHeaders({ score: 0, threshold });
  headers.set("X-Mailguard-Error", trunc(message) ?? "scoring_failed");
  return headers;
}
```

- [ ] **Step 2: Assert header contract in E2E script (partial)**

Cases:
- score `7.2`, threshold `5` → `X-Spam-Status` starts with `Yes`, Level `*******`
- score `0.8` → `No`, Level empty or ``
- reasoning 500 chars → stored header length ≤ 200

- [ ] **Step 3: Commit**

```bash
git add src/headers.ts scripts/e2e.ts
git commit -m "feat: build X-Spam-* and Mailguard headers"
```

---

### Task 4: MIME parse (truncated body)

**Files:**
- Create: `src/parse.ts`, `fixtures/ham.eml`, `fixtures/spam.eml`
- Test: E2E parse of fixtures

**Interfaces:**
- Consumes: `ArrayBuffer` raw MIME
- Produces: `parseEmail(raw: ArrayBuffer): Promise<{ subject: string; text: string }>` with text truncated to 3000 chars

- [ ] **Step 1: Add fixtures**

`fixtures/ham.eml` — short personal message.  
`fixtures/spam.eml` — obvious phishing-ish subject/body.

Minimal example:

```
From: friend@example.com
To: you@example.com
Subject: Lunch tomorrow?
Content-Type: text/plain; charset=utf-8

Want to grab lunch at noon?
```

- [ ] **Step 2: Implement `src/parse.ts`**

```typescript
import PostalMime from "postal-mime";

const BODY_MAX = 3000;

export async function parseEmail(raw: ArrayBuffer): Promise<{ subject: string; text: string }> {
  const parsed = await PostalMime.parse(raw);
  const subject = parsed.subject ?? "";
  let text = (parsed.text ?? "").trim();
  if (!text && parsed.html) {
    text = parsed.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (text.length > BODY_MAX) text = text.slice(0, BODY_MAX);
  return { subject, text };
}
```

- [ ] **Step 3: E2E — parse fixtures, expect non-empty subject/text**

- [ ] **Step 4: Commit**

```bash
git add src/parse.ts fixtures/*.eml
git commit -m "feat: parse inbound MIME for scoring context"
```

---

### Task 5: BYOK scorers

**Files:**
- Create: `src/score/types.ts`, `src/score/prompt.ts`, `src/score/openai-chat.ts`, `src/score/openai-responses.ts`, `src/score/anthropic.ts`, `src/score/index.ts`
- Test: E2E with mock `fetch` / injectable scorer

**Interfaces:**
- Consumes: `MailguardEnv`, `ScoreInput { from, to, subject, text }`
- Produces:
  - `export type Scorer = (input: ScoreInput) => Promise<ScoreResult>`
  - `ScoreResult = { score: number; category?: string; reasoning?: string }`
  - `createScorer(env: MailguardEnv): Scorer`
  - `parseModelJson(content: string): ScoreResult` (shared)

- [ ] **Step 1: Types + prompt + JSON parse**

Prompt must ask for JSON only:

```json
{ "score": 0.0, "category": "personal|newsletter|marketing|transactional|spam|phishing|unknown", "reasoning": "short" }
```

`parseModelJson`: extract first `{...}`, `JSON.parse`, `clampScore` on `score`; throw on total failure (caller fail-opens).

- [ ] **Step 2: OpenAI Chat adapter**

- Default base: `https://api.openai.com/v1`  
- `POST {base}/chat/completions` with `model`, `messages`, `response_format: { type: "json_object" }` if supported  
- Header: `Authorization: Bearer ${LLM_API_KEY}`  
- Use `LLM_BASE_URL` when non-empty (strip trailing slash)

- [ ] **Step 3: OpenAI Responses adapter**

- `POST {base}/responses` with the current Responses body shape for the pinned docs at implementation time (retrieve from OpenAI docs / Context7 — do not invent fields).  
- Same auth and model env vars.

- [ ] **Step 4: Anthropic Messages adapter**

- Default base: `https://api.anthropic.com`  
- `POST {base}/v1/messages`  
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`  
- Parse text content blocks for JSON

- [ ] **Step 5: `createScorer(env)`**

Switch on `env.LLM_PROVIDER`; unknown provider → throw `Error("unsupported LLM_PROVIDER")`.

- [ ] **Step 6: E2E with mock scorer**

Do not call real APIs in CI. Inject:

```typescript
const fake: Scorer = async () => ({ score: 8.5, category: "phishing", reasoning: "credential harvest" });
```

Assert `decide` (Task 6) uses it. Optionally mock `globalThis.fetch` once per adapter with a canned JSON body.

- [ ] **Step 7: Commit**

```bash
git add src/score
git commit -m "feat: add BYOK OpenAI and Anthropic scorers"
```

---

### Task 6: Decision pipeline + `email()` handler

**Files:**
- Create: `src/decide.ts`
- Modify: `src/index.ts`
- Create/complete: `scripts/e2e.ts`, `fixtures/allow-from.txt` notes in README if needed

**Interfaces:**
- Consumes: lists, headers, parse, Scorer
- Produces:

```typescript
export type Decision =
  | { action: "reject"; reason: string }
  | { action: "forward"; headers: Headers; path: "allow" | "score" | "error"; score?: number };

export async function decide(opts: {
  from: string;
  to: string;
  subject: string;
  text: string;
  env: MailguardEnv;
  scoreEmail: Scorer;
}): Promise<Decision>;
```

- [ ] **Step 1: Implement `decide`**

Order (spec):
1. Block list → `{ action: "reject", reason: "Address not allowed" }`
2. Allow list → `{ action: "forward", headers: buildAllowHeaders(...), path: "allow" }`
3. Try `scoreEmail` → `buildSpamHeaders` → forward `path: "score"`
4. Catch → `buildErrorHeaders` → forward `path: "error"`

Log with `console.log` JSON-ish: `{ from, path, score }`.

- [ ] **Step 2: Wire `src/index.ts`**

```typescript
import { decide } from "./decide";
import { parseEmail } from "./parse";
import { createScorer } from "./score/index";
import { parseThreshold, type MailguardEnv } from "./env";
import { parseList, matchSender } from "./lists";

export default {
  async email(message: ForwardableEmailMessage, env: MailguardEnv, _ctx: ExecutionContext): Promise<void> {
    const threshold = parseThreshold(env.SPAM_THRESHOLD);
    const from = message.from;

    if (matchSender(from, parseList(env.BLOCK_LIST))) {
      console.log(JSON.stringify({ path: "block", from }));
      message.setReject("Address not allowed");
      return;
    }

    if (matchSender(from, parseList(env.ALLOW_LIST))) {
      const { buildAllowHeaders } = await import("./headers");
      console.log(JSON.stringify({ path: "allow", from }));
      await message.forward(env.FORWARD_TO, buildAllowHeaders(threshold));
      return;
    }

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
      from,
      to: message.to,
      subject,
      text,
      env,
      scoreEmail: createScorer(env),
    });

    // Prefer single decide() that also handles allow/block to avoid duplication —
    // refactor so index only: parse → decide → reject|forward.
    if (decision.action === "reject") {
      message.setReject(decision.reason);
      return;
    }
    await message.forward(env.FORWARD_TO, decision.headers);
  },
};
```

**Refactor requirement:** keep allow/block **inside** `decide` only; `index.ts` should be parse + decide + act (~20 lines). Fix the sketch above accordingly when implementing.

- [ ] **Step 3: Complete E2E script**

Scenarios (fake message + mock scorer; no network):
1. Blocked sender → reject  
2. Allowlisted sender → forward headers score `-1.0`  
3. Unknown + score `8.5` → `X-Spam-Status` Yes  
4. Unknown + throwing scorer → forward + `X-Mailguard-Error`  
5. Domain `@example.com` vs `notexample.com` non-match  

Write log to `artifacts/e2e-YYYYMMDD-HHMMSS.log` and print summary. Exit non-zero on failure.

- [ ] **Step 4: Run E2E**

```bash
npm run e2e
```

Expected: all scenarios PASS; artifact file created under `artifacts/`.

- [ ] **Step 5: Commit**

```bash
git add src/decide.ts src/index.ts scripts/e2e.ts artifacts/.gitkeep
git commit -m "feat: wire email handler decision pipeline"
```

---

### Task 7: README + example config

**Files:**
- Create: `README.md`, `.dev.vars.example`
- Modify: `wrangler.jsonc` comments if useful

**Interfaces:** none (docs)

- [ ] **Step 1: Write README** covering
  - What it does (headers + allow/block + BYOK)
  - Config table matching the spec
  - `wrangler secret put LLM_API_KEY`
  - Optional `LLM_BASE_URL` for proxies/Janus
  - Email Routing: catch-all → Worker `cf-mailguard`
  - Verified destination required
  - Client rules on `X-Spam-Score` / `X-Spam-Status`
  - Cost notes (CF Free + BYOK)
  - `npm run e2e` and artifact path
  - Link to design spec

- [ ] **Step 2: `.dev.vars.example`**

```
LLM_API_KEY=sk-...
```

- [ ] **Step 3: Commit**

```bash
git add README.md .dev.vars.example
git commit -m "docs: add setup and configuration guide"
```

---

### Task 8: Spec status + push

**Files:**
- Modify: `docs/superpowers/specs/2026-10-29-mailguard-design.md` status → Approved
- Push: `origin/main` on `huangcheng/cf-mailguard`

- [ ] **Step 1: Mark spec Approved** (one-line status change)

- [ ] **Step 2: Final E2E run; note artifact path in commit body**

```bash
npm run e2e
git add docs/superpowers/specs/2026-10-29-mailguard-design.md artifacts/e2e-*.log
# Prefer gitignoring logs: instead reference path in commit message only
git commit -m "docs: mark mailguard design approved

Verified: npm run e2e → artifacts/e2e-<timestamp>.log"
git push origin main
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Email `email()` handler only | 1, 6 |
| BYOK Chat / Responses / Anthropic | 5 |
| `X-Spam-Score` / Status / Level + Mailguard extras | 3 |
| Allow/block env lists; block=`setReject` | 2, 6 |
| Fail-open + `X-Mailguard-Error` | 3, 6 |
| Cloudflare logs only | 6 |
| Config names + optional base URL | 1, 5, 7 |
| E2E + durable artifact | 6, 8 |
| No D1/R2/dashboard | Global / all tasks |

Review Focus items mapped to Task 2 (domain match), Task 3 (truncate), Task 5–6 (missing key / bad JSON / clamp).
