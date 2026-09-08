/**
 * Tests for `src/server/crypto/credentialEncryption.ts` — the AES-256-GCM module every
 * per-organization channel credential (Telegram bot token, WhatsApp access token, etc.) is
 * encrypted with before being stored on `ChannelAccount.encryptedCredentials`. Security-
 * sensitive code, so this covers the three properties the Builder task explicitly calls
 * out: round-trip correctness, tamper detection (GCM auth tag), and wrong-key rejection —
 * plus the env-driven key-configuration edge cases.
 *
 * `process.env.CREDENTIAL_ENCRYPTION_KEY` must be set before `../env` is imported (env.ts
 * parses `process.env` once at import time) — same dynamic-import-after-env-assignment
 * convention every other test file in this codebase uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const KEY_A = "11".repeat(32); // 64 hex chars = 32 bytes
const KEY_B = "22".repeat(32); // a different, equally-valid 32-byte key

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.DIRECT_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.AUTH_SECRET ??= "test-only-secret";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_A;

const { encryptCredentials, decryptCredentials, encryptedCredentialsBlobSchema, CREDENTIAL_ENCRYPTION_KEY_PATTERN } = await import(
  "./credentialEncryption"
);

afterEach(() => {
  vi.resetModules();
  process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_A;
});

describe("encryptCredentials / decryptCredentials — round trip", () => {
  it("decrypts back to the exact original plaintext object", () => {
    const plaintext = { botToken: "123456:AAExampleNotReal", webhookSecret: "s3cr3t-webhook-value" };
    const blob = encryptCredentials(plaintext);
    const decrypted = decryptCredentials(blob);
    expect(decrypted).toEqual(plaintext);
  });

  it("round-trips a more complex object (WhatsApp's five-field shape)", () => {
    const plaintext = {
      accessToken: "EAAG...",
      phoneNumberId: "1234567890",
      businessAccountId: "9876543210",
      appSecret: "app-secret-value",
      verifyToken: "verify-token-value",
    };
    const blob = encryptCredentials(plaintext);
    expect(decryptCredentials(blob)).toEqual(plaintext);
  });

  it("produces a blob matching the documented shape (iv/authTag/ciphertext, base64 strings)", () => {
    const blob = encryptCredentials({ a: 1 });
    expect(encryptedCredentialsBlobSchema.safeParse(blob).success).toBe(true);
    expect(() => Buffer.from(blob.iv, "base64")).not.toThrow();
    expect(() => Buffer.from(blob.authTag, "base64")).not.toThrow();
    expect(() => Buffer.from(blob.ciphertext, "base64")).not.toThrow();
  });

  it("generates a fresh, distinct IV (and therefore distinct ciphertext) on every call, even for identical plaintext", () => {
    const plaintext = { botToken: "same-token" };
    const blobA = encryptCredentials(plaintext);
    const blobB = encryptCredentials(plaintext);
    expect(blobA.iv).not.toBe(blobB.iv);
    expect(blobA.ciphertext).not.toBe(blobB.ciphertext);
    // Both still decrypt correctly despite differing ciphertext/IV.
    expect(decryptCredentials(blobA)).toEqual(plaintext);
    expect(decryptCredentials(blobB)).toEqual(plaintext);
  });
});

describe("decryptCredentials — tamper detection (GCM auth tag)", () => {
  it("throws when the ciphertext is modified", () => {
    const blob = encryptCredentials({ botToken: "real-token" });
    const tamperedBytes = Buffer.from(blob.ciphertext, "base64");
    tamperedBytes[0] = tamperedBytes[0] ^ 0xff; // flip a bit
    const tampered = { ...blob, ciphertext: tamperedBytes.toString("base64") };

    expect(() => decryptCredentials(tampered)).toThrow();
  });

  it("throws when the auth tag is modified", () => {
    const blob = encryptCredentials({ botToken: "real-token" });
    const tamperedTag = Buffer.from(blob.authTag, "base64");
    tamperedTag[0] = tamperedTag[0] ^ 0xff;
    const tampered = { ...blob, authTag: tamperedTag.toString("base64") };

    expect(() => decryptCredentials(tampered)).toThrow();
  });

  it("throws when the IV is modified (decrypts to garbage the auth tag rejects)", () => {
    const blob = encryptCredentials({ botToken: "real-token" });
    const tamperedIv = Buffer.from(blob.iv, "base64");
    tamperedIv[0] = tamperedIv[0] ^ 0xff;
    const tampered = { ...blob, iv: tamperedIv.toString("base64") };

    expect(() => decryptCredentials(tampered)).toThrow();
  });
});

describe("decryptCredentials — wrong key rejection", () => {
  it("throws when decrypting with a different (equally valid) key than the one used to encrypt", async () => {
    const blob = encryptCredentials({ botToken: "encrypted-under-key-a" });

    vi.resetModules();
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_B;
    const { decryptCredentials: decryptWithKeyB } = await import("./credentialEncryption");

    expect(() => decryptWithKeyB(blob)).toThrow();
  });
});

describe("encryptCredentials / decryptCredentials — misconfiguration", () => {
  it("throws NotConfiguredError-shaped errors when CREDENTIAL_ENCRYPTION_KEY is unset", async () => {
    vi.resetModules();
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    const { encryptCredentials: encryptUnconfigured } = await import("./credentialEncryption");

    expect(() => encryptUnconfigured({ botToken: "x" })).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });
});

describe("CREDENTIAL_ENCRYPTION_KEY_PATTERN", () => {
  it("accepts a 64-hex-char string", () => {
    expect(CREDENTIAL_ENCRYPTION_KEY_PATTERN.test(KEY_A)).toBe(true);
  });

  it("rejects a too-short string", () => {
    expect(CREDENTIAL_ENCRYPTION_KEY_PATTERN.test("abc123")).toBe(false);
  });

  it("rejects a string with non-hex characters", () => {
    expect(CREDENTIAL_ENCRYPTION_KEY_PATTERN.test("z".repeat(64))).toBe(false);
  });
});
