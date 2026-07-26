import { describe, expect, it } from "vitest";
import { UpstreamAdapterError } from "../errors";
import { classifyAdapterFailure } from "./failureClassifier";

describe("classifyAdapterFailure", () => {
  it("classifies as transient when the error explicitly says so via detail.transient", () => {
    const error = new UpstreamAdapterError("timeout", { transient: true });
    expect(classifyAdapterFailure(error)).toBe("transient");
  });

  it("classifies as permanent when the error explicitly says so via detail.transient", () => {
    const error = new UpstreamAdapterError("invalid recipient", { transient: false });
    expect(classifyAdapterFailure(error)).toBe("permanent");
  });

  it("classifies a 429 (rate limit) status as transient", () => {
    expect(classifyAdapterFailure(new UpstreamAdapterError("rate limited", { status: 429 }))).toBe("transient");
  });

  it("classifies a 5xx status as transient", () => {
    expect(classifyAdapterFailure(new UpstreamAdapterError("upstream error", { status: 503 }))).toBe("transient");
  });

  it("classifies a 4xx (non-429) status as permanent", () => {
    expect(classifyAdapterFailure(new UpstreamAdapterError("bad request", { status: 400 }))).toBe("permanent");
    expect(classifyAdapterFailure(new UpstreamAdapterError("forbidden", { status: 403 }))).toBe("permanent");
    expect(classifyAdapterFailure(new UpstreamAdapterError("not found", { status: 404 }))).toBe("permanent");
  });

  it("falls back to a bare `status` property on a plain error-like object", () => {
    expect(classifyAdapterFailure({ status: 500 })).toBe("transient");
    expect(classifyAdapterFailure({ status: 400 })).toBe("permanent");
  });

  it("defaults to transient for an unrecognized error shape", () => {
    expect(classifyAdapterFailure(new Error("something weird"))).toBe("transient");
    expect(classifyAdapterFailure("a string error")).toBe("transient");
    expect(classifyAdapterFailure(undefined)).toBe("transient");
  });
});
