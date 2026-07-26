/**
 * Telegram bot-command handling (product brief's required commands), per Phase 6 of
 * docs/implementation-plan.md. `/start`, `/language`, `/help`, `/privacy` are intercepted by
 * the webhook route (`src/app/api/channels/telegram/webhook/route.ts`) BEFORE
 * `processInboundMessage()` is called — they are never translated or stored as ordinary
 * chat `Message` rows. This module is pure/presentational (no Prisma/adapter dependency) so
 * it's trivially unit-testable; the route wires these building blocks to the adapter and
 * repositories.
 */

/** A deliberately short list of common languages for the `/language` inline keyboard. */
export const SUPPORTED_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "pt", label: "Português" },
  { code: "it", label: "Italiano" },
  { code: "ar", label: "العربية" },
  { code: "zh", label: "中文" },
  { code: "ja", label: "日本語" },
  { code: "ru", label: "Русский" },
];

/** Prefix on `callback_data` identifying a `/language` inline-keyboard button press. */
export const LANGUAGE_CALLBACK_PREFIX = "lang:";

/** True when a message's text is a Telegram bot command (starts with `/`). */
export function isBotCommandText(text: string): boolean {
  return text.trim().startsWith("/");
}

/**
 * Parses `/command@BotName args` into `{ command: "command", args: "args" }`. Telegram
 * appends `@BotName` to commands in group chats — stripped here so `/start@MyBot` and
 * `/start` are treated identically.
 */
export function parseBotCommand(text: string): { command: string; args: string } {
  const trimmed = text.trim();
  const [first, ...rest] = trimmed.split(/\s+/);
  const command = (first ?? "").replace(/^\//, "").split("@")[0]!.toLowerCase();
  return { command, args: rest.join(" ") };
}

/** Telegram `InlineKeyboardMarkup` for the `/language` picker — two buttons per row. */
export function buildLanguageKeyboard(): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < SUPPORTED_LANGUAGES.length; i += 2) {
    rows.push(
      SUPPORTED_LANGUAGES.slice(i, i + 2).map((language) => ({
        text: language.label,
        callback_data: `${LANGUAGE_CALLBACK_PREFIX}${language.code}`,
      })),
    );
  }
  return { inline_keyboard: rows };
}

export function findSupportedLanguage(code: string): { code: string; label: string } | undefined {
  return SUPPORTED_LANGUAGES.find((language) => language.code === code);
}

export function startGreetingText(): string {
  return (
    "Welcome! I relay messages between you and our team, translating automatically in " +
    "both directions. Use /language to choose your preferred language, or /help to see " +
    "everything I can do."
  );
}

export function helpText(): string {
  return (
    "Available commands:\n" +
    "/start — get started\n" +
    "/language — choose your preferred language\n" +
    "/help — show this message\n" +
    "/privacy — how your data is used"
  );
}

/**
 * Placeholder privacy blurb — a real, published privacy policy is a separate docs
 * deliverable in a later phase (per the Phase 6 task brief); this responds with real
 * content today rather than silently failing the /privacy command.
 */
export function privacyText(): string {
  return (
    "We use this chat to relay your messages to our team and translate replies back to " +
    "you automatically. Message content is stored to provide this service and is not " +
    "shared outside our organization. A full privacy policy will be published separately " +
    "— contact us if you have questions in the meantime."
  );
}

export function languagePromptText(): string {
  return "Please choose your preferred language:";
}

export function languageConfirmationText(label: string): string {
  return `Your preferred language is now set to ${label}.`;
}

export function unknownCommandText(): string {
  return `Sorry, I didn't recognize that command.\n\n${helpText()}`;
}
