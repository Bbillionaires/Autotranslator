import { describe, expect, it } from "vitest";
import {
  buildLanguageKeyboard,
  findSupportedLanguage,
  isBotCommandText,
  LANGUAGE_CALLBACK_PREFIX,
  parseBotCommand,
  SUPPORTED_LANGUAGES,
} from "./commands";

describe("isBotCommandText", () => {
  it("recognizes a leading slash as a command", () => {
    expect(isBotCommandText("/start")).toBe(true);
    expect(isBotCommandText("  /help  ")).toBe(true);
  });

  it("does not treat regular chat text as a command", () => {
    expect(isBotCommandText("hello there")).toBe(false);
    expect(isBotCommandText("path/to/thing")).toBe(false);
  });
});

describe("parseBotCommand", () => {
  it("parses a bare command", () => {
    expect(parseBotCommand("/start")).toEqual({ command: "start", args: "" });
  });

  it("parses a command with arguments", () => {
    expect(parseBotCommand("/language es")).toEqual({ command: "language", args: "es" });
  });

  it("strips a Telegram-appended @BotName suffix", () => {
    expect(parseBotCommand("/start@MyCoolBot")).toEqual({ command: "start", args: "" });
  });

  it("lowercases the command", () => {
    expect(parseBotCommand("/HELP")).toEqual({ command: "help", args: "" });
  });
});

describe("buildLanguageKeyboard", () => {
  it("includes every supported language exactly once, with the lang: callback prefix", () => {
    const keyboard = buildLanguageKeyboard();
    const buttons = keyboard.inline_keyboard.flat();
    expect(buttons).toHaveLength(SUPPORTED_LANGUAGES.length);
    for (const language of SUPPORTED_LANGUAGES) {
      const button = buttons.find((b) => b.callback_data === `${LANGUAGE_CALLBACK_PREFIX}${language.code}`);
      expect(button).toBeDefined();
      expect(button?.text).toBe(language.label);
    }
  });
});

describe("findSupportedLanguage", () => {
  it("finds a known language code", () => {
    expect(findSupportedLanguage("es")?.label).toBe("Español");
  });

  it("returns undefined for an unknown code", () => {
    expect(findSupportedLanguage("xx")).toBeUndefined();
  });
});
