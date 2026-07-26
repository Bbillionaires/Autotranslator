/**
 * Shared Android gateway device-registration logic, used by BOTH `POST
 * /api/gateways/register` (the original Route Handler, called by a scripted/API client)
 * and the new `registerAndroidDevice` Server Action (`src/server/actions/android.ts`, added
 * for H6/M5 — docs/review-report.md — so the Settings UI has an entry point too). Extracted
 * here so the two entry points don't duplicate the create-account + issue-token sequence.
 */
import { isUniqueConstraintViolation } from "../db";
import { ConflictError } from "../errors";
import { hashDeviceToken, issueDeviceToken } from "./androidAuth";
import { normalizePhoneNumber } from "../channels/androidSms/parse";
import { channelAccountRepository } from "../repositories/channelAccountRepository";

export interface RegisterAndroidDeviceInput {
  deviceName: string;
  phoneNumber: string;
}

export interface RegisterAndroidDeviceResult {
  deviceId: string;
  deviceToken: string;
}

/**
 * Creates the `ChannelAccount` (`channelType: "ANDROID_SMS"`) and issues its signed device
 * token, persisting only the token's sha256 hash (see `androidAuth.ts`'s module doc
 * comment). Returns the raw token exactly once — callers must surface it to the operator
 * immediately, it is never recoverable afterward.
 */
export async function registerAndroidDevice(
  organizationId: string,
  input: RegisterAndroidDeviceInput,
): Promise<RegisterAndroidDeviceResult> {
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);

  let channelAccount;
  try {
    channelAccount = await channelAccountRepository.create(organizationId, {
      channelType: "ANDROID_SMS",
      displayName: input.deviceName,
      externalAccountId: phoneNumber,
      status: "ACTIVE",
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new ConflictError("A device is already registered for this phone number in this organization.", { phoneNumber });
    }
    throw error;
  }

  const token = issueDeviceToken(channelAccount.id);
  await channelAccountRepository.setDeviceTokenHash(organizationId, channelAccount.id, hashDeviceToken(token));

  return { deviceId: channelAccount.id, deviceToken: token };
}
