import { describe, expect, it } from "vitest";
import { resolveTargetLanguage } from "./resolveLanguage";

describe("resolveTargetLanguage", () => {
  it("prefers the conversation override above everything else", () => {
    expect(
      resolveTargetLanguage({
        conversationOverride: "fr",
        contactPreferred: "es",
        contactDetected: "de",
        orgDefault: "en",
      }),
    ).toBe("fr");
  });

  it("falls back to the contact's preferred language when there is no override", () => {
    expect(
      resolveTargetLanguage({
        conversationOverride: null,
        contactPreferred: "es",
        contactDetected: "de",
        orgDefault: "en",
      }),
    ).toBe("es");
  });

  it("falls back to the contact's detected language when preferred is unset", () => {
    expect(
      resolveTargetLanguage({
        conversationOverride: undefined,
        contactPreferred: null,
        contactDetected: "de",
        orgDefault: "en",
      }),
    ).toBe("de");
  });

  it("falls back to the org default when nothing contact/conversation-level is set", () => {
    expect(
      resolveTargetLanguage({
        conversationOverride: null,
        contactPreferred: null,
        contactDetected: null,
        orgDefault: "pt-BR",
      }),
    ).toBe("pt-BR");
  });

  it("falls back to a hardcoded 'en' when even orgDefault is missing (defensive fallback beyond the type contract)", () => {
    // `orgDefault` is typed as a required `string`, so this can only happen if a caller
    // violates that contract at runtime (e.g. an unvalidated DB read) — the "en" fallback
    // exists specifically to make that still-safe rather than producing `undefined`.
    expect(
      resolveTargetLanguage({
        conversationOverride: null,
        contactPreferred: null,
        contactDetected: null,
        orgDefault: undefined as unknown as string,
      }),
    ).toBe("en");
  });

  it("falls back to 'en' when every optional field is entirely omitted and orgDefault is missing", () => {
    expect(resolveTargetLanguage({ orgDefault: undefined as unknown as string })).toBe("en");
  });

  it("does NOT fall back to 'en' when orgDefault is an empty string (empty string is not null/undefined)", () => {
    // Documents the exact semantics of `??`: only null/undefined trigger the next
    // priority level, so an empty-string orgDefault is used as-is rather than skipped.
    expect(
      resolveTargetLanguage({
        conversationOverride: null,
        contactPreferred: null,
        contactDetected: null,
        orgDefault: "",
      }),
    ).toBe("");
  });

  it("treats null and undefined identically at every level", () => {
    const withNulls = resolveTargetLanguage({
      conversationOverride: null,
      contactPreferred: null,
      contactDetected: "ja",
      orgDefault: "en",
    });
    const withUndefined = resolveTargetLanguage({
      conversationOverride: undefined,
      contactPreferred: undefined,
      contactDetected: "ja",
      orgDefault: "en",
    });
    expect(withNulls).toBe("ja");
    expect(withUndefined).toBe("ja");
  });

  it("skips a null/undefined override but still prefers a set contactPreferred over contactDetected", () => {
    expect(
      resolveTargetLanguage({
        contactPreferred: "it",
        contactDetected: "ru",
        orgDefault: "en",
      }),
    ).toBe("it");
  });
});
