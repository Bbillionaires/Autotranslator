-- AlterTable
ALTER TABLE "ChannelAccount" ADD COLUMN     "deviceTokenHash" TEXT,
ADD COLUMN     "lastHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "revokedAt" TIMESTAMP(3);
