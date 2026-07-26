/**
 * Prisma client singleton.
 *
 * In Next.js dev mode, modules can be re-evaluated on every hot reload; without caching
 * the client on `globalThis` we'd exhaust Postgres connections. This is the standard
 * Prisma + Next.js pattern.
 */
import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Either the top-level Prisma client or an interactive-transaction client
 * (`prisma.$transaction(async (tx) => ...)`). Phase 5's repositories (contact,
 * channelAccount, contactChannelIdentity, conversation, message, messageEvent) accept this
 * as an optional trailing parameter, defaulting to the module-level `prisma` singleton, so
 * a service like `inboundService`/`outboundService` can run several repository calls
 * inside one `prisma.$transaction(...)` by just threading `tx` through instead of
 * duplicating query logic per call site.
 */
export type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

/** True when `error` is a Prisma unique-constraint violation (P2002), optionally scoped to a specific target field/constraint name. */
export function isUniqueConstraintViolation(error: unknown, target?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  if (!target) {
    return true;
  }
  const meta = error.meta as { target?: string | string[] } | undefined;
  const targets = Array.isArray(meta?.target) ? meta.target : [meta?.target].filter(Boolean);
  return targets.some((t) => typeof t === "string" && t.includes(target));
}
