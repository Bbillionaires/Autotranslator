/**
 * Org-scoped repository for `AuditLog`, per docs/implementation-plan.md §6.8 ("`AuditLog`
 * rows are written for every sensitive mutation: role changes, user invites/deactivation,
 * channel account connect/disconnect/credential rotation, glossary changes, org settings
 * changes, contact archive, conversation reassignment, translation edits, and message
 * retries"). Phase 7 is the first phase where most of these mutations get real Server
 * Actions wired to UI, so this is the first place a generic `recordAuditLog` helper is
 * needed — earlier phases either had no UI yet or (per contacts.ts's doc comment) explicitly
 * deferred audit logging to this cross-cutting pass.
 *
 * Deliberately fire-and-forget-shaped but awaited by callers: a failure to write an audit
 * row should not silently vanish, but it also shouldn't be allowed to block or roll back the
 * mutation it's describing (the write already committed by the time this is called) — so
 * callers wrap the mutation + `recordAuditLog` call in a best-effort sequence, not a single
 * transaction. See each Server Action for the exact call site.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import type { PrismaClientOrTx } from "../db";

export interface RecordAuditLogInput {
  organizationId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

export const auditLogRepository = {
  async record(input: RecordAuditLogInput, client: PrismaClientOrTx = prisma) {
    return client.auditLog.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId ?? undefined,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: (input.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
      },
    });
  },

  async listByOrg(
    organizationId: string,
    options: { entityType?: string; take?: number } = {},
    client: PrismaClientOrTx = prisma,
  ) {
    return client.auditLog.findMany({
      where: { organizationId, ...(options.entityType ? { entityType: options.entityType } : {}) },
      orderBy: { createdAt: "desc" },
      take: options.take ?? 100,
    });
  },
};

/** Convenience wrapper matching the task brief's suggested signature. */
export async function recordAuditLog(
  organizationId: string,
  userId: string | null | undefined,
  action: string,
  entityType: string,
  entityId: string,
  metadata?: Record<string, unknown>,
) {
  return auditLogRepository.record({ organizationId, userId, action, entityType, entityId, metadata });
}
