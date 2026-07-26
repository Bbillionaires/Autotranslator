import { describe, expect, it } from "vitest";
import {
  acknowledgeMessageSchema,
  failMessageSchema,
  inboundSmsSchema,
  listPendingQuerySchema,
  registerDeviceSchema,
} from "./androidGateway";

describe("registerDeviceSchema", () => {
  it("accepts a valid deviceName + phoneNumber", () => {
    expect(registerDeviceSchema.safeParse({ deviceName: "Front desk phone", phoneNumber: "+15551234567" }).success).toBe(true);
  });

  it("rejects an empty deviceName or phoneNumber", () => {
    expect(registerDeviceSchema.safeParse({ deviceName: "", phoneNumber: "+15551234567" }).success).toBe(false);
    expect(registerDeviceSchema.safeParse({ deviceName: "Phone", phoneNumber: "" }).success).toBe(false);
  });

  it("rejects a phone number with invalid characters", () => {
    expect(registerDeviceSchema.safeParse({ deviceName: "Phone", phoneNumber: "call-me-maybe" }).success).toBe(false);
  });
});

describe("inboundSmsSchema", () => {
  const valid = { from: "+15551234567", text: "hello", sentAt: "2026-07-26T12:00:00Z", externalMessageId: "abc123" };

  it("accepts a fully valid payload and coerces sentAt to a Date", () => {
    const result = inboundSmsSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sentAt).toBeInstanceOf(Date);
    }
  });

  it("rejects a missing externalMessageId", () => {
    expect(inboundSmsSchema.safeParse({ ...valid, externalMessageId: undefined }).success).toBe(false);
  });

  it("rejects an empty text", () => {
    expect(inboundSmsSchema.safeParse({ ...valid, text: "" }).success).toBe(false);
  });

  it("rejects an invalid sentAt", () => {
    expect(inboundSmsSchema.safeParse({ ...valid, sentAt: "not-a-date" }).success).toBe(false);
  });
});

describe("acknowledgeMessageSchema", () => {
  it("accepts an empty object (externalMessageId is optional)", () => {
    expect(acknowledgeMessageSchema.safeParse({}).success).toBe(true);
  });

  it("accepts an explicit externalMessageId", () => {
    expect(acknowledgeMessageSchema.safeParse({ externalMessageId: "sms-ref-1" }).success).toBe(true);
  });
});

describe("failMessageSchema", () => {
  it("accepts every documented reason", () => {
    for (const reason of ["NO_SIGNAL", "INVALID_NUMBER", "SIM_ERROR", "UNKNOWN"]) {
      expect(failMessageSchema.safeParse({ reason }).success).toBe(true);
    }
  });

  it("rejects an unrecognized reason", () => {
    expect(failMessageSchema.safeParse({ reason: "SOMETHING_ELSE" }).success).toBe(false);
  });

  it("rejects a missing reason", () => {
    expect(failMessageSchema.safeParse({}).success).toBe(false);
  });
});

describe("listPendingQuerySchema", () => {
  it("accepts no limit at all", () => {
    expect(listPendingQuerySchema.safeParse({}).success).toBe(true);
  });

  it("coerces a numeric string limit", () => {
    const result = listPendingQuerySchema.safeParse({ limit: "25" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(25);
  });

  it("rejects a limit above 100 or below 1", () => {
    expect(listPendingQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(listPendingQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });
});
