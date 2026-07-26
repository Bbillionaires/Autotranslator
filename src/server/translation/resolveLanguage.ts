/**
 * Language-priority resolution, per docs/implementation-plan.md §3.4.
 *
 * A single pure function, unit-tested in isolation, used by both the inbound lifecycle
 * (§3.5 — "what language should the user's inbox show") and the outbound lifecycle
 * (§3.6 — "what language should the contact receive"). Callers pass in whichever four
 * values are applicable to their direction; this function never touches Prisma, env, or
 * any other side effect, which is what makes it trivially unit-testable.
 *
 * Priority order, exactly as specified:
 *   1. Conversation.preferredLanguageOverride
 *   2. Contact.preferredLanguage
 *   3. Contact.detectedLanguage
 *   4. Organization.defaultLanguage
 *   5. hardcoded "en" fallback
 */

export interface ResolveTargetLanguageContext {
  conversationOverride?: string | null;
  contactPreferred?: string | null;
  contactDetected?: string | null;
  orgDefault: string;
}

export function resolveTargetLanguage(ctx: ResolveTargetLanguageContext): string {
  return (
    ctx.conversationOverride ??
    ctx.contactPreferred ??
    ctx.contactDetected ??
    ctx.orgDefault ??
    "en"
  );
}
