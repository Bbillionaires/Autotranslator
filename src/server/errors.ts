/**
 * Centralized error handling, per docs/implementation-plan.md §2.5 / §6.8.
 *
 * `AppError` and its subclasses are the only errors service-layer code should throw for
 * "expected" failure modes (not found, forbidden, bad input, conflicting state, upstream
 * adapter failure). `handleRouteError()` converts any thrown error into a safe, generic
 * JSON response for Route Handlers while logging the real error (with stack) server-side.
 * Server Actions should use `toSafeActionError()` for the same purpose (Server Actions
 * can't return arbitrary HTTP status codes, so they return a plain safe-message object
 * instead of throwing raw errors across the server/client boundary).
 */
import { randomUUID } from "node:crypto";
import { logger } from "./logger";

export type AppErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "UPSTREAM_ADAPTER_ERROR"
  | "INTERNAL_ERROR";

/** Base class for every "expected" application error. Never leaks a stack trace to clients. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  /** Extra structured detail safe to log, but NOT safe to send to the client verbatim. */
  readonly detail?: unknown;

  constructor(message: string, code: AppErrorCode, httpStatus: number, detail?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "The requested resource was not found.", detail?: unknown) {
    super(message, "NOT_FOUND", 404, detail);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.", detail?: unknown) {
    super(message, "FORBIDDEN", 403, detail);
  }
}

export class ValidationError extends AppError {
  constructor(message = "The provided input is invalid.", detail?: unknown) {
    super(message, "VALIDATION_ERROR", 400, detail);
  }
}

export class ConflictError extends AppError {
  constructor(message = "The request conflicts with the current state.", detail?: unknown) {
    super(message, "CONFLICT", 409, detail);
  }
}

/** Thrown when a channel/translation adapter (Telegram, WhatsApp, Android, OpenAI, ...) fails. */
export class UpstreamAdapterError extends AppError {
  constructor(message = "An upstream service failed to respond correctly.", detail?: unknown) {
    super(message, "UPSTREAM_ADAPTER_ERROR", 502, detail);
  }
}

/** The shape returned to clients — deliberately generic, never a stack trace. */
export interface SafeErrorResponse {
  error: {
    message: string;
    code: AppErrorCode;
    requestId: string;
  };
}

function toSafeMessage(error: unknown): {
  message: string;
  code: AppErrorCode;
  httpStatus: number;
} {
  if (error instanceof AppError) {
    return { message: error.message, code: error.code, httpStatus: error.httpStatus };
  }
  return {
    message: "Something went wrong. Please try again or contact support.",
    code: "INTERNAL_ERROR",
    httpStatus: 500,
  };
}

/**
 * Use inside every Route Handler's catch block:
 *
 *   try { ... } catch (error) { return handleRouteError(error); }
 */
export function handleRouteError(error: unknown, context: Record<string, unknown> = {}): Response {
  const requestId = (context.requestId as string | undefined) ?? randomUUID();
  const { message, code, httpStatus } = toSafeMessage(error);

  if (error instanceof AppError) {
    logger.warn(
      { err: error, code, requestId, ...context },
      `Route handler error: ${error.message}`,
    );
  } else {
    logger.error({ err: error, requestId, ...context }, "Unhandled route handler error");
  }

  const body: SafeErrorResponse = {
    error: { message: `${message} Reference: ${requestId}`, code, requestId },
  };

  return Response.json(body, { status: httpStatus });
}

/**
 * Use inside every Server Action's catch block to convert an error into a safe object the
 * client component can display, e.g.:
 *
 *   export async function myAction(input: unknown) {
 *     try {
 *       ...
 *       return { ok: true as const, data };
 *     } catch (error) {
 *       return { ok: false as const, ...toSafeActionError(error) };
 *     }
 *   }
 */
export function toSafeActionError(
  error: unknown,
  context: Record<string, unknown> = {},
): { message: string; code: AppErrorCode; requestId: string } {
  const requestId = (context.requestId as string | undefined) ?? randomUUID();
  const { message, code } = toSafeMessage(error);

  if (error instanceof AppError) {
    logger.warn(
      { err: error, code, requestId, ...context },
      `Server action error: ${error.message}`,
    );
  } else {
    logger.error({ err: error, requestId, ...context }, "Unhandled server action error");
  }

  return { message: `${message} Reference: ${requestId}`, code, requestId };
}
