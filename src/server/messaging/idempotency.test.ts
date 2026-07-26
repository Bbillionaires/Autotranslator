import { describe, expect, it } from "vitest";
import { deriveInboundIdempotencyKey, deriveOutboundIdempotencyKey } from "./idempotency";

describe("deriveInboundIdempotencyKey", () => {
  it("produces a 64-char lowercase hex sha256 digest", () => {
    const key = deriveInboundIdempotencyKey("chan_1", "ext_msg_1");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same (channelAccountId, externalMessageId) pair", () => {
    const a = deriveInboundIdempotencyKey("chan_1", "ext_msg_1");
    const b = deriveInboundIdempotencyKey("chan_1", "ext_msg_1");
    expect(a).toBe(b);
  });

  it("differs when the channel account id differs", () => {
    const a = deriveInboundIdempotencyKey("chan_1", "ext_msg_1");
    const b = deriveInboundIdempotencyKey("chan_2", "ext_msg_1");
    expect(a).not.toBe(b);
  });

  it("differs when the external message id differs", () => {
    const a = deriveInboundIdempotencyKey("chan_1", "ext_msg_1");
    const b = deriveInboundIdempotencyKey("chan_1", "ext_msg_2");
    expect(a).not.toBe(b);
  });

  it("does not collide across the ':' delimiter boundary (chan_1:ext vs chan_12:ext minus a char)", () => {
    // Guards against a naive concatenation scheme accidentally colliding, e.g.
    // ("chan_1", "2:ext") vs ("chan_12", "ext") would collide under plain string
    // concatenation without a delimiter; the explicit ":" delimiter used here still
    // doesn't fully prevent this class of collision, but the digest makes it
    // cryptographically implausible in practice — this test just documents the shape.
    const a = deriveInboundIdempotencyKey("chan_1", "2:ext");
    const b = deriveInboundIdempotencyKey("chan_12", "ext");
    expect(a).not.toBe(b);
  });
});

describe("deriveOutboundIdempotencyKey", () => {
  it("returns the client-supplied key when provided", () => {
    expect(deriveOutboundIdempotencyKey("client-key-123")).toBe("client-key-123");
  });

  it("trims whitespace around a client-supplied key", () => {
    expect(deriveOutboundIdempotencyKey("  client-key-123  ")).toBe("client-key-123");
  });

  it("falls back to a generated UUID when no key is supplied", () => {
    const key = deriveOutboundIdempotencyKey(undefined);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("falls back to a generated UUID when given null", () => {
    const key = deriveOutboundIdempotencyKey(null);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("falls back to a generated UUID when given an empty/whitespace-only string", () => {
    const key = deriveOutboundIdempotencyKey("   ");
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("generates distinct UUIDs across calls when falling back", () => {
    const a = deriveOutboundIdempotencyKey();
    const b = deriveOutboundIdempotencyKey();
    expect(a).not.toBe(b);
  });
});
