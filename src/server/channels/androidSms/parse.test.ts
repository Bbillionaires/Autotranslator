import { describe, expect, it } from "vitest";
import { normalizeAndroidInboundSms, normalizePhoneNumber } from "./parse";

describe("normalizePhoneNumber", () => {
  it("preserves a leading + and strips formatting characters", () => {
    expect(normalizePhoneNumber("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("strips formatting characters with no leading +", () => {
    expect(normalizePhoneNumber("555.123.4567")).toBe("5551234567");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePhoneNumber("  +15551234567  ")).toBe("+15551234567");
  });
});

describe("normalizeAndroidInboundSms", () => {
  it("maps the sender phone number to both externalContactId and phoneNumber", () => {
    const sentAt = new Date("2026-07-26T12:00:00Z");
    const result = normalizeAndroidInboundSms({
      from: "+1 555-123-4567",
      text: "Hola, necesito ayuda",
      sentAt,
      externalMessageId: "device-msg-1",
    });

    expect(result.externalContactId).toBe("+15551234567");
    expect(result.phoneNumber).toBe("+15551234567");
    expect(result.externalMessageId).toBe("device-msg-1");
    expect(result.text).toBe("Hola, necesito ayuda");
    expect(result.sentAt).toEqual(sentAt);
    expect(result.raw).toMatchObject({ from: "+1 555-123-4567" });
  });
});
