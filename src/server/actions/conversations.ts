"use server";

/**
 * Conversation-management Server Actions, per docs/implementation-plan.md §5:
 *
 *   Conversations | Server Action `assignConversation` | Assign to user/team |
 *     Session+Role(Agent+) | must be same-org user/team; audit-logged
 *   Conversations | Server Action `changeConversationStatus` | Open/Pending/Resolved/
 *     Archived | Session+Role(Agent+) | enum validated
 *   Conversations | Server Action `setConversationLanguageOverride` | Set
 *     `preferredLanguageOverride` | Session+Role(Agent+) | audit-logged
 *   Conversations | Server Action `addInternalNote` | Add a Message with
 *     `isInternalNote: true` | Session+Role(Agent+) | never touches adapter/translation
 *
 * None of these had a Server Action wrapper before Phase 7 — the repository/service
 * functions they delegate to (`conversationRepository.assign/setStatus/setLanguageOverride`,
 * `outboundService.addInternalNote`) already existed from Phases 5/6, built ahead of the UI
 * that would call them. `setConversationHighRisk` is a Phase 7 addition (§6.9's "explicit
 * opt-in high-risk conversation flag") with no prior-phase counterpart.
 */
import { z } from "zod";
import type { Conversation, Message } from "@prisma/client";
import { auth } from "../auth";
import { toSafeActionError, ValidationError } from "../errors";
import { addInternalNote as addInternalNoteService } from "../messaging/outboundService";
import { auditLogRepository } from "../repositories/auditLogRepository";
import { conversationRepository } from "../repositories/conversationRepository";
import { teamRepository } from "../repositories/teamRepository";
import { userRepository } from "../repositories/userRepository";
import { requireRole } from "../roles";

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

const assignConversationSchema = z
  .object({
    conversationId: z.string().min(1),
    assignedUserId: z.string().min(1).nullable().optional(),
    assignedTeamId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => v.assignedUserId !== undefined || v.assignedTeamId !== undefined, {
    message: "At least one of assignedUserId/assignedTeamId must be provided (use null to unassign).",
  });

export async function assignConversation(
  input: z.infer<typeof assignConversationSchema>,
): Promise<ActionResult<Conversation>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const parsed = assignConversationSchema.parse(input);

    // Verify the target user/team belong to the same org before assigning — the repository
    // write itself is org-scoped, but we want a clear ValidationError rather than a silent
    // NotFoundError when a caller passes a cross-org id.
    if (parsed.assignedUserId) {
      await userRepository.findByIdInOrgOrThrow(organizationId, parsed.assignedUserId);
    }
    if (parsed.assignedTeamId) {
      await teamRepository.findByIdInOrgOrThrow(organizationId, parsed.assignedTeamId);
    }

    const updated = await conversationRepository.assign(organizationId, parsed.conversationId, {
      assignedUserId: parsed.assignedUserId,
      assignedTeamId: parsed.assignedTeamId,
    });

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "conversation.reassigned",
      entityType: "Conversation",
      entityId: parsed.conversationId,
      metadata: { assignedUserId: parsed.assignedUserId, assignedTeamId: parsed.assignedTeamId },
    });

    return { ok: true, data: updated };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const changeConversationStatusSchema = z.object({
  conversationId: z.string().min(1),
  status: z.enum(["OPEN", "PENDING", "RESOLVED", "ARCHIVED"]),
});

export async function changeConversationStatus(
  input: z.infer<typeof changeConversationStatusSchema>,
): Promise<ActionResult<Conversation>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const parsed = changeConversationStatusSchema.parse(input);
    const updated = await conversationRepository.setStatus(organizationId, parsed.conversationId, parsed.status);
    return { ok: true, data: updated };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

/** Loose BCP-47 validator — matches the one in src/server/actions/contacts.ts. */
const bcp47LanguageCode = z.string().min(2, "Language code is required.").max(35, "Language code is too long.");

const setConversationLanguageOverrideSchema = z.object({
  conversationId: z.string().min(1),
  languageOverride: z.union([bcp47LanguageCode, z.literal(null)]),
});

export async function setConversationLanguageOverride(
  input: z.infer<typeof setConversationLanguageOverrideSchema>,
): Promise<ActionResult<Conversation>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const parsed = setConversationLanguageOverrideSchema.parse(input);
    const updated = await conversationRepository.setLanguageOverride(
      organizationId,
      parsed.conversationId,
      parsed.languageOverride,
    );

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "conversation.language_override_changed",
      entityType: "Conversation",
      entityId: parsed.conversationId,
      metadata: { languageOverride: parsed.languageOverride },
    });

    return { ok: true, data: updated };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const setConversationHighRiskSchema = z.object({
  conversationId: z.string().min(1),
  highRisk: z.boolean(),
});

/**
 * Toggles the §6.9 "high-risk conversation" flag. Audit-logged since it changes what
 * warning the conversation shows every time a message is sent in it.
 */
export async function setConversationHighRisk(
  input: z.infer<typeof setConversationHighRiskSchema>,
): Promise<ActionResult<Conversation>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const parsed = setConversationHighRiskSchema.parse(input);
    const updated = await conversationRepository.setHighRisk(organizationId, parsed.conversationId, parsed.highRisk);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "conversation.high_risk_flag_changed",
      entityType: "Conversation",
      entityId: parsed.conversationId,
      metadata: { highRisk: parsed.highRisk },
    });

    return { ok: true, data: updated };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const addConversationInternalNoteSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1, "Note text is required."),
});

export async function addConversationInternalNote(
  input: z.infer<typeof addConversationInternalNoteSchema>,
): Promise<ActionResult<Message>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const parsed = addConversationInternalNoteSchema.parse(input);
    if (!parsed.text.trim()) {
      throw new ValidationError("Note text is required.");
    }
    const note = await addInternalNoteService(organizationId, parsed.conversationId, session!.user.id, parsed.text);
    return { ok: true, data: note };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
