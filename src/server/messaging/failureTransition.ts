/**
 * T1 fix (docs/test-report.md): shared "transition a Message to FAILED with a classified
 * reason" helper.
 *
 * Before this fix, only the outbound adapter-send-failure path
 * (`outboundService.handleSendFailure`) had this logic — `assertValidTransition`, persist
 * `FAILED` + `failureReason`, record a classified `MessageEvent` — and neither
 * `inboundService.processInboundMessage` nor `outboundService.sendMessage` caught a thrown
 * `TranslationEngine.detectLanguage()`/`.translate()` call at all, so a translation-provider
 * failure lost the message entirely instead of landing here. This module factors out the
 * one bit of that logic that is identical across all three failure sites (adapter-send,
 * outbound-translation, inbound-translation) so none of them re-implement it: what happens
 * *after* (whether an automatic retry gets scheduled, whether a `SendMessageResult` shape
 * is returned) still differs per caller and stays in `outboundService.ts`/`inboundService.ts`
 * respectively.
 */
import type { Message } from "@prisma/client";
import { messageEventRepository, type MessageEventType } from "../repositories/messageEventRepository";
import { messageRepository } from "../repositories/messageRepository";
import type { FailureClassification } from "./failureClassifier";
import { assertValidTransition } from "./retryQueue";

/**
 * Asserts the transition is valid, persists `FAILED` + `failureReason`, and records a
 * `MessageEvent` of `eventType` carrying `{ classification, failureReason }`. Returns the
 * updated `Message`. Callers decide what (if anything) happens next — e.g. scheduling an
 * automatic retry for a transient outbound failure.
 */
export async function transitionToFailed(
  organizationId: string,
  message: Message,
  eventType: MessageEventType,
  classification: FailureClassification,
  failureReason: string,
): Promise<Message> {
  assertValidTransition(message.status, "FAILED");
  const updated = await messageRepository.updateStatus(organizationId, message.id, "FAILED", { failureReason });
  await messageEventRepository.create({
    messageId: message.id,
    eventType,
    payload: { classification, failureReason },
  });
  return updated;
}
