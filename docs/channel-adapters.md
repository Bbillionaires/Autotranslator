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

## Android SMS gateway (Phase 8 — fully implemented, server side)

Unlike every other channel in this doc, there is no cloud SMS vendor here (no Twilio,
Telnyx, or Vonage) — **the Android device itself, using its own physical SIM, is the
channel.** The device runs a companion app (see `android-gateway/README.md` for the full
client-side build specification: permissions, foreground service, battery-optimization
guidance, and the on-device `SmsManager`/`BroadcastReceiver` workflow) that talks to the six
Route Handlers documented below. This section is the **API contract** that companion app
integrates against — it doubles as "a separate detailed build specification for the Android
client" per the product brief, alongside `android-gateway/README.md`.

### Inverted control flow (read this first)

Every other adapter in this app calls OUT to an external API (Telegram's Bot API, Meta's
Graph API). The Android gateway is the opposite: **we never call out to the device.** The
device calls IN to us, on its own schedule:

1. It registers once (an admin does this from the dashboard) and receives a signed token.
2. It polls `GET /api/gateways/messages/pending` periodically for outbound SMS to send.
3. It calls `POST /api/gateways/messages/:id/acknowledge` (or `/fail`) after actually trying
   to send via Android's `SmsManager`.
4. Whenever it receives an SMS itself, it pushes it to us via `POST /api/gateways/inbound`.

A message is never marked `SENT` until the device explicitly confirms it — never
optimistically. A message queued while the device is offline (no recent heartbeat) simply
accumulates as `QUEUED` and is returned the next time the device polls; there is no separate
"offline" state to manage.

### 1. Generate the signing secret

```bash
openssl rand -hex 32
```

Set the result as `ANDROID_GATEWAY_SIGNING_SECRET` and `ANDROID_GATEWAY_ENABLED="true"`,
then restart the app so `registerChannelAdapters()` picks up `AndroidSmsAdapter`
(`src/server/channels/index.ts`). This secret signs every device's token — treat it like any
other production credential (never commit it, rotate it if it leaks, and note that rotating
it invalidates **every** currently-issued device token, unlike revoking a single device).

### 2. Register a device (admin action, from the dashboard/API)

An Administrator+ calls `POST /api/gateways/register` (session-authenticated — the device
itself has no token yet, this step is what issues one). The response's `deviceToken` is
shown **exactly once** — copy it into the device immediately (see
`android-gateway/README.md` for how the app should store it, Android Keystore recommended).
There is no "show me the token again" recovery path by design: only its sha256 hash is ever
persisted (`ChannelAccount.deviceTokenHash`), so even a full database leak never leaks a
live, usable credential.

### 3. Install/configure the companion app

Physically install the Android app on the device that owns the SIM you want to relay SMS
through, and configure it with: the server's base URL, and the `deviceToken` from step 2.
See `android-gateway/README.md` for the full client-side requirements (permissions,
foreground service, battery optimization, retry behavior, privacy disclosure).

### 4. Revoking a device

An admin revokes a device by setting `ChannelAccount.revokedAt` (`channelAccountRepository.revokeDevice`).
Every subsequent request from that device's token is rejected with a bare `401` immediately —
no need to rotate `ANDROID_GATEWAY_SIGNING_SECRET`, which would invalidate every other
device's token too. There is currently no dedicated Server Action/UI button for this (a
documented gap, see "Known limitations" below) — it's reachable today via
`channelAccountRepository.revokeDevice(organizationId, channelAccountId)` or direct DB
access; wiring a Settings UI button is a natural, low-risk follow-up.

### API contract — authentication

Every gateway route except `POST /api/gateways/register` is **device-token authenticated**,
never session/cookie authenticated:

```
Authorization: Bearer <deviceId>.<hex-hmac-signature>
```

The token is `${deviceId}.${HMAC-SHA256(deviceId, ANDROID_GATEWAY_SIGNING_SECRET)}` (hex),
issued once at registration (`src/server/gateways/androidAuth.ts`). On every request the
server: (1) verifies the HMAC signature over the embedded `deviceId` (constant-time
comparison), (2) loads that `ChannelAccount`, checking it's `ANDROID_SMS`, not revoked, and
that its stored `deviceTokenHash` matches this token's hash. **Any** failure — missing
header, malformed token, bad signature, unknown device, revoked device — collapses to the
exact same response:

```
401 { "error": "unauthorized" }
```

with no further detail (deliberately: a caller probing for validity can't distinguish *why*
a request was rejected). All six routes are also rate-limited
(`src/server/rateLimit.ts` — 60 req/min per device for the five device-token routes, 10
req/min per admin user for `/register`); exceeding the limit returns:

```
429 { "error": "Too many requests." }
```

### API contract — the six endpoints

#### `POST /api/gateways/register`

Session+Role(Administrator+). Registers a new device and issues its token.

Request:

```json
{ "deviceName": "Front desk Pixel", "phoneNumber": "+15551234567" }
```

Response `201`:

```json
{
  "deviceId": "cm...",
  "deviceToken": "cm....<hex signature>",
  "message": "Store this token securely on the device now — it will not be shown again."
}
```

Errors: `400` malformed body, `403` insufficient role, `409` a device is already registered
for this phone number in this org.

#### `POST /api/gateways/heartbeat`

Device-token authenticated. No body required. Updates `ChannelAccount.lastHeartbeatAt` (and
flips a non-revoked device's `status` to `ACTIVE`).

Response `200`:

```json
{ "ok": true, "serverTime": "2026-07-26T12:00:00.000Z" }
```

Call this periodically (e.g. every 1–5 minutes) so `AndroidSmsAdapter.getDeviceHealth`/
`healthCheck()` can report accurate liveness.

#### `POST /api/gateways/inbound`

Device-token authenticated. Called whenever the device's `BroadcastReceiver` observes a new
incoming SMS.

Request:

```json
{
  "from": "+15559998888",
  "text": "Hola, cuando abre la tienda?",
  "sentAt": "2026-07-26T11:58:00.000Z",
  "externalMessageId": "device-generated-dedup-ref"
}
```

- `externalMessageId`: the device's own dedup reference (e.g. derived from the SMS
  timestamp + sender on-device) — combined server-side with the device's own
  `ChannelAccount.id` to form the idempotency key, so replaying the same inbound SMS (e.g.
  after a network retry) never creates a second `Message` row.

Response `200`:

```json
{ "ok": true, "messageId": "cm...", "duplicate": false }
```

`duplicate: true` means this exact `(device, externalMessageId)` pair was already processed
— not an error, just informational.

#### `GET /api/gateways/messages/pending`

Device-token authenticated. Optional `?limit=` (1–100, default 50).

Response `200`:

```json
{
  "messages": [
    { "id": "cm...", "to": "+15559998888", "text": "Abrimos a las 9am", "createdAt": "2026-07-26T12:00:05.000Z" }
  ]
}
```

Only `QUEUED` messages belonging to conversations under **this specific device's**
`ChannelAccount` are ever returned — never another organization's, never another device's
within the same organization. Oldest-first. Poll this on an interval (e.g. every 15–60
seconds) and, for each entry, call Android's `SmsManager.sendTextMessage(to, null, text,
...)` before acknowledging.

#### `POST /api/gateways/messages/:id/acknowledge`

Device-token authenticated. `:id` is the `Message.id` from the `pending` response above
(**not** any id returned by `SmsManager` itself).

Request (all fields optional):

```json
{ "externalMessageId": "android-sms-manager-sent-intent-ref" }
```

Response `200`:

```json
{ "ok": true, "status": "SENT" }
```

**Idempotent**: acknowledging the same `:id` twice (e.g. after a network retry on the
device's side) never errors and never double-transitions — the second call is a no-op that
returns the same `"SENT"` status. Errors: `401` unauthorized, `404` if `:id` doesn't belong
to this device (including "exists, but is another device's message").

#### `POST /api/gateways/messages/:id/fail`

Device-token authenticated. `:id` is the `Message.id` from the `pending` response.

Request:

```json
{ "reason": "NO_SIGNAL" }
```

`reason` is one of `NO_SIGNAL` | `INVALID_NUMBER` | `SIM_ERROR` | `UNKNOWN`.
`NO_SIGNAL`/`SIM_ERROR`/`UNKNOWN` are transient — the server automatically schedules a retry
(exponential backoff, same policy as every other channel, capped at 5 attempts before
`DEAD_LETTER`). `INVALID_NUMBER` is permanent — the message goes straight to `FAILED` with
no automatic retry (a human can still trigger a manual retry from the inbox).

Response `200`:

```json
{ "ok": true, "status": "FAILED", "outcome": "FAILED" }
```

### Known limitations (documented, not hidden)

- **No dedicated revoke Server Action/UI button yet.** `channelAccountRepository.revokeDevice`
  exists and is fully wired into `authenticateDevice`'s check, but nothing in the Settings UI
  calls it yet — a natural, low-risk Phase-10-or-later follow-up (list registered devices,
  show last-heartbeat/health, add a "Revoke" button).
- **Deterministic, non-rotatable per-device token.** The token is `HMAC(deviceId, secret)` —
  the same deviceId always signs to the same token given the same secret. This is
  intentional (per the plan's §6.3 design: revocation is via `revokedAt`, not token
  rotation), but it does mean there's no way to "reissue a fresh token for the same device"
  without changing what `deviceId` means — re-registering as a new device (new
  `ChannelAccount`, new phone-number slot) is the supported path if a token needs replacing.
- **Loose phone-number normalization.** `normalizePhoneNumber` (`src/server/channels/androidSms/parse.ts`)
  strips common formatting characters but does no E.164 validation or country-code
  inference — two devices reporting the same number with meaningfully different formatting
  (e.g. missing a country code) could resolve to two different `Contact`s. Acceptable for
  MVP, same spirit as the glossary module's "loose BCP-47 validator, not exhaustive".
- **No delivery read receipts.** Once a device acknowledges a send (`SENT`), there's no
  further signal (Android has no standard "the recipient read this SMS" API) — `SENT` is
  this channel's terminal *tracked* status, same precedent as Telegram's `getDeliveryStatus`
  always returning `null`.

## WhatsApp Business Cloud API (Phase 9 — not yet implemented)

Placeholder — Phase 9 will document: creating a Meta Business Manager account and App,
adding the WhatsApp product, obtaining `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/
`WHATSAPP_BUSINESS_ACCOUNT_ID`/`WHATSAPP_APP_SECRET`, choosing `WHATSAPP_VERIFY_TOKEN`, the
GET-verify webhook handshake, and Business Verification/App Review requirements for
production traffic.
