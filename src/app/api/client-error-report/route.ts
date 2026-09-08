/**
 * `POST /api/client-error-report` — a lightweight, unauthenticated telemetry sink for
 * client-side rendering errors caught by `(app)/error.tsx` / `global-error.tsx`.
 *
 * This exists because Railway's (or any host's) server logs can only ever see server-side
 * exceptions — a crash inside client-rendered React (a bad hydration, a null-dereference in
 * a client component, an infinite render loop) is invisible to `next start`'s own stdout/
 * stderr no matter how carefully the deploy logs are read. Without this endpoint, diagnosing
 * a client-only crash requires the affected user to manually pull up their browser's dev
 * tools/remote-debugging — which is exactly the dead end this project hit once already
 * (a real production crash that never appeared in Railway's logs because it was purely
 * client-side). This endpoint is the fix: an error boundary reports here, and the error
 * shows up in the same structured server logs as everything else.
 *
 * Unauthenticated (an error boundary can fire for a user who was never signed in, e.g. on
 * `/sign-in` itself) and rate-limited per IP to bound abuse — this is a logging sink, not a
 * feature, so a generous but bounded limit is enough.
 */
import { z } from "zod";
import { logger } from "@/server/logger";
import { getClientIp, rateLimitedResponse, webhookRateLimiter } from "@/server/rateLimit";

const clientErrorReportSchema = z.object({
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
  digest: z.string().max(200).optional(),
  path: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  boundary: z.enum(["app", "global"]),
});

export async function POST(req: Request): Promise<Response> {
  const rateLimit = webhookRateLimiter.check(getClientIp(req));
  if (!rateLimit.allowed) {
    return rateLimitedResponse();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const parsed = clientErrorReportSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false }, { status: 400 });
  }

  logger.error(
    {
      client_error: true,
      boundary: parsed.data.boundary,
      digest: parsed.data.digest,
      path: parsed.data.path,
      userAgent: parsed.data.userAgent,
      stack: parsed.data.stack,
    },
    `client_render_error: ${parsed.data.message}`,
  );

  return Response.json({ ok: true }, { status: 200 });
}
