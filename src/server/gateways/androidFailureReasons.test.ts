import { describe, expect, it } from "vitest";
import { isTransientFailureReason, toGatewayFailureError } from "./androidFailureReasons";
import { UpstreamAdapterError } from "../errors";

describe("isTransientFailureReason", () => {
  it("classifies NO_SIGNAL, SIM_ERROR, and UNKNOWN as transient", () => {
    expect(isTransientFailureReason("NO_SIGNAL")).toBe(true);
    expect(isTransientFailureReason("SIM_ERROR")).toBe(true);
    expect(isTransientFailureReason("UNKNOWN")).toBe(true);
  });

  it("classifies INVALID_NUMBER as permanent", () => {
    expect(isTransientFailureReason("INVALID_NUMBER")).toBe(false);
  });
});

describe("toGatewayFailureError", () => {
  it("builds an UpstreamAdapterError with detail.transient matching the reason's classification", () => {
    const transientError = toGatewayFailureError("NO_SIGNAL");
    expect(transientError).toBeInstanceOf(UpstreamAdapterError);
    expect((transientError.detail as { transient: boolean }).transient).toBe(true);

    const permanentError = toGatewayFailureError("INVALID_NUMBER");
    expect((permanentError.detail as { transient: boolean }).transient).toBe(false);
  });
});
