# Mailguard design

**Date:** 2026-10-29  
**Status:** Draft for review  
**Repo:** [`huangcheng/cf-mailguard`](https://github.com/huangcheng/cf-mailguard) (local folder: `~/Projects/mailguard`) — Cloudflare Email Worker for BYOK spam scoring

## Problem

Cloudflare Email Routing forwards inbound mail to a primary inbox but does not score spam. Open-source options either target a specific provider (e.g. Fastmail rules) or add more product surface than needed. Mailguard is a thin Email Worker: score with the operator’s own LLM keys, stamp standard spam headers, forward; optional allow/block lists via config.

## Goals

- Intercept mail via Cloudflare Email Routing → Worker `email()` handler.
- BYOK scoring: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages.
- Set SpamAssassin-compatible headers so the destination client/provider can filter.
- Allow list and block list as environment/config (no dashboard).
- Stay deployable on a single Cloudflare account (Workers Free is enough for light personal use; R2/D1 not required).
- Observability via Cloudflare Workers logs (no app-owned audit DB).

## Non-goals (v1)

- Quarantine store, Release UI, or in-app audit log.
- Dashboard, passkeys, multi-admin.
- Cloudflare Access / Zero Trust.
- Training or hosting a custom model.
- Cloudflare Email Sending to arbitrary recipients (forward only to a verified destination).

## Architecture

```
Internet → Email Routing → mailguard Worker.email()
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         block list      allow list      BYOK LLM score
         → setReject     → forward       → set X-Spam-*
                           (clean)         → forward
```

Single TypeScript Worker. No D1, R2, Durable Objects, or static UI assets in v1.

## Decision pipeline

1. Buffer `message.raw` once if body is needed for scoring; read envelope `from` / `to` and useful headers (`subject`, etc.).
2. **Block list** — if `message.from` or its domain matches → `message.setReject("Address not allowed")` and return.
3. **Allow list** — if match → `message.forward(FORWARD_TO, headers)` with clean spam headers (e.g. `X-Spam-Score: -1.0`, `X-Spam-Status: No, …`) and return (skip AI).
4. **BYOK score** — call configured provider/model with from, subject, and truncated plain-text body; receive a numeric score (and optional category/reasoning).
5. Map score → headers; `message.forward(FORWARD_TO, headers)`.
6. **On AI/config failure** — fail-open: forward with `X-Spam-Score: 0` (or unset Yes) and `X-Mailguard-Error` describing the failure so mail is not lost; log the error for Cloudflare logs.

List match rules: exact email (case-insensitive) or `@domain` / `domain` for whole-domain match. Envelope `message.from` is authoritative (not spoofable From header alone).

## Headers

Only `X-*` headers can be added on `forward()` ([Email handler docs](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)).

| Header | Purpose |
|--------|---------|
| `X-Spam-Score` | Float score (convention: ~0–2 clean, ~2–5 borderline, ≥5 often spam). See [X-Spam-Score](https://emailheaderanalyzer.com/blog/email-header-fields/x-spam-score). |
| `X-Spam-Status` | e.g. `Yes, score=7.2 required=5.0` or `No, score=0.8 required=5.0` |
| `X-Spam-Level` | One `*` per full score point (capped, e.g. at 10) |
| `X-Mailguard-Category` | Optional coarse label from the model |
| `X-Mailguard-Reasoning` | Optional short reason (keep short; header size limits) |
| `X-Mailguard-Error` | Set only on scoring failure (fail-open path) |

`required` in `X-Spam-Status` comes from config `SPAM_THRESHOLD` (default `5.0`). Score scale: model prompted to return **0.0–10.0** aligned with that convention (not a private 0–1 scale).

## Configuration

| Name | Kind | Description |
|------|------|-------------|
| `FORWARD_TO` | var | Verified Email Routing destination |
| `ALLOW_LIST` | var | Comma-separated emails / `@domain` |
| `BLOCK_LIST` | var | Comma-separated emails / `@domain` |
| `SPAM_THRESHOLD` | var | Default `5.0` for `X-Spam-Status` Yes/No |
| `LLM_PROVIDER` | var | `openai_chat` \| `openai_responses` \| `anthropic_messages` |
| `LLM_MODEL` | var | Model id for the chosen provider |
| `LLM_API_KEY` | secret | BYOK API key |
| `LLM_BASE_URL` | var (optional) | Override API base (proxies / compatible endpoints) |

No runtime UI; change lists and provider via wrangler / dashboard bindings and redeploy or var update as supported.

## BYOK providers

Abstract a small `scoreEmail(input) → { score, category?, reasoning? }` interface with three adapters:

1. OpenAI Chat Completions  
2. OpenAI Responses  
3. Anthropic Messages  

Shared JSON-oriented prompt: classify spam likelihood 0–10 with short category and reasoning. Truncate body (e.g. ~2–3k chars) to control cost and Worker time.

## Error handling and invariants

- Handler always **rejects**, or **forwards** (never returns without one of those on the success path).
- `message.raw` is single-use; buffer before parse.
- Destination must be a verified Email Routing address.
- Fail-open on LLM errors (forward + error header + `console` log).
- Block list uses permanent SMTP reject via `setReject`.

## Observability

Rely on **Cloudflare Workers logs** (`console.log` of from, verdict path, score, errors). No application database for mail history.

## Testing

- E2E is the primary proof: fixture `.eml` paths (allow → forward+clean headers, block → reject, unknown → mocked LLM → spam headers) exercised through the Worker entrypoint.
- Manual after deploy: allowlisted, blocklisted, and unknown mail; confirm headers in the destination client and Cloudflare Workers logs.
- Every E2E run leaves a durable artifact (script + log) under `artifacts/` for reruns.

## Install sketch (OSS)

1. Clone; install deps; set `FORWARD_TO`, lists, `LLM_*`.  
2. `wrangler secret put LLM_API_KEY`.  
3. Deploy Worker; point Email Routing rule (e.g. catch-all) at the Worker.  
4. Create client-side rules on `X-Spam-Score` / `X-Spam-Status` as desired.  
5. README notes: Workers Free usually enough; LLM cost is BYOK; verified destination required.

## Cost (indicative)

- Cloudflare: typically **$0** on Workers Free for personal volume (Email Routing inbound unlimited; forward to verified destination free).  
- LLM: pay the provider per scored message; allow/block skips AI.

## References

- [Email handler API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)  
- [X-Spam-Score](https://emailheaderanalyzer.com/blog/email-header-fields/x-spam-score)  
- Inspiration: [willhackett/email-filtering](https://github.com/willhackett/email-filtering) (tag + forward; Mailguard adds standard X-Spam-* + allow/block reject + multi-provider BYOK)
