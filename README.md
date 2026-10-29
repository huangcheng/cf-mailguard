# cf-mailguard

Cloudflare Email Worker that scores inbound mail with your own LLM API keys (BYOK), stamps SpamAssassin-style headers, and forwards to a verified destination. Allow and block lists skip or reject mail before any AI call.

Self-host on your Cloudflare account — no hosted SaaS, no shared keys.

## What it does

1. **Block list** — matching senders get an SMTP reject (`Address not allowed`).
2. **Allow list** — matching senders are forwarded immediately with clean spam headers (`X-Spam-Score: -1.0`, no LLM call).
3. **BYOK scoring** — everyone else is classified by your configured OpenAI- or Anthropic-compatible model. The Worker adds `X-Spam-Score`, `X-Spam-Status`, `X-Spam-Level`, plus optional `X-Mailguard-Category` and `X-Mailguard-Reasoning` from the model JSON, then forwards.
4. **Fail-open** — if scoring fails, mail still forwards with `X-Mailguard-Error` so nothing is dropped on AI errors.

Envelope `message.from` (not the display From header alone) drives list matching.

Scored mail is always forwarded. `SPAM_THRESHOLD` only drives `X-Spam-Status` Yes/No for downstream filters — it does not reject. Use `BLOCK_LIST` to drop senders at SMTP time.

## Configuration

| Name | Kind | Description |
|------|------|-------------|
| `FORWARD_TO` | var | Verified Email Routing destination address |
| `ALLOW_LIST` | var | Comma-separated emails and/or `@domain` entries |
| `BLOCK_LIST` | var | Comma-separated emails and/or `@domain` entries |
| `SPAM_THRESHOLD` | var | Default `5.0`; used in `X-Spam-Status` Yes/No |
| `LLM_PROVIDER` | var | `openai_chat`, `openai_responses`, or `anthropic_messages` |
| `LLM_MODEL` | var | Model id for the chosen provider |
| `LLM_API_KEY` | secret | BYOK API key (never commit; see below) |
| `LLM_BASE_URL` | var (optional) | Override API base URL (proxies or OpenAI-compatible gateways) |

Set non-secret values in [`wrangler.jsonc`](wrangler.jsonc) `vars` (or the Cloudflare dashboard). Redeploy or update vars after changes. Keep real destinations, keys, and custom base URLs out of git — use dashboard vars, `wrangler secret`, or a local `.dev.vars` file.

### API key (secret)

Production:

```bash
npx wrangler secret put LLM_API_KEY
```

Local dev: copy [`.dev.vars.example`](.dev.vars.example) to `.dev.vars` (gitignored) and fill in your key.

### Optional `LLM_BASE_URL`

Leave empty to use each provider’s default endpoint. Set when routing through a proxy or OpenAI-compatible gateway.

| `LLM_PROVIDER` | Expected `LLM_BASE_URL` shape | Default |
|----------------|------------------------------|---------|
| `openai_chat` / `openai_responses` | Include `/v1` | `https://api.openai.com/v1` |
| `anthropic_messages` | **Do not** include `/v1` (adapter appends `/v1/messages`; a trailing `/v1` is stripped if present) | `https://api.anthropic.com` |

## Setup

1. Clone the repo and install dependencies: `npm install`.
2. Edit `wrangler.jsonc`: set `FORWARD_TO` to an address you have **verified** under Cloudflare Email Routing, and configure lists, threshold, `LLM_PROVIDER`, and `LLM_MODEL`.
3. Store `LLM_API_KEY` via `wrangler secret put` (and/or `.dev.vars` for local runs).
4. Deploy: `npm run deploy`.
5. In **Email Routing** for your domain, add a rule (e.g. catch-all `*@yourdomain.com`) with action **Send to a Worker** and select **`cf-mailguard`** (or your deployed worker name).
6. In your mail client or provider, create filters on **`X-Spam-Score`** and/or **`X-Spam-Status`** (e.g. file or junk when `X-Spam-Status` contains `Yes` or score ≥ 5).

`FORWARD_TO` must be a destination Cloudflare has verified for Email Routing; unverified addresses will not receive forwarded mail.

## Testing

```bash
npm run e2e
```

Runs fixture-based checks against the decision pipeline and handler (mocked LLM, no network). Each run writes a timestamped log under **`artifacts/e2e-YYYYMMDD-HHMMSS.log`**.

## Cost

- **Cloudflare** — Workers Free is usually enough for light personal volume; Email Routing inbound and forward to a verified destination are typically $0 on Free.
- **LLM** — you pay your provider per scored message; allow-list and block-list paths do not call the model.

## Design

Full architecture, header semantics, and provider details: [Mailguard design spec](docs/superpowers/specs/2026-10-29-mailguard-design.md).

## License

[MIT](LICENSE.md)
