/**
 * GET /api/health — liveness/readiness check, per docs/implementation-plan.md §5 ("System").
 *
 * Liveness: the process is up and able to respond at all.
 * Readiness: the database is reachable. Per-adapter (Telegram/WhatsApp/Android) health
 * checks are added in later phases once those adapters exist.
 */
import { prisma } from "@/server/db";
import { logger } from "@/server/logger";

export async function GET() {
  const checks: Record<string, "ok" | "error"> = {};
  let databaseLatencyMs: number | null = null;

  try {
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    databaseLatencyMs = Date.now() - start;
    checks.database = "ok";
  } catch (error) {
    logger.error({ err: error }, "Health check: database unreachable");
    checks.database = "error";
  }

  const healthy = Object.values(checks).every((status) => status === "ok");

  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
      databaseLatencyMs,
    },
    { status: healthy ? 200 : 503 },
  );
}
