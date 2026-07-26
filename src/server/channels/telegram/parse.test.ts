import { describe, expect, it } from "vitest";
import { normalizeTelegramUpdate, type TelegramUpdate } from "./parse";

function baseUpdate(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return { update_id: 1, ...overrides };
}

describe("normalizeTelegramUpdate", () => {
  it("normalizes a regular `message` update", () => {
    const update = baseUpdate({
      message: {
        message_id: 42,
        from: { id: 1001, first_name: "Alice", username: "alice" },
        chat: { id: 555, type: "private" },
        text: "Hola, como estas?",
        date: 1_753_531_200, // 2025-07-26T12:00:00Z
      },
    });

    const [normalized] = normalizeTelegramUpdate(update);

    expect(normalized).toBeDefined();
    expect(normalized.externalContactId).toBe("555");
    expect(normalized.externalUsername).toBe("alice");
    expect(normalized.externalMessageId).toBe("42");
    expect(normalized.text).toBe("Hola, como estas?");
    expect(normalized.sentAt.toISOString()).toBe(new Date(1_753_531_200 * 1000).toISOString());
    expect(normalized.raw).toEqual(update);
  });

  it("normalizes reply_to_message into externalReplyToId", () => {
    const update = baseUpdate({
      message: {
        message_id: 43,
        chat: { id: 555, type: "private" },
        text: "reply text",
        date: 1_753_531_300,
        reply_to_message: { message_id: 42 },
      },
    });

    const [normalized] = normalizeTelegramUpdate(update);
    expect(normalized.externalReplyToId).toBe("42");
  });

  it("normalizes an `edited_message` update with a distinct externalMessageId from the original", () => {
    const editedUpdate = baseUpdate({
      edited_message: {
        message_id: 42, // same message_id Telegram uses for the original message
        chat: { id: 555, type: "private" },
        text: "Hola, como estas? (edited)",
        date: 1_753_531_200,
        edit_date: 1_753_531_260,
      },
    });

    const [normalized] = normalizeTelegramUpdate(editedUpdate);
    expect(normalized.externalMessageId).toBe("42:edited:1753531260");
    expect(normalized.externalMessageId).not.toBe("42");
    expect(normalized.text).toBe("Hola, como estas? (edited)");
  });

  it("returns an empty array for a message with no text (e.g. a bare photo)", () => {
    const update = baseUpdate({
      message: { message_id: 44, chat: { id: 555, type: "private" }, date: 1_753_531_200 },
    });
    expect(normalizeTelegramUpdate(update)).toEqual([]);
  });

  it("returns an empty array for a callback_query-only update (handled separately by the webhook route)", () => {
    const update = baseUpdate({
      callback_query: { id: "cbq1", from: { id: 1001 }, data: "lang:es" },
    });
    expect(normalizeTelegramUpdate(update)).toEqual([]);
  });
});
