# Android SMS Gateway — companion app

This directory holds the Android companion app that turns a physical Android phone (with its
own SIM) into a "channel" for AutoTranslator's Shared Inbox — no cloud SMS vendor (no
Twilio/Telnyx/Vonage) is involved anywhere in this path. **This document is still the
detailed client-side build specification** referenced in the product brief ("if it is outside
the current project scope, implement the complete backend contract and create a separate
detailed build specification for the Android client") — the backend contract itself lives in
[`../docs/channel-adapters.md`](../docs/channel-adapters.md)'s "Android SMS gateway" section —
but a real Kotlin app implementing this spec now also lives under `app/`; see "What's
actually in this directory" below for what was built and how to build/run it.

## What the app has to do, end to end

The server never calls the device. The device is always the one initiating contact, on its
own schedule:

1. **Register once.** An admin registers the device from the AutoTranslator dashboard
   (`POST /api/gateways/register`) and is shown a device token exactly once. That token gets
   typed/QR-scanned/otherwise transferred into the app and stored securely on-device
   (Android Keystore — see "Authentication" below). This app never calls `/register` itself.
2. **Heartbeat periodically.** `POST /api/gateways/heartbeat` every 1–5 minutes so the
   dashboard can show the device as alive.
3. **Poll for outbound work.** `GET /api/gateways/messages/pending` every 15–60 seconds. For
   each message: send it via Android's `SmsManager`, then acknowledge or report failure.
4. **Relay inbound SMS.** Whenever the device receives a text message (via a
   `BroadcastReceiver` on `SMS_RECEIVED_ACTION`), push it to the server with
   `POST /api/gateways/inbound`.

See `../docs/channel-adapters.md` for exact request/response JSON for all four endpoints
above plus `/acknowledge` and `/fail`.

## Required Android permissions

| Permission | Why |
|---|---|
| `android.permission.SEND_SMS` | Required to call `SmsManager.sendTextMessage(...)` for outbound relay. |
| `android.permission.RECEIVE_SMS` | Required for the `BroadcastReceiver` that observes inbound SMS. |
| `android.permission.READ_PHONE_STATE` | Needed on some OEM/Android versions to reliably read the active SIM's subscription id (for dual-SIM device disambiguation — see "Carrier limitations" below) and to detect signal/service state for `NO_SIGNAL` failure reporting. |
| `android.permission.FOREGROUND_SERVICE` (+ `FOREGROUND_SERVICE_DATA_SYNC` on Android 14+) | Required to run the persistent background polling/heartbeat loop as a foreground service (see next section). |
| `android.permission.POST_NOTIFICATIONS` (Android 13+) | A foreground service must show a persistent notification; posting it requires this runtime permission. |
| `android.permission.INTERNET` / `ACCESS_NETWORK_STATE` | Talking to the AutoTranslator API at all, and detecting connectivity for the device-side retry logic. |
| `android.permission.RECEIVE_BOOT_COMPLETED` | Restart the foreground service automatically after a device reboot — otherwise the gateway silently stops working until someone manually reopens the app. |

`SEND_SMS`/`RECEIVE_SMS`/`READ_PHONE_STATE` are all "dangerous" permissions requiring a
runtime request (`ActivityCompat.requestPermissions`) and, per Play Store policy (see
"Privacy and disclosure requirements" below), a clear in-app justification shown to the user
before requesting them.

## Background service requirements

Android's background execution limits (Doze, App Standby Buckets, and — since Android 8 —
background service restrictions) mean a plain background thread or a bare `Service` will be
killed or throttled within minutes of the app losing foreground focus. This app's entire
value proposition (reliably relaying SMS) depends on the poll/heartbeat loop running
continuously, so it MUST run as a **foreground service**:

- Start it with `ContextCompat.startForegroundService(...)` and call
  `Service.startForeground(notificationId, notification)` within 5 seconds (Android kills the
  service if this deadline is missed).
- Show a **persistent, low-priority notification** ("AutoTranslator gateway is running —
  relaying SMS for +1 555-123-4567") for as long as the service is alive. This is not
  optional cosmetic polish — it's the mechanism Android uses to justify *not* killing the
  process, and Play Store policy requires the user always be able to see that SMS relaying is
  active.
- Use `startForeground` with the correct foreground service **type** on Android 14+
  (`dataSync` is the closest fit for "syncing messages with a remote server"; `SEND_SMS`
  itself doesn't need its own foreground-service type as of API 34, but confirm against the
  current Android version targeted at build time — this changes across Android releases).
- Restart on boot (`RECEIVE_BOOT_COMPLETED` + a `BroadcastReceiver` that re-starts the
  foreground service) and restart on task removal if the user swipes the app away
  (`Service.onTaskRemoved` re-starting itself), since a gateway phone is typically a
  dedicated, unattended device — it should recover from every routine disruption without a
  human physically walking over to it.

## Battery-optimization considerations

Even a correctly-implemented foreground service can still be paused by aggressive
OEM-specific battery managers (Samsung's "Sleeping apps", Xiaomi's MIUI battery saver,
Huawei's Protected Apps, OnePlus's Battery Optimization, etc.) that go beyond stock
Android's Doze/App Standby. Build and document, at minimum:

- **Request exemption from stock Android's battery optimization** via
  `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (guarded by a clear explanation screen first
  — this is a heavily-scrutinized intent and Play Store policy restricts unjustified use of
  it to apps with a genuine, ongoing background-communication need, which this app has).
- **Ship an in-app "Battery setup" screen** that walks the user through the OEM-specific
  settings screen for their device (there is no single API for this — detect the
  manufacturer via `Build.MANUFACTURER` and deep-link or instruct accordingly: Samsung
  Device Care → Battery → App power management; Xiaomi Security app → Battery → App battery
  saver → set to "No restrictions"; Huawei Phone Manager → Protected Apps; etc.).
- **Detect and surface staleness to the user, not just the server.** The server already
  tracks `lastHeartbeatAt` and reports a stale device as unhealthy
  (`AndroidSmsAdapter.getDeviceHealth`) — the app should independently show its own
  "last successfully synced" timestamp so an on-site operator can tell at a glance if the
  OS has throttled it, without needing dashboard access.
- Since this is meant to run on a semi-dedicated device, recommend (in onboarding copy, not
  enforced by code) disabling "adaptive battery" for this specific app and leaving the phone
  plugged in / on Wi-Fi where practical.

## SMS send/receive workflow

**Sending** (driven by the poll loop):

1. `GET /api/gateways/messages/pending` → a list of `{ id, to, text, createdAt }`.
2. For each entry, call `SmsManager.getDefault().sendTextMessage(to, null, text, sentPI, deliveredPI)`
   — use `sendMultipartTextMessage` instead when `text` exceeds one SMS segment (see "Carrier
   limitations" below on segment limits).
3. Register a `BroadcastReceiver` for the `sentPI`/`deliveredPI` `PendingIntent`s to learn
   the real send outcome asynchronously (`SmsManager` "success" from the call itself only
   means "handed to the radio", not "actually transmitted").
4. On a genuine send success: `POST /api/gateways/messages/:id/acknowledge` with an optional
   `externalMessageId` (any local reference useful for the app's own logs/dedup — the server
   doesn't require a specific format).
5. On a `SmsManager` result code indicating failure, map it to one of the server's four
   `reason` values and call `POST /api/gateways/messages/:id/fail`:
   - `RESULT_ERROR_NO_SERVICE` / `RESULT_ERROR_RADIO_OFF` → `NO_SIGNAL`
   - `RESULT_ERROR_GENERIC_FAILURE` where the destination number is obviously malformed
     (empty, no digits) → `INVALID_NUMBER`
   - Any SIM-related `SecurityException`/absent-SIM condition → `SIM_ERROR`
   - Anything else / unrecognized result code → `UNKNOWN`

**Receiving:**

1. Register a `BroadcastReceiver` (manifest-declared, `android:exported="true"` with the
   `SEND_SMS` broadcast permission requirement Android enforces) for
   `android.provider.Telephony.SMS_RECEIVED`.
2. Extract sender + body + timestamp via `Telephony.Sms.Intents.getMessagesFromIntent(intent)`
   (handles multi-part inbound SMS reassembly for you).
3. Derive a stable `externalMessageId` for the server's dedup key — e.g.
   `sha256(senderAddress + ":" + timestampMillis)` — so a redelivered broadcast (rare, but
   possible on some OEMs) doesn't create a duplicate inbound message server-side.
4. `POST /api/gateways/inbound` with `{ from, text, sentAt, externalMessageId }`.

## Authentication (device-side)

- The device token (`POST /api/gateways/register`'s one-time response) must be stored in the
  **Android Keystore-backed** `EncryptedSharedPreferences`
  (`androidx.security:security-crypto`), never in plain `SharedPreferences`, a plain file, or
  logged anywhere (including crash reports/analytics).
- Send it as `Authorization: Bearer <token>` on every request to every gateway endpoint
  except (there is no "except" — even `/heartbeat` requires it; only the server-side
  `/register` call, which this app never makes, is session-authenticated instead).
- If the server ever returns `401 { "error": "unauthorized" }`, treat it as **terminal for
  this token** — most likely the device was revoked from the dashboard. Stop
  polling/heartbeating, surface a clear "This device has been disconnected — contact your
  administrator to re-register it" screen, and do not silently retry the same token forever.
- There is no token-refresh endpoint (tokens are not time-limited) — a revoked device gets a
  brand new token only by being registered again as a "new" device from the dashboard.

## Retry behavior (device-side — separate from the server's own retry queue)

The server already retries failed **outbound sends** on its own schedule once the device
reports a transient failure (`../docs/channel-adapters.md`'s `/fail` section). This section
is about the **device's own network reliability** reaching the server at all — a distinct
concern:

- Wrap every HTTP call (heartbeat, pending poll, inbound push, ack, fail) in a short
  bounded-retry with jittered exponential backoff (e.g. base 2s, cap ~5 attempts, cap total
  wait under the next poll interval) for connectivity failures (timeout, DNS failure, 5xx).
  Do NOT retry a `401`/`429` the same way — `401` is terminal (see above), `429` should back
  off to at least the `Retry-After`-equivalent implied by the rate limit window (60s) before
  trying again.
- For `POST /api/gateways/inbound` specifically: if the device fails to reach the server
  after all retries, **queue the inbound SMS locally** (a small on-device DB/file, not just
  in memory) and retry on the next successful connectivity check — an inbound SMS must never
  be silently dropped just because the network was briefly down. The server-side dedup key
  (`externalMessageId`) makes a delayed, eventually-successful retry safe even if it's sent
  minutes or hours later.
- Similarly, an acknowledge/fail call that fails to reach the server should be retried (the
  server-side `acknowledge` handler is idempotent specifically so a retried ack is always
  safe) rather than abandoned — an un-acknowledged `QUEUED` message would otherwise appear
  to staff as "still pending" indefinitely even though the SMS actually went out.

## Carrier limitations

- **Segment/character limits.** A standard GSM-7 SMS segment is 160 characters (153 when
  concatenated across multiple segments, due to the User Data Header); non-GSM-7 text (most
  non-Latin scripts, emoji) drops to UCS-2 encoding at 70 characters per segment (67 when
  concatenated). Since AutoTranslator's translated text can be in any language, **always use
  `SmsManager.divideMessage(text)` + `sendMultipartTextMessage(...)`** rather than assuming a
  single-segment send — silently truncating a translated reply is worse than sending it as
  multiple SMS segments (the carrier reassembles them for the recipient automatically).
- **Rate limits.** Carriers and Android itself throttle SMS send rate to combat spam (Android
  historically prompts the user with a confirmation dialog above ~30 messages/hour to a
  short code, though this varies by OS version/OEM/carrier and mainly targets premium/short
  codes rather than normal 10-digit numbers). Don't burst-send the entire pending queue with
  no delay — space sends out by at least a second or two, and expect occasional carrier-level
  soft-throttling under sustained high volume.
- **Regional restrictions.** Some countries/carriers restrict or require registration for
  A2P (application-to-person) SMS traffic, block alphanumeric sender ids, or restrict
  international SMS termination entirely. This app relies on a genuine consumer SIM sending
  as a normal person-to-person message, which sidesteps most A2P-specific registration
  requirements, but bulk/automated-looking traffic from a single number can still trigger
  carrier anti-spam heuristics (temporary send blocks) — this is a real operational
  constraint of the "your own SIM is the channel" architecture, not a bug, and should be
  disclosed to whoever operates the gateway device.
- **Dual-SIM devices.** On a dual-SIM phone, `SmsManager.getDefault()` uses the OS-configured
  default SMS subscription, which may not be the SIM the operator intends for this app. Use
  `SmsManager.getSmsManagerForSubscriptionId(subId)` with an explicitly-configured
  `subscriptionId` (surfaced in the app's settings screen, enumerated via
  `SubscriptionManager.getActiveSubscriptionInfoList()`) rather than trusting the OS default,
  and re-validate that the configured SIM is still present/active at each send attempt
  (report `SIM_ERROR` if it was removed or swapped).

## Privacy and disclosure requirements

This app reads and sends SMS on behalf of the person who owns the phone — that is
inherently sensitive, and both Google Play policy and basic user trust require:

- **A published privacy policy**, linked from the Play Store listing and from within the app
  itself, that specifically discloses: the app reads incoming SMS content and sender numbers
  and transmits them to the operator's AutoTranslator server; the app sends outbound SMS on
  the operator's behalf; what is/isn't retained server-side (see `Organization.dataRetentionDays`
  in the main app — this device-side doc should link to whatever retention policy the
  deploying organization actually configures).
- **Play Store SMS permission justification.** Google's "Permissions used to Handle SMS or
  Call Log" policy requires the app's *core, user-facing purpose* to require `SEND_SMS`/
  `RECEIVE_SMS` — a "business messaging relay/gateway" app is a plausible fit for that policy
  category, but the Play Console declaration form and an in-app disclosure/consent screen
  (shown before the runtime permission prompt) are both required, and Google does manually
  review apps requesting these permissions.
- **Explicit, plain-language user consent at setup time** — e.g. "By continuing, you agree
  that text messages sent to and from this phone will be relayed through [Organization
  Name]'s AutoTranslator inbox for translation and staff visibility." This should be a
  distinct, affirmative step in the app's onboarding flow, not buried in a EULA.
- **No SMS content in analytics/crash logs.** If any crash-reporting or analytics SDK is
  added later, scrub message bodies and phone numbers from breadcrumbs/logs before that SDK
  processes them.

## What's actually in this directory

The Phase 8 backend pass delivered the complete server-side API contract and this build
specification with no Kotlin app. **A later pass built the real client** under `app/` — a
minimal-but-functional Kotlin/Jetpack Compose Android app implementing everything above: the
setup/status screens, the foreground service with its heartbeat + poll/send loops, the
`SmsManager` send path (multipart, sent-intent result tracking, dual-SIM support), the
manifest-declared `SMS_RECEIVED` receiver, the boot receiver, on-device retry queues for
inbound pushes and acknowledge/fail calls, and Keystore-backed encrypted token storage. See
"Building and running the app" below for how to open and build it.

### Building and running the app

1. **Open the project.** Launch Android Studio (Koala/2024.1 or newer) → Open →
   select the `android-gateway/` directory (not the repo root — this is a separate Gradle
   project from the Next.js app, on purpose, so the two build systems never interfere with
   each other). Studio will run its own first-sync Gradle download automatically.
2. **SDK requirements**: `compileSdk`/`targetSdk` 34, `minSdk` 26 (Android 8.0 — the first
   version with the background-service execution limits this app's foreground-service design
   exists to satisfy). Android Studio will prompt to install platform 34 + build-tools 34.0.0
   if you don't already have them.
3. **Point it at a deployed server.** There is no config file to edit — the app has no
   hardcoded server URL or token anywhere in source (by design, see "Working rules" in the
   brief this was built against). Install the app on a device or emulator, open it, and on
   the setup screen enter:
   - **Server base URL** — e.g. your Railway deployment's URL (`https://your-app.up.railway.app`).
   - **Device token** — from an Administrator's **Settings → Channel integrations → Android
     SMS gateway → Register device** action in the AutoTranslator web dashboard (this calls
     `POST /api/gateways/register` server-side and shows the token exactly once — see
     "Register a device" above). This app never calls `/register` itself.
4. **Grant permissions** on the same setup screen (`SEND_SMS`, `RECEIVE_SMS`,
   `READ_PHONE_STATE`, and `POST_NOTIFICATIONS` on Android 13+) and accept the SMS-relay
   consent notice, then save. The foreground service starts automatically once credentials
   are saved.
5. **A real SIM is required for actual SMS send/receive** — an emulator has no cellular radio,
   so `SmsManager` calls will fail there with `NO_SIGNAL`/similar; use a physical device (or
   at minimum a device image with emulated cellular via a real SIM-capable AVD config) to
   exercise the SMS half end-to-end. The heartbeat/poll/HTTP half works fine on any
   emulator with network access.
6. **Command-line build** (from `android-gateway/`, with `ANDROID_HOME` set to a valid SDK,
   or an `android-gateway/local.properties` with `sdk.dir=...`):
   ```bash
   ./gradlew assembleDebug   # -> app/build/outputs/apk/debug/app-debug.apk
   ./gradlew lintDebug       # static analysis
   ./gradlew testDebugUnitTest
   ```

### What was and wasn't verified by actually compiling (be honest about this)

This project **was compiled for real** in the sandbox that built it — not just reviewed by
eye. A full Android SDK (`cmdline-tools`, `platform-tools`, `platforms;android-34`,
`build-tools;34.0.0`) was provisioned there specifically to prove this out, and:

- `./gradlew assembleDebug` **succeeds**, producing a real, installable `app-debug.apk`.
- `./gradlew lintDebug` **passes** (Android Lint's real static analysis — manifest checks,
  resource checks, API-level checks — not just the Kotlin compiler) with zero errors and zero
  warnings other than informational "a newer library version exists" notices for a few
  intentionally-pinned dependency versions (see `app/build.gradle.kts`'s comments).
- `./gradlew testDebugUnitTest` **passes** 4 real unit tests
  (`app/src/test/kotlin/.../util/BackoffRetryTest.kt`) covering the retry/backoff logic.

What this does **not** prove, and could not be verified in that sandbox (no device/emulator,
no physical SIM):

- The app has never actually been installed on a device or emulator, so no screen has been
  visually confirmed to render correctly, no button has actually been tapped, and no runtime
  crash (a `NullPointerException` on a real device's exact API level/OEM skin, a Compose
  layout bug only visible at runtime, etc.) has been ruled out the way it would be by
  `./gradlew installDebug` + manual exploration.
- **No real SMS has ever actually been sent or received** — the `SmsManager`
  divide/multipart/sent-intent logic and the `SMS_RECEIVED` receiver are correct against the
  documented Android APIs to the best of this pass's knowledge, but neither has been exercised
  against a real radio/SIM/carrier, which is where the genuinely carrier-specific edge cases
  (a particular OEM's dual-SIM behavior, a particular carrier's segment reassembly quirks)
  would actually surface.
- **No real server was hit** — the HTTP client's request/response shapes were hand-matched
  field-for-field against the Route Handler source (see each DTO/client method's doc comment
  citing the exact file), not verified against a live deployment.

A human opening this in Android Studio should expect: a project that syncs and builds without
Gradle/dependency surprises (already proven), but should still budget normal
first-real-device-test time for UI polish and the SMS-specific edge cases above.
