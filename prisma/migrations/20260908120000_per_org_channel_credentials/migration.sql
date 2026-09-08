-- Per-organization channel credentials (Builder task, replacing C1's single-global-
-- bot-token band-aid, docs/review-report.md).
--
-- 1. Add `encryptedCredentials` for per-org, encrypted-at-rest channel credentials (AES-256-
--    GCM via CREDENTIAL_ENCRYPTION_KEY — see src/server/crypto/credentialEncryption.ts).
--    Purely additive: every existing row gets NULL, no data migration needed.
ALTER TABLE "ChannelAccount" ADD COLUMN "encryptedCredentials" JSONB;

-- 2. Replace the per-org uniqueness guarantee with a global one: an externalAccountId (e.g.
--    a Telegram bot id, a WhatsApp phone_number_id) may belong to at most ONE ChannelAccount
--    across the whole deployment, not just at most one per organization. This is what
--    actually prevents the same bot/number being simultaneously claimed ACTIVE by two
--    different organizations now that each org has genuinely distinct credentials and a
--    genuinely distinct webhook path (see prisma/schema.prisma's ChannelAccount doc comment
--    for the full rationale).
DROP INDEX "ChannelAccount_organizationId_channelType_externalAccountId_key";
CREATE UNIQUE INDEX "ChannelAccount_channelType_externalAccountId_key" ON "ChannelAccount"("channelType", "externalAccountId");
