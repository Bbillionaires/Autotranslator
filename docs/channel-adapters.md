# Channel adapters — setup guide

This document covers per-channel setup (creating credentials, configuring webhooks, local
dev vs. production) for each `MessagingChannelAdapter` (see
[`docs/implementation-plan.md`](./implementation-plan.md) §3.2 for the interface and
architecture). It is referenced from the [README](../README.md#channel-adapters).

## Telegram (Phase 6 — fully implemented)

### 1. Create a bot with @BotFather

1. Open a chat with [`@BotFather`](https://t.me/BotFather) on Telegram.
2. Send `/newbot`, choose a name and a unique `@username` (must end in `bot`).
3. BotFather replies with a bot token that looks like `123456789:AAExampleTokenNotReal`.
   Put this in `TELEGRAM_BOT_TOKEN`.

### 2. Choose a webhook secret

Generate a random string (e.g. `openssl rand -hex 32`) and set it as
`TELEGRAM_WEBHOOK_SECRET`. This value is compared against the
`X-Telegram-Bot-Api-Secret-Token` header Telegram sends on every webhook delivery
(`TelegramAdapter.validateWebhook`, constant-time comparison) — it must match exactly what
you register with `setWebhook` in step 4.

### 3. Set the remaining env vars and enable the adapter

```bash
TELEGRAM_ENABLED="true"
TELEGRAM_BOT_TOKEN="123456789:AAExampleTokenNotReal"
TELEGRAM_WEBHOOK_SECRET="the-random-secret-from-step-2"
```

Restart the app (`npm run dev` / redeploy) so `registerChannelAdapters()` picks up the new
`TelegramAdapter` registration (see `src/server/channels/index.ts`).

### 4. Local development — exposing your dev server to Telegram

Telegram's Bot API only delivers webhooks to a public HTTPS URL — `localhost` isn't
reachable from Telegram's servers, so local development needs a secure tunnel. Either of
the following works; pick one:

**ngrok**

```bash
ngrok http 3000
```

Copy the printed `https://<random>.ngrok-free.app` URL — that's your tunnel's public base
URL for step 5 below (append `/api/channels/telegram/webhook`).

**cloudflared** (Cloudflare Tunnel, no account required for a quick tunnel)

```bash
cloudflared tunnel --url http://localhost:3000
```

Copy the printed `https://<random>.trycloudflare.com` URL the same way.

Either way, also set `APP_URL` to that tunnel URL for the duration of the session (the
Settings UI's "webhook URL" helper and the `getTelegramWebhookConfig`/`registerTelegramWebhook`
Server Actions derive the webhook URL from `APP_URL`).

### 5. Register the webhook with Telegram

Two options, both set the exact same thing (a URL + the secret token from step 2):

- **From the app**: sign in as an Administrator, open **Settings → Telegram**, and click
  **"Register webhook now"**. This calls `setWebhook` on your behalf using
  `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`/`APP_URL`, and creates the `ChannelAccount`
  row this org needs (see the "known limitations" note below).
- **Manually**, via `curl`:

  ```bash
  curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"${APP_URL}/api/channels/telegram/webhook\", \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\"}"
  ```

Verify with `https://api.telegram.org/bot<token>/getWebhookInfo` — `url` should match, and
`last_error_message` should be empty once you've sent the bot a message.

### 6. Production setup

- Point `APP_URL` at your real custom domain (e.g. `https://app.example.com`) — it must be
  HTTPS; Telegram refuses non-HTTPS webhook URLs.
- Re-run step 5 ("Register webhook now" or the `curl` command) against the production
  `APP_URL` — Telegram webhooks are per-bot-token, not per-environment, so switching from a
  dev tunnel to production means re-registering against the new URL.
- Rotate `TELEGRAM_WEBHOOK_SECRET` if the dev tunnel's value was ever shared/committed
  anywhere; re-register after rotating (the old secret stops validating immediately).

### Bot commands

The bot intercepts four commands before any translation/storage happens (never stored as
ordinary chat messages — see `src/app/api/channels/telegram/webhook/route.ts`):

| Command     | Behavior                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `/start`    | Greets the user; creates/matches their `Contact` record.                 |
| `/language` | Shows an inline-keyboard language picker; selecting one sets `Contact.preferredLanguage`. |
| `/help`     | Lists the available commands.                                            |
| `/privacy`  | A placeholder privacy blurb (a full privacy policy is a later-phase docs deliverable). |

### Known limitations (documented, not hidden)

- **One global bot token per deployment.** `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`
  are single, deployment-wide env vars (not per-organization credentials), so the webhook
  route resolves which organization a delivery belongs to via "the first `ACTIVE`
  `ChannelAccount` of type TELEGRAM" (`channelAccountRepository.findFirstActiveByChannelType`)
  rather than a true per-org bot-token lookup. This matches the MVP's `ChannelAccount.credentialRef`
  design (§6.6 of the implementation plan: real per-org secret storage/encryption is a
  documented production plan, not built in this MVP). Multiple organizations each running
  their own Telegram bot is a **post-MVP gap** — the fix is per-org credential storage plus
  either per-org webhook paths (e.g. `/api/channels/telegram/webhook/[channelAccountId]`) or
  looking up the bot id via `getMe` per request and matching `ChannelAccount.externalAccountId`.
- **No delivery receipts.** Telegram has no polling delivery-status API for regular bot
  messages, and this MVP wires no separate read-receipt webhook — `TelegramAdapter.getDeliveryStatus`
  always returns `null`. A sent message's terminal *tracked* status is `SENT`
  (`outboundService`'s definition of "delivered to Telegram, not necessarily read").

---

## Android SMS gateway (Phase 8 — not yet implemented)

Placeholder — Phase 8 will document: installing/registering the companion Android app,
`ANDROID_GATEWAY_SIGNING_SECRET` generation, the device registration/heartbeat/inbound/
acknowledge/fail API contract (`/api/gateways/*`), and device revocation.

## WhatsApp Business Cloud API (Phase 9 — not yet implemented)

Placeholder — Phase 9 will document: creating a Meta Business Manager account and App,
adding the WhatsApp product, obtaining `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/
`WHATSAPP_BUSINESS_ACCOUNT_ID`/`WHATSAPP_APP_SECRET`, choosing `WHATSAPP_VERIFY_TOKEN`, the
GET-verify webhook handshake, and Business Verification/App Review requirements for
production traffic.
