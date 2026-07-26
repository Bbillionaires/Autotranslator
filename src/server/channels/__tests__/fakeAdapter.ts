/**
 * `FakeChannelAdapter` — test-only, in-memory `MessagingChannelAdapter`.
 *
 * Exercises the full inbound/outbound lifecycles (docs/implementation-plan.md §3.5/§3.6)
 * without any real network call. NOT registered in the production `channelAdapterRegistry`
 * (see ../index.ts) — a real Telegram/Android/WhatsApp adapter lands in Phases 6/8/9.
 *
 * Test helpers (`queueFailure`, `sentMessages`, `reset`) let a test script the adapter's
 * next `sendMessage()` outcome so it can assert on both the success path and the
 * transient/permanent failure paths of the outbound lifecycle.
 */
import type { ChannelType } from "@prisma/client";
import { UpstreamAdapterError } from "../../errors";
import type {
  DeliveryStatusUpdate,
  MessagingChannelAdapter,
  NormalizedInboundMessage,
  SendMessageInput,
  SendMessageResult,
} from "../types";

/** A queued failure outcome for the next `sendMessage()` call. */
export interface QueuedFailure {
  /** "transient" => classifyAdapterFailure should retry; "permanent" => it should not. */
  kind: "transient" | "permanent";
  message?: string;
}

export class FakeChannelAdapter implements MessagingChannelAdapter {
  readonly channelType: ChannelType;
  readonly sentMessages: SendMessageInput[] = [];
  /** Populate before a `parseInboundWebhook()` call in tests that exercise that path. */
  inboundQueue: NormalizedInboundMessage[] = [];
  private nextExternalId = 1;
  private queuedFailures: QueuedFailure[] = [];
  private healthy = true;

  constructor(channelType: ChannelType = "TELEGRAM") {
    this.channelType = channelType;
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const failure = this.queuedFailures.shift();
    if (failure) {
      throw new UpstreamAdapterError(
        failure.message ?? `Simulated ${failure.kind} adapter failure`,
        // `transient` here is read by classifyAdapterFailure (../../messaging/retryQueue.ts)
        // to decide retry eligibility without needing to guess from the message text.
        { transient: failure.kind === "transient" },
      );
    }
    this.sentMessages.push(input);
    return { externalMessageId: `fake-msg-${this.nextExternalId++}`, status: "SENT" };
  }

  async validateWebhook(): Promise<boolean> {
    return true;
  }

  async parseInboundWebhook(): Promise<NormalizedInboundMessage[]> {
    const queued = this.inboundQueue;
    this.inboundQueue = [];
    return queued;
  }

  async getDeliveryStatus(externalMessageId: string): Promise<DeliveryStatusUpdate | null> {
    return { externalMessageId, status: "DELIVERED", occurredAt: new Date() };
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return this.healthy ? { healthy: true } : { healthy: false, detail: "Simulated unhealthy adapter" };
  }

  // ---- test helpers (not part of MessagingChannelAdapter) ----

  /** Makes the next N `sendMessage()` calls throw the given failure kind, in order. */
  queueFailure(kind: "transient" | "permanent", message?: string): void {
    this.queuedFailures.push({ kind, message });
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  reset(): void {
    this.sentMessages.length = 0;
    this.inboundQueue = [];
    this.queuedFailures = [];
    this.nextExternalId = 1;
    this.healthy = true;
  }
}
