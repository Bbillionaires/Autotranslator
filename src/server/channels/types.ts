/**
 * Channel-adapter interfaces, verbatim from docs/implementation-plan.md §3.2.
 *
 * Every channel (`TelegramAdapter` in Phase 6, `AndroidSmsAdapter` in Phase 8,
 * `WhatsAppAdapter` in Phase 9, and the placeholder Messenger/Instagram/Email classes)
 * implements `MessagingChannelAdapter`. Nothing outside `src/server/channels/` and the
 * messaging services should depend on a concrete adapter class — Route Handlers look up
 * the adapter for a channel via the `ChannelAdapterRegistry` (./registry.ts) and delegate;
 * they never talk to Telegram/Meta/the device HTTP APIs directly.
 */
import type { ChannelAccount, ChannelType } from "@prisma/client";

/** A single inbound message, normalized from a channel-specific webhook payload. */
export interface NormalizedInboundMessage {
  externalContactId: string;
  externalUsername?: string;
  phoneNumber?: string;
  externalMessageId: string;
  externalReplyToId?: string;
  text: string;
  sentAt: Date;
  /** Stored verbatim on `MessageEvent.payload` for audit/debugging. */
  raw: unknown;
}

export interface SendMessageInput {
  channelAccount: ChannelAccount;
  externalContactId: string;
  text: string;
  replyToExternalId?: string;
}

export interface SendMessageResult {
  externalMessageId: string;
  /** Adapters never claim "DELIVERED" — that's an async event surfaced separately. */
  status: "SENT" | "QUEUED";
}

export interface DeliveryStatusUpdate {
  externalMessageId: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  failureReason?: string;
  occurredAt: Date;
}

export interface MessagingChannelAdapter {
  readonly channelType: ChannelType;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  validateWebhook?(req: Request): Promise<boolean>;
  parseInboundWebhook?(req: Request): Promise<NormalizedInboundMessage[]>;
  getDeliveryStatus?(externalMessageId: string): Promise<DeliveryStatusUpdate | null>;
  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
}
