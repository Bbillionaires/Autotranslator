/**
 * `POST /api/gateways/register` — register a new Android SMS gateway device, per
 * docs/implementation-plan.md §5/§6.3 and the Phase 8 task brief.
 *
 * Session+Role(Administrator+) authenticated (this is an admin action performed from the
 * dashboard, NOT a device-token-authenticated gateway call — the device doesn't have a
 * token yet, that's what this endpoint issues). Creates a `ChannelAccount`
 * (`channelType: "ANDROID_SMS"`), issues a signed device token
 * (`src/server/gateways/androidAuth.ts`), persists only its hash, and returns the raw token
 * ONCE in the response body — it is never re-displayed and never stored in plaintext
 * anywhere (see `androidAuth.ts`'s module doc comment).
 *
 * `externalAccountId` is set to the (normalized) phone number: combined with the schema's
 * `@@unique([organizationId, channelType, externalAccountId])`, this means the same phone
 * number can't be registered twice as two different devices within one org — a reasonable
 * guard given one physical SIM belongs to one physical device — while still allowing
 * multiple *different* devices/phone numbers per org (Phase 8 deliverable #7: no "the one
 * device" shortcut).
 */
import { auth } from "@/server/auth";
import { isUniqueConstraintViolation } from "@/server/db";
import { ConflictError, handleRouteError, ValidationError } from "@/server/errors";
import { issueDeviceToken, hashDeviceToken } from "@/server/gateways/androidAuth";
import { normalizePhoneNumber } from "@/server/channels/androidSms/parse";
import { channelAccountRepository } from "@/server/repositories/channelAccountRepository";
import { gatewayRegisterRateLimiter, rateLimitedResponse } from "@/server/rateLimit";
import { requireRole } from "@/server/roles";
import { registerDeviceSchema } from "@/server/validation/androidGateway";

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const rateLimit = gatewayRegisterRateLimiter.check(session!.user.id);
    if (!rateLimit.allowed) {
      return rateLimitedResponse();
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return handleRouteError(new ValidationError("Malformed JSON body."));
    }

    const parsed = registerDeviceSchema.safeParse(body);
    if (!parsed.success) {
      return handleRouteError(new ValidationError("Invalid device registration payload.", parsed.error.flatten()));
    }

    const phoneNumber = normalizePhoneNumber(parsed.data.phoneNumber);

    let channelAccount;
    try {
      channelAccount = await channelAccountRepository.create(organizationId, {
        channelType: "ANDROID_SMS",
        displayName: parsed.data.deviceName,
        externalAccountId: phoneNumber,
        status: "ACTIVE",
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError("A device is already registered for this phone number in this organization.", {
          phoneNumber,
        });
      }
      throw error;
    }

    const token = issueDeviceToken(channelAccount.id);
    await channelAccountRepository.setDeviceTokenHash(organizationId, channelAccount.id, hashDeviceToken(token));

    return Response.json(
      {
        deviceId: channelAccount.id,
        deviceToken: token,
        message: "Store this token securely on the device now — it will not be shown again.",
      },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
