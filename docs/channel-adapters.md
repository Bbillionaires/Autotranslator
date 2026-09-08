# Channel adapters — setup guide

This document covers per-channel setup (creating credentials, configuring webhooks, local
dev vs. production) for each `MessagingChannelAdapter` (see
[`docs/implementation-plan.md`](./implementation-plan.md) §3.2 for the interface and
architecture). It is referenced from the [README](../README.md#channel-adapters).

## Per-organization credential encryption

Telegram and WhatsApp credentials are stored per-organization, encrypted at rest, on
`ChannelAccount.encryptedCredentials` — never as global deployment-wide env vars, and never
as plaintext in the database.

- **Algorithm**: AES-256-GCM (`src/server/crypto/credentialEncryption.ts`), keyed from
  `CREDENTIAL_ENCRYPTION_KEY` (32 bytes, hex-encoded — 64 hex characters). Generate one for
  local dev with `openssl rand -hex 32`. GCM is authenticated: a tampered ciphertext/IV/auth
  tag is rejected loudly (decryption throws) rather than silently returning corrupted
  plaintext.
- **On-disk shape**: `{ iv, authTag, ciphertext }`, each a base64 string, stored as the JSON
  value of `ChannelAccount.encryptedCredentials`. A fresh random IV is generated on every
  encrypt call.
- **What's encrypted**: Telegram stores `{ botToken, webhookSecret }`
  (`src/server/channels/telegram/credentials.ts`); WhatsApp stores `{ accessToken,
  phoneNumberId, businessAccountId, appSecret, verifyToken }`
  (`src/server/channels/whatsapp/credentials.ts`).
- **When it's required**: `CREDENTIAL_ENCRYPTION_KEY` is required (env.ts's conditional-
  requirement validation) whenever `TELEGRAM_ENABLED`, `WHATSAPP_ENABLED`, or
  `ANDROID_GATEWAY_ENABLED` is `true` — never required with every channel flag left
  false/unset, preserving the zero-credential-boot guarantee. The Android SMS gateway itself
  doesn't need this key to function (its device-token mechanism is a one-way sha256 hash,
  never a decryptable secret — see that section below) but is included in the requirement
  for consistency, since a deployment enabling any one of the three channels should have
  this key available regardless.
- **Key rotation — not implemented, a known limitation.** There is no key-versioning scheme:
  rotating `CREDENTIAL_ENCRYPTION_KEY` would make every previously-encrypted
  `ChannelAccount` row undecryptable. A real rotation story would need either a key id
  stored alongside each blob (so old ciphertext stays decryptable with its original key
  while new writes use the current one) or a one-time re-encrypt-everything migration run
  at rotation time. Flagged here, not built.
- **Never commit a real `CREDENTIAL_ENCRYPTION_KEY` value** — it's a local-dev/deployment
  secret like any other, generated once per environment via `openssl rand -hex 32`.

## Telegram (Phase 6 — fully implemented; per-organization credentials since the Builder's
multi-tenant rewrite)

Each organization on a deployment connects its OWN Telegram bot — there is no more single,
deployment-wide `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`. `TELEGRAM_ENABLED` remains a
global feature flag (an operator sets it once, requires a restart); once it's on, ANY
organization's own Administrator can connect their own bot from the app itself — no env var
edits, no restart, no operator involvement per organization.

### 1. An operator enables the feature flag once

```bash
TELEGRAM_ENABLED="true"
CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -hex 32)"   # required whenever TELEGRAM_ENABLED,
                                                        # WHATSAPP_ENABLED, or
                                                        # ANDROID_GATEWAY_ENABLED is true —
                                                        # see "Per-organization credential
                                                        # encryption" below.
```

Restart the app (`npm run dev` / redeploy) so `registerChannelAdapters()` picks up the
`TelegramAdapter` registration (see `src/server/channels/index.ts`) and `env.ts` accepts
`CREDENTIAL_ENCRYPTION_KEY`.

### 2. Each organization creates its own bot with @BotFather

1. Open a chat with [`@BotFather`](https://t.me/BotFather) on Telegram.
2. Send `/newbot`, choose a name and a unique `@username` (must end in `bot`).
3. BotFather replies with a bot token that looks like `123456789:AAExampleTokenNotReal`.

### 3. Connect the bot from Settings — no manual `setWebhook` call needed

Sign in as that organization's Administrator, open **Settings → Telegram**, paste the bot
token from step 2 into the form, and click **"Connect bot"**
(`registerTelegramWebhook` Server Action, `src/server/actions/telegram.ts`). This:

1. Calls Telegram's `getMe` with the pasted token to validate it and resolve the bot's own
   numeric id/username (`ChannelAccount.externalAccountId`/`displayName`).
2. Generates a fresh, random, per-organization webhook secret.
3. Encrypts `{ botToken, webhookSecret }` (AES-256-GCM — see "Per-organization credential
   encryption" below) and creates/updates this organization's `ChannelAccount`.
4. Calls Telegram's `setWebhook` itself, pointing at this organization's OWN webhook path:
   `${APP_URL}/api/channels/telegram/webhook/{channelAccountId}`, with the generated
   webhook secret as the `secret_token`.

No manual `curl`/`setWebhook` step is needed — unlike the old global-bot-token design, this
is now a genuinely self-service, in-app flow for every organization, not just the first one
on the deployment.

### 4. Local development — exposing your dev server to Telegram

Telegram's Bot API only delivers webhooks to a public HTTPS URL — `localhost` isn't
reachable from Telegram's servers, so local development needs a secure tunnel. Either of
the following works; pick one:

**ngrok**

```bash
ngrok http 3000
```

Copy the printed `https://<random>.ngrok-free.app` URL — that's your tunnel's public base
URL.

**cloudflared** (Cloudflare Tunnel, no account required for a quick tunnel)

```bash
cloudflared tunnel --url http://localhost:3000
```

Copy the printed `https://<random>.trycloudflare.com` URL the same way.

Either way, also set `APP_URL` to that tunnel URL for the duration of the session BEFORE
clicking "Connect bot" (the webhook URL Telegram registers is derived from `APP_URL` at
connect time — reconnecting after `APP_URL` changes re-registers against the new URL, see
step 5).

### 5. Production setup

- Point `APP_URL` at your real custom domain (e.g. `https://app.example.com`) — it must be
  HTTPS; Telegram refuses non-HTTPS webhook URLs.
- Each organization re-clicks "Connect bot" (re-pasting the same bot token is fine — this
  hits the update path, not create, and just re-registers `setWebhook` against the new
  `APP_URL`) once the app is live at its production URL.
- If a bot token was ever shared/committed anywhere, rotate it in @BotFather
  (`/revoke` then `/token`, or `/newbot` for a fresh bot entirely) and reconnect with the
  new token from Settings.

### Multi-organization isolation

Two different organizations can each connect their own distinct bot — each gets its own
`ChannelAccount`, its own encrypted credentials, and its own webhook path
(`/api/channels/telegram/webhook/{channelAccountId}`), so inbound deliveries are routed
purely by which URL Telegram calls, never by "whichever org was created first" (the old
single-global-bot-token design's C1 leak — see below). The one remaining restriction is at
the bot level, not the organization level: `ChannelAccount` has a database-level unique
constraint on `(channelType, externalAccountId)`, so the SAME bot (the same Telegram bot id)
can never be connected to two different organizations at once — pasting a bot token another
org already has connected is rejected with a clear conflict error before any webhook is
touched.

### Bot commands

The bot intercepts four commands before any translation/storage happens (never stored as
ordinary chat messages — see
`src/app/api/channels/telegram/webhook/[channelAccountId]/route.ts`):

| Command     | Behavior                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `/start`    | Greets the user; creates/matches their `Contact` record.                 |
| `/language` | Shows an inline-keyboard language picker; selecting one sets `Contact.preferredLanguage`. |
| `/help`     | Lists the available commands.                                            |
| `/privacy`  | A placeholder privacy blurb (a full privacy policy is a later-phase docs deliverable). |

### Known limitations (documented, not hidden)

- **~~One global bot token per deployment~~ — FIXED. Each organization now has genuinely
  distinct credentials and a genuinely distinct webhook path.** An earlier version of this
  MVP shared one global `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET` across every
  organization on the deployment, resolving which org an inbound delivery belonged to via
  "the sole `ACTIVE` `ChannelAccount` of type TELEGRAM across the whole deployment" — a
  design that could only ever support one organization's Telegram bot at a time, and which
  an earlier bug (C1) let a second org silently claim anyway, leaking the first org's
  Telegram traffic into the second org's inbox. That entire class of problem is now
  structurally impossible: bot credentials are encrypted per-`ChannelAccount`, the webhook
  URL itself (`/api/channels/telegram/webhook/{channelAccountId}`) names which organization
  and which credentials a delivery is checked against, and there is no "resolve by scanning
  for the sole active row" step left to get wrong. The one remaining restriction is
  DB-enforced at the bot-id level, not the deployment level: the SAME bot (matched by its
  Telegram bot id, `ChannelAccount.externalAccountId`) can never be connected — active or
  not — to two different organizations at once (`@@unique([channelType, externalAccountId])`
  in `prisma/schema.prisma`), which is the real, narrower invariant that actually matters
  (see "Multi-organization isolation" above). See `src/server/actions/telegram.test.ts` and
  `src/app/api/channels/telegram/webhook/[channelAccountId]/route.test.ts` for the tests
  proving both the same-bot-id conflict and genuine cross-org webhook isolation.
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
device's token too. Reachable via Settings → Channel integrations → Android SMS gateway's
"Revoke" button (`revokeAndroidDevice` Server Action, Session+Role(Administrator+),
audit-logged), or directly via `channelAccountRepository.revokeDevice(organizationId,
channelAccountId)`.

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

- ~~No dedicated revoke Server Action/UI button yet.~~ **Fixed (H6/M5, docs/review-report.md):**
  `revokeAndroidDevice` (`src/server/actions/android.ts`, Session+Role(Administrator+),
  audit-logged) wraps `channelAccountRepository.revokeDevice`, and Settings → Channel
  integrations → Android SMS gateway (`src/app/(app)/settings/android-section.tsx`) now
  shows the device list (health/heartbeat status), a register form (device token shown
  once), and a "Revoke" button per device — no more direct-DB-only path.
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

## WhatsApp Business Cloud API (Phase 9 — fully implemented; per-organization credentials
since the Builder's multi-tenant rewrite)

The official WhatsApp Business **Cloud API** (Meta's own hosted Graph API product) — never
an unofficial browser-automation/session-hijacking approach. `WHATSAPP_ENABLED` defaults to
`false`; with it unset or `false`, the adapter is never constructed/registered
(`src/server/channels/index.ts`) and both webhook routes are inert (`404`), and
`GET /api/channels/whatsapp/health` returns `{ enabled: false, healthy: false, ... }` with a
`200` (never an error) rather than throwing.

There is no more single, deployment-wide `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/
`WHATSAPP_BUSINESS_ACCOUNT_ID`/`WHATSAPP_VERIFY_TOKEN`/`WHATSAPP_APP_SECRET`. Each
organization now connects its OWN WhatsApp Business phone number from **Settings →
WhatsApp Business** — no env var edits, no restart, no operator involvement per
organization (only the one-time `WHATSAPP_ENABLED`/`CREDENTIAL_ENCRYPTION_KEY` feature-flag
setup below is an operator's job).

**Everything below this point (steps 1–2) is external, human, Meta-side setup.** None of it
can be performed by this application's code — there is no API this codebase can call on
your behalf to create a Meta Business account, add the WhatsApp product to an App, or get a
production number verified. You (a human, in the Meta dashboards) must do every step; the
resulting five credential values are then pasted into the in-app connect form (step 3),
not into env vars.

### 1. Create a Meta Business Manager account and App

1. Go to [business.facebook.com](https://business.facebook.com) and create (or reuse) a
   **Meta Business Manager** account for your organization.
2. In [developers.facebook.com](https://developers.facebook.com), create a new **App**
   (type: "Business"), associated with that Business Manager account.
3. In the App dashboard, add the **WhatsApp** product. Meta automatically provisions a
   **test phone number** and a **test WhatsApp Business Account (WABA)** you can send/receive
   messages with immediately, at no cost, to up to 5 pre-verified recipient numbers — this
   is enough to develop and test this entire adapter end-to-end without any further
   verification step.

### 2. App Review / Business Verification (required for production traffic)

The test number above is permanently limited to 5 recipient phone numbers you manually add
and verify in the dashboard, and to Meta's own test templates. To send messages to
*arbitrary* real customers in production, Meta requires:

- **Business Verification** — proving the Business Manager account represents a real,
  legitimate business (business documents, a matching domain, etc.). This can take anywhere
  from under a day to several weeks depending on Meta's review queue and how complete your
  submission is.
- **App Review** for the specific WhatsApp permissions this integration uses
  (`whatsapp_business_messaging`, `whatsapp_business_management`), which requires a screen
  recording/demo of the actual use case.
- A **production phone number** added to the WABA (a real number you own or a virtual
  number purchased through a Meta-supported provider), which itself requires phone-number
  verification (an SMS/voice code sent by Meta).

None of this is a code change — it is entirely dashboard/paperwork on Meta's side. Budget
real calendar time for it before committing to a production launch date.

### 3. Obtain the five credential values and connect from Settings

From the App dashboard, under WhatsApp → API Setup (or WhatsApp → Configuration once past
the test-number stage), collect:

- **Phone number id** — the numeric id of the specific WhatsApp phone number (test or
  production) you're sending from. This is what `WhatsAppAdapter` puts in the Graph API URL
  (`https://graph.facebook.com/v21.0/<phoneNumberId>/messages`) and, once connected, becomes
  `ChannelAccount.externalAccountId` — the value the DB-level uniqueness guarantee (see
  "Multi-organization isolation" below) keys on.
- **Business account id** — the WABA id itself (one level up from the phone number; a WABA
  can own multiple phone numbers). Not currently used by any Graph API call this adapter
  makes, but recorded for completeness and future use (e.g. querying/managing message
  templates via the WABA-level endpoints).
- **Access token** — a token authorizing calls against the above. For development, the
  dashboard's "Temporary access token" (valid ~24h) is enough to exercise everything in this
  guide; for anything longer-lived, generate a **System User** access token (Business
  Settings → System Users) scoped to the `whatsapp_business_messaging`/
  `whatsapp_business_management` permissions — System User tokens don't expire on a fixed
  clock the way a personal access token does, and aren't tied to a human's Meta login
  session.
- **App secret** — the App's secret, found under App Settings → Basic. This becomes the
  HMAC key `verifyWhatsAppSignature` uses to verify `X-Hub-Signature-256` on every inbound
  webhook delivery to THIS organization's own webhook path.
- **Verify token** — **self-chosen** by you (like Telegram's per-org webhook secret,
  generated automatically) — pick a random string (e.g. `openssl rand -hex 32`); you'll
  enter the exact same value in Meta's dashboard in step 4.

Sign in as this organization's Administrator, open **Settings → WhatsApp Business**, and
paste all five values into the connect form. This calls `connectWhatsAppAccount`
(`src/server/actions/whatsapp.ts`), which:

1. Runs a lightweight Graph API health check (fetches this phone number's own info) with the
   pasted access token/phone number id BEFORE saving anything — a typo'd credential is
   rejected immediately with a clear error, never silently stored.
2. Encrypts the five-field credential shape (AES-256-GCM — see "Per-organization credential
   encryption" below) and creates/updates this organization's `ChannelAccount`.
3. Returns this organization's own webhook URL —
   `${APP_URL}/api/channels/whatsapp/webhook/{channelAccountId}` — to register in step 4.

### 4. Register the webhook in Meta's App Dashboard

Unlike Telegram's fully-automatic "Connect bot" flow, registering the webhook URL with Meta
remains a manual, dashboard-only step (Meta's webhook subscription isn't a plain API call
this app can make on your behalf). In the App dashboard under WhatsApp → Configuration →
Webhook:

1. Set the **Callback URL** to the per-organization URL the connect form showed you:
   `<APP_URL>/api/channels/whatsapp/webhook/<channelAccountId>`.
2. Set the **Verify Token** field to the exact same value you chose and entered in step 3.
3. Click **Verify and Save** — Meta immediately issues a `GET` request to that callback URL
   with `?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`; the per-account route
   (`src/app/api/channels/whatsapp/webhook/[channelAccountId]/route.ts`'s `GET` handler)
   must be publicly reachable over HTTPS at that moment (same tunneling note as Telegram's
   setup — see that section above for `ngrok`/`cloudflared` instructions if developing
   locally), and validates your verify token against THIS organization's own stored one
   before echoing back the raw `hub.challenge` value as plain text with `200`.
4. Subscribe to the **`messages`** webhook field (this is what delivers both inbound
   messages and delivery-status callbacks — Meta doesn't separate them into different
   fields).

An operator must still set `WHATSAPP_ENABLED="true"` (and `CREDENTIAL_ENCRYPTION_KEY`) once
for the whole deployment and restart the app so `registerChannelAdapters()` picks up
`WhatsAppAdapter` (`src/server/channels/index.ts`) — until then, the connect form itself
refuses to run and both webhook routes stay `404` regardless of what's pasted into them (by
design: enabling the adapter is a single, explicit, deployment-wide flag flip).

### Multi-organization isolation

Two different organizations can each connect their own distinct WhatsApp Business phone
number — each gets its own `ChannelAccount`, its own encrypted credentials, and its own
webhook path (`/api/channels/whatsapp/webhook/{channelAccountId}`), so both the GET
verify-handshake and POST inbound/status deliveries are checked purely against the specific
account the URL names — there is no more "peek inside the body for `phone_number_id` before
knowing which secret to verify with" step (see "Known limitations" below for the design this
replaced). The DB-level `@@unique([channelType, externalAccountId])` constraint means the
SAME phone number can never be connected — active or not — to two different organizations
at once.

### 5. Message templates (required to *initiate* conversations)

WhatsApp only allows a business to send a **free-form text message** (what
`WhatsAppAdapter.sendMessage` sends) within the **24-hour customer service window** — i.e.
in reply to a message the customer sent you within the last 24 hours. To message a customer
*first*, or to resume a conversation after that window closes, Meta requires a
pre-approved **message template** (a fixed-structure message with named variable slots,
e.g. "Your order {{1}} has shipped"), submitted for review in the App dashboard under
WhatsApp → Message Templates. Template review typically takes minutes to a few hours and can
be rejected for category-mismatch or promotional-content-in-a-utility-template reasons — plan
for at least one rejection-and-resubmit cycle the first time.

`WhatsAppAdapter.sendTemplateMessage` (an adapter-specific extension method, not part of the
shared `MessagingChannelAdapter` interface — see that method's doc comment for why)
implements the correct Graph API request shape (`type: "template"`, `template.name`,
`template.language.code`, optional `template.components` for variable substitution) and its
response/error handling. **No template is registered on any real WABA in this sandbox** —
there is nothing to test this against live, so it is exercised only against a mocked `fetch`
in `adapter.test.ts`. Wiring a real "is the 24h window open, and if not, which template do I
send" decision into the outbound lifecycle (§3.6) is a documented **post-MVP gap**, not
built in this phase.

### Delivery-status callbacks

Unlike Telegram/Android, WhatsApp DOES deliver delivery-status callbacks — `sent`,
`delivered`, `read`, and `failed` — as `statuses[]` entries on the same `messages` webhook
field inbound messages arrive on. These are handled by a dedicated module,
`src/server/messaging/deliveryStatusService.ts`, called from a distinct branch in the
webhook route (not folded into `processInboundMessage`, since a status callback updates an
EXISTING outbound `Message` rather than creating a new one — see that module's doc comment
for the full design rationale). Idempotency is enforced via a derived
`${whatsappMessageId}:${status}:${timestamp}` key stored as `MessageEvent.externalEventId`,
so a Meta webhook retry delivering the identical callback twice never double-records.
`WhatsAppAdapter.getDeliveryStatus()` itself always returns `null` — there is no pull/polling
API for this either; the webhook is the only source, same precedent as Telegram/Android.

### Known limitations (documented, not hidden)

- **~~One global WhatsApp phone number per deployment~~ — FIXED.** An earlier version of
  this MVP resolved every inbound delivery by peeking inside the webhook body for
  `phone_number_id` (via `channelAccountRepository.findActiveByChannelTypeAndExternalAccountId`)
  BEFORE knowing which organization's `appSecret` to verify the signature with — workable
  only because `WHATSAPP_APP_SECRET` was one global env var, and there was no in-app way to
  connect more than one organization's number anyway. Both limitations are gone: the
  per-account webhook URL now identifies the account (and its own secret) up front, and any
  organization can connect its own number from Settings (see "Multi-organization isolation"
  above).
- **No template-selection/24h-window logic wired into the outbound lifecycle.**
  `sendTemplateMessage` exists and is tested in isolation (mocked `fetch`), but nothing in
  `src/server/messaging/outboundService.ts` yet decides "is this contact's 24h window open,
  and if not, which approved template do I send instead of a plain text message" — a
  documented post-MVP gap, same spirit as cross-channel contact merging (§7 of the
  implementation plan).
- **Rich media (image/audio/document/location/etc.) inbound messages are not translated —
  they're normalized to a bracketed placeholder** (e.g. `[unsupported WhatsApp message type:
  image]`) so a human agent still sees *something* arrived, rather than being silently
  dropped. Downloading/relaying the actual media is out of scope for this MVP.
- **No delivery read receipts for OUTBOUND Android/Telegram-style "did they read it"
  beyond WhatsApp's own `read` status callback** — this one is actually better than
  Telegram/Android here (WhatsApp does tell you), it's called out only for symmetry with the
  other two adapters' equivalent notes.
