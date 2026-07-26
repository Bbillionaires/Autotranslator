/**
 * Prisma client singleton.
 *
 * In Next.js dev mode, modules can be re-evaluated on every hot reload; without caching
 * the client on `globalThis` we'd exhaust Postgres connections. This is the standard
 * Prisma + Next.js pattern.
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
