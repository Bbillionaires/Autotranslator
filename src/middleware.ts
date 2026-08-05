/**
 * Security headers middleware, per docs/implementation-plan.md §6.8 (H1 fix,
 * docs/review-report.md — no `middleware.ts`/`next.config.ts#headers()` existed before
 * this, so the app shipped with Next.js defaults only: no clickjacking protection, no
 * MIME-sniffing protection, no CSP).
 *
 * Applies to every request (see `config.matcher` below — everything except Next's own
 * static asset paths) by letting the request through (`NextResponse.next()`) and then
 * stamping the response with the headers §6.8 requires. This runs BEFORE the route
 * handler/page renders, but only ever touches response HEADERS, never the request/response
 * BODY — webhook routes (Telegram/WhatsApp/Android gateway) read their own raw request body
 * exactly as before; this middleware never consumes or re-wraps `req.body`, so signature
 * validation (HMAC over the raw body, etc.) is unaffected. See
 * `src/middleware.test.ts` for a test asserting both that the headers are present AND that
 * a JSON body/request still passes through untouched.
 *
 * CSP: same-origin only. This app renders no third-party scripts/styles/fonts/images/iframes
 * (see `src/app/layout.tsx` — no external `<link>`/`<script>` tags), so `'self'` covers every
 * asset origin this app actually uses. `'unsafe-inline'` is required for Next.js's inline
 * RSC-hydration bootstrap `<script>` tag and Tailwind's inlined `<style>`; `'unsafe-eval'` is
 * additionally allowed in non-production only (Next.js dev/Fast Refresh uses `eval` under the
 * hood — production builds do not need it). `frame-ancestors 'none'` is the CSP-level
 * clickjacking defense that duplicates/reinforces `X-Frame-Options: DENY` for browsers that
 * honor the newer directive.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const CSP_DIRECTIVES = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function middleware(_request: NextRequest): NextResponse {
  const response = NextResponse.next();

  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Content-Security-Policy", CSP_DIRECTIVES);
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  return response;
}

export const config = {
  // Every request except Next's own static asset paths (build chunks, optimized images,
  // favicon) — those don't need/benefit from security headers and excluding them keeps
  // middleware off the hot path for every JS chunk request.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
