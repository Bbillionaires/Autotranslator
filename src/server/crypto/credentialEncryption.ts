/**
 * Per-organization channel-credential encryption at rest.
 *
 * This replaces the single-global-env-var credential model (`TELEGRAM_BOT_TOKEN`,
 * `WHATSAPP_ACCESS_TOKEN`, etc.) with genuine per-organization credential storage: each
 * `ChannelAccount` can carry its own `encryptedCredentials` (see prisma/schema.prisma), a
 * JSON blob produced by `encryptCredentials` below and consumed by `decryptCredentials`.
 *
 * ## Algorithm
 * AES-256-GCM, keyed from `CREDENTIAL_ENCRYPTION_KEY` (a 32-byte key, hex-encoded — 64 hex
 * characters — validated by a Zod regex in `src/server/env.ts`; generate one for local dev
 * with `openssl rand -hex 32`). GCM was chosen over CBC because it's authenticated: any
 * tampering with the ciphertext, IV, or auth tag is detected and rejected (via the auth
 * tag), rather than silently decrypting to garbage — critical for credential storage, where
 * silently-corrupted plaintext (e.g. a truncated bot token) would be far worse than a loud
 * failure.
 *
 * ## On-disk shape
 * `EncryptedCredentialsBlob` is `{ iv, authTag, ciphertext }`, each a base64 string, stored
 * verbatim as the JSON value of `ChannelAccount.encryptedCredentials`. A fresh random
 * 96-bit IV (`randomBytes(IV_LENGTH)`) is generated on every `encryptCredentials` call —
 * GCM's security depends on never reusing an IV under the same key, and re-encrypting on
 * every credential rotation/update naturally gives each version its own IV.
 *
 * ## What's encrypted
 * The plaintext is an arbitrary JSON-serializable object — the caller decides the shape.
 * Per-channel-type wrapper modules (`src/server/channels/telegram/credentials.ts`,
 * `src/server/channels/whatsapp/credentials.ts`) layer a Zod schema on top of this generic
 * encrypt/decrypt pair so each channel's specific credential fields
 * (`{ botToken, webhookSecret }` for Telegram; `{ accessToken, phoneNumberId,
 * businessAccountId, appSecret, verifyToken }` for WhatsApp) are validated on the way in and
 * out, rather than duplicating Zod parsing at every call site.
 *
 * ## Key rotation (not implemented — documented limitation)
 * There is no key-versioning scheme here: `CREDENTIAL_ENCRYPTION_KEY` is a single process-
 * wide key, and rotating it would make every previously-encrypted `ChannelAccount` row
 * undecryptable (this module has no way to know "which key" a given blob was encrypted
 * with). A real key-rotation story would need either a key id stored alongside the blob (so
 * old ciphertext can still be decrypted with its original key while new writes use the
 * current one) or a one-time re-encrypt-everything migration run at rotation time. Flagged
 * here, not built — see the Builder's final report for the full risk callout.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { NotConfiguredError, ValidationError } from "../errors";
import { env } from "../env";

const ALGORITHM = "aes-256-gcm";
/** 96-bit IV — the length NIST recommends for GCM (and Node's default/only supported length for this cipher). */
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;

/** The on-disk shape of an encrypted credentials blob (see module doc comment). */
export interface EncryptedCredentialsBlob {
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** Validates the *shape* (not the cryptographic validity) of a value read back from `ChannelAccount.encryptedCredentials`. */
export const encryptedCredentialsBlobSchema = z.object({
  iv: z.string().min(1),
  authTag: z.string().min(1),
  ciphertext: z.string().min(1),
});

/** `/^[0-9a-f]{64}$/i` — 32 bytes, hex-encoded. Exported so `env.ts` can reuse the exact same validator for `CREDENTIAL_ENCRYPTION_KEY`. */
export const CREDENTIAL_ENCRYPTION_KEY_PATTERN = /^[0-9a-f]{64}$/i;

function getKey(): Buffer {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new NotConfiguredError(
      "CREDENTIAL_ENCRYPTION_KEY is not configured — required to encrypt/decrypt per-organization channel credentials.",
    );
  }
  const key = Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, "hex");
  if (key.length !== KEY_LENGTH_BYTES) {
    // Should be unreachable in practice — env.ts's Zod schema already rejects a
    // malformed/wrong-length key at boot — but defended here too since this function is
    // also called directly by unit tests that stub `env.CREDENTIAL_ENCRYPTION_KEY` in
    // isolation from the full env-parsing pipeline.
    throw new NotConfiguredError("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters).");
  }
  return key;
}

/**
 * Encrypts an arbitrary JSON-serializable plaintext object into an `EncryptedCredentialsBlob`.
 * A fresh random IV is generated on every call (see module doc comment on IV reuse).
 */
export function encryptCredentials<T extends object>(plaintext: T): EncryptedCredentialsBlob {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintextBuffer = Buffer.from(JSON.stringify(plaintext), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypts an `EncryptedCredentialsBlob` back into its plaintext object. Throws
 * `ValidationError` (never returns garbage) if the ciphertext, IV, or auth tag has been
 * tampered with, or if the wrong key is used to decrypt — GCM's auth tag check fails in
 * both cases, and `decipher.final()` throws rather than returning corrupted plaintext.
 */
export function decryptCredentials<T extends object = Record<string, unknown>>(blob: EncryptedCredentialsBlob): T {
  const key = getKey();

  let iv: Buffer;
  let authTag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(blob.iv, "base64");
    authTag = Buffer.from(blob.authTag, "base64");
    ciphertext = Buffer.from(blob.ciphertext, "base64");
  } catch {
    throw new ValidationError("Stored credentials blob is malformed (invalid base64).");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let plaintextBuffer: Buffer;
  try {
    plaintextBuffer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    // GCM auth-tag verification failure (tampered ciphertext/IV/tag, or wrong key) lands
    // here — `decipher.final()` throws rather than returning unauthenticated plaintext.
    throw new ValidationError("Failed to decrypt stored credentials — the data may be corrupted, tampered with, or encrypted under a different key.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    return JSON.parse(plaintextBuffer.toString("utf8")) as T;
  } catch {
    throw new ValidationError("Decrypted credentials are not valid JSON.");
  }
}
