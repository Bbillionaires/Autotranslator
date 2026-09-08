/**
 * Telegram's channel-specific credential shape, layered on top of the generic
 * `src/server/crypto/credentialEncryption.ts` encrypt/decrypt pair. Each organization's
 * Telegram `ChannelAccount.encryptedCredentials` decrypts to exactly this shape:
 *   { botToken, webhookSecret }
 * — the org's own bot token (pasted from @BotFather in Settings) and a per-org-generated
 * webhook secret (compared against `X-Telegram-Bot-Api-Secret-Token` on every inbound
 * delivery to THIS specific account's webhook path, see
 * `src/app/api/channels/telegram/webhook/[channelAccountId]/route.ts`).
 */
import type { ChannelAccount } from "@prisma/client";
import { z } from "zod";
import { decryptCredentials, encryptCredentials, encryptedCredentialsBlobSchema, type EncryptedCredentialsBlob } from "../../crypto/credentialEncryption";
import { NotConfiguredError, ValidationError } from "../../errors";

export interface TelegramCredentials {
  botToken: string;
  webhookSecret: string;
}

const telegramCredentialsSchema = z.object({
  botToken: z.string().min(1),
  webhookSecret: z.string().min(1),
});

/** Encrypts `{ botToken, webhookSecret }` for storage on `ChannelAccount.encryptedCredentials`. */
export function encryptTelegramCredentials(credentials: TelegramCredentials): EncryptedCredentialsBlob {
  return encryptCredentials(credentials);
}

/**
 * Decrypts and validates a Telegram `ChannelAccount`'s stored credentials. Throws
 * `NotConfiguredError` if the account has no stored credentials yet (e.g. a stale/partially
 * migrated row), or `ValidationError` if the decrypted payload doesn't match the expected
 * shape (should be unreachable in practice — this module is the only writer of the field —
 * but defended against a corrupted/hand-edited row rather than crashing unhelpfully deep
 * inside `JSON.parse` or a destructuring assignment).
 */
export function decryptTelegramCredentials(channelAccount: Pick<ChannelAccount, "encryptedCredentials">): TelegramCredentials {
  if (!channelAccount.encryptedCredentials) {
    throw new NotConfiguredError("This Telegram channel account has no stored credentials — connect a bot first.");
  }
  const blobResult = encryptedCredentialsBlobSchema.safeParse(channelAccount.encryptedCredentials);
  if (!blobResult.success) {
    throw new ValidationError("This Telegram channel account's stored credentials are malformed.");
  }
  const decrypted = decryptCredentials(blobResult.data);
  const parsed = telegramCredentialsSchema.safeParse(decrypted);
  if (!parsed.success) {
    throw new ValidationError("This Telegram channel account's decrypted credentials do not match the expected shape.");
  }
  return parsed.data;
}
