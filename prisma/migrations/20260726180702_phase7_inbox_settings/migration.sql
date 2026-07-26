-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "highRisk" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "dataRetentionDays" INTEGER,
ADD COLUMN     "reviewBeforeSendDefault" BOOLEAN NOT NULL DEFAULT false;
