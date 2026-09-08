/**
 * WhatsApp's channel-specific credential shape, layered on top of the generic
 * `src/server/crypto/credentialEncryption.ts` encrypt/decrypt pair. Each organization's
 * WhatsApp `ChannelAccount.encryptedCredentials` decrypts to exactly this shape:
 *   { accessToken, phoneNumberId, businessAccountId, appSecret, verifyToken }
 * — the five values that used to be global `WHATSAPP_*` env vars, now entered per-org via
 * Settings and encrypted at rest.
 */
import type { ChannelAccount } from "@prisma/client";
import { z } from "zod";
import { decryptCredentials, encryptCredentials, encryptedCredentialsBlobSchema, type EncryptedCredentialsBlob } from "../../crypto/credentialEncryption";
import { NotConfiguredError, ValidationError } from "../../errors";

export interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  appSecret: string;
  verifyToken: string;
}

const whatsAppCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  phoneNumberId: z.string().min(1),
  businessAccountId: z.string().min(1),
  appSecret: z.string().min(1),
  verifyToken: z.string().min(1),
});

/** Encrypts the five-field WhatsApp credential shape for storage on `ChannelAccount.encryptedCredentials`. */
export function encryptWhatsAppCredentials(credentials: WhatsAppCredentials): EncryptedCredentialsBlob {
  return encryptCredentials(credentials);
}

/**
 * Decrypts and validates a WhatsApp `ChannelAccount`'s stored credentials. Throws
 * `NotConfiguredError` if the account has no stored credentials yet, or `ValidationError`
 * if the decrypted payload doesn't match the expected shape (see the Telegram counterpart's
 * doc comment for why this defensive check exists at all).
 */
export function decryptWhatsAppCredentials(channelAccount: Pick<ChannelAccount, "encryptedCredentials">): WhatsAppCredentials {
  if (!channelAccount.encryptedCredentials) {
    throw new NotConfiguredError("This WhatsApp channel account has no stored credentials — connect a WhatsApp Business account first.");
  }
  const blobResult = encryptedCredentialsBlobSchema.safeParse(channelAccount.encryptedCredentials);
  if (!blobResult.success) {
    throw new ValidationError("This WhatsApp channel account's stored credentials are malformed.");
  }
  const decrypted = decryptCredentials(blobResult.data);
  const parsed = whatsAppCredentialsSchema.safeParse(decrypted);
  if (!parsed.success) {
    throw new ValidationError("This WhatsApp channel account's decrypted credentials do not match the expected shape.");
  }
  return parsed.data;
}
