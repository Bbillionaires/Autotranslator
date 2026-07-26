/**
 * Unit tests for the pure WhatsApp webhook-payload normalization helpers (`parse.ts`), per
 * the Phase 9 task brief: "fixture Meta webhook payloads (a `messages[]` entry, a
 * `statuses[]` entry) normalize/branch correctly." No Prisma/network dependency — plain
 * function tests against representative fixture JSON.
 */
import { describe, expect, it } from "vitest";
import { extractWhatsAppValueBlocks, mapWhatsAppStatus, normalizeWhatsAppMessages, type WhatsAppWebhookPayload } from "./parse";

function inboundTextPayload(): WhatsAppWebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "1234567890" },
              contacts: [{ profile: { name: "Maria" }, wa_id: "5215512345678" }],
              messages: [
                {
                  from: "5215512345678",
                  id: "wamid.HBgLMTIzNDU2Nzg5MDA=",
                  timestamp: "1753531200",
                  type: "text",
                  text: { body: "Hola, ¿cuándo abren?" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusCallbackPayload(status: "sent" | "delivered" | "read" | "failed" = "delivered"): WhatsAppWebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "1234567890" },
              statuses: [
                {
                  id: "wamid.OUTBOUND123",
                  status,
                  timestamp: "1753531260",
                  recipient_id: "5215512345678",
                  ...(status === "failed"
                    ? { errors: [{ code: 131026, title: "Message undeliverable", message: "Recipient number is not a WhatsApp user" }] }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("normalizeWhatsAppMessages", () => {
  it("normalizes a text messages[] entry into a NormalizedInboundMessage", () => {
    const normalized = normalizeWhatsAppMessages(inboundTextPayload());
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      externalContactId: "5215512345678",
      externalUsername: "Maria",
      phoneNumber: "+5215512345678",
      externalMessageId: "wamid.HBgLMTIzNDU2Nzg5MDA=",
      text: "Hola, ¿cuándo abren?",
    });
    expect(normalized[0].sentAt).toEqual(new Date(1753531200 * 1000));
  });

  it("returns an empty array for a statuses-only payload (no messages[])", () => {
    expect(normalizeWhatsAppMessages(statusCallbackPayload())).toEqual([]);
  });

  it("returns an empty array for a payload with no entry/changes at all", () => {
    expect(normalizeWhatsAppMessages({})).toEqual([]);
  });

  it("normalizes an unsupported message type to a placeholder instead of dropping it silently", () => {
    const payload = inboundTextPayload();
    payload.entry![0].changes![0].value.messages = [
      { from: "5215512345678", id: "wamid.IMG1", timestamp: "1753531200", type: "image" },
    ];
    const normalized = normalizeWhatsAppMessages(payload);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].text).toContain("image");
  });

  it("carries externalReplyToId from message.context.id when present", () => {
    const payload = inboundTextPayload();
    payload.entry![0].changes![0].value.messages![0].context = { id: "wamid.PARENT" };
    const normalized = normalizeWhatsAppMessages(payload);
    expect(normalized[0].externalReplyToId).toBe("wamid.PARENT");
  });
});

describe("extractWhatsAppValueBlocks", () => {
  it("groups a messages[] value into a block keyed by phone_number_id", () => {
    const blocks = extractWhatsAppValueBlocks(inboundTextPayload());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].phoneNumberId).toBe("1234567890");
    expect(blocks[0].messages).toHaveLength(1);
    expect(blocks[0].statuses).toEqual([]);
  });

  it("groups a statuses[] value into a block with raw statuses, not NormalizedInboundMessage", () => {
    const blocks = extractWhatsAppValueBlocks(statusCallbackPayload("delivered"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].messages).toEqual([]);
    expect(blocks[0].statuses).toHaveLength(1);
    expect(blocks[0].statuses[0]).toMatchObject({ id: "wamid.OUTBOUND123", status: "delivered" });
  });

  it("skips a value block with no phone_number_id in metadata", () => {
    const payload: WhatsAppWebhookPayload = {
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "" } } }] }],
    };
    expect(extractWhatsAppValueBlocks(payload)).toEqual([]);
  });
});

describe("mapWhatsAppStatus", () => {
  it("maps 'delivered' to DELIVERED with a derived externalEventId and no failureReason", () => {
    const mapped = mapWhatsAppStatus(statusCallbackPayload("delivered").entry![0].changes![0].value.statuses![0]);
    expect(mapped.status).toBe("DELIVERED");
    expect(mapped.externalMessageId).toBe("wamid.OUTBOUND123");
    expect(mapped.externalEventId).toBe("wamid.OUTBOUND123:delivered:1753531260");
    expect(mapped.failureReason).toBeUndefined();
    expect(mapped.occurredAt).toEqual(new Date(1753531260 * 1000));
  });

  it("maps 'read' to READ", () => {
    const mapped = mapWhatsAppStatus(statusCallbackPayload("read").entry![0].changes![0].value.statuses![0]);
    expect(mapped.status).toBe("READ");
  });

  it("maps 'sent' to SENT", () => {
    const mapped = mapWhatsAppStatus(statusCallbackPayload("sent").entry![0].changes![0].value.statuses![0]);
    expect(mapped.status).toBe("SENT");
  });

  it("maps 'failed' to FAILED and derives failureReason from the errors[] array", () => {
    const mapped = mapWhatsAppStatus(statusCallbackPayload("failed").entry![0].changes![0].value.statuses![0]);
    expect(mapped.status).toBe("FAILED");
    expect(mapped.failureReason).toContain("Message undeliverable");
    expect(mapped.failureReason).toContain("not a WhatsApp user");
  });

  it("produces different externalEventIds for different statuses of the same message (delivered vs read)", () => {
    const delivered = mapWhatsAppStatus(statusCallbackPayload("delivered").entry![0].changes![0].value.statuses![0]);
    const read = mapWhatsAppStatus({ ...statusCallbackPayload("read").entry![0].changes![0].value.statuses![0], timestamp: "1753531300" });
    expect(delivered.externalEventId).not.toBe(read.externalEventId);
  });
});
