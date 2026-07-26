/**
 * Structured logging via pino, per docs/implementation-plan.md §2.5 / §6.8.
 *
 * - JSON output, LOG_LEVEL-controlled.
 * - `withContext()` produces a child logger that stamps `organizationId` / `requestId`
 *   (and optionally `conversationId` / `messageId`) onto every subsequent log line, so
 *   call sites don't have to repeat that context on every log call.
 */
import pino from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined, // don't add pid/hostname noise in dev logs
  transport:
    env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        }
      : undefined,
});

export interface LogContext {
  organizationId?: string;
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  userId?: string;
  [key: string]: unknown;
}

/**
 * Returns a child logger with the given context stamped onto every log line.
 * Use this at the top of a Server Action / Route Handler / service call instead of the
 * bare `logger` whenever organizationId/requestId are available.
 */
export function withContext(context: LogContext) {
  return logger.child(context);
}

export type Logger = typeof logger;
