import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotConfiguredError } from "../errors";
import { ChannelAdapterRegistry } from "./registry";
import type { MessagingChannelAdapter } from "./types";

function makeAdapter(channelType: MessagingChannelAdapter["channelType"]): MessagingChannelAdapter {
  return {
    channelType,
    async sendMessage() {
      return { externalMessageId: "id", status: "SENT" as const };
    },
    async healthCheck() {
      return { healthy: true };
    },
  };
}

describe("ChannelAdapterRegistry", () => {
  let registry: ChannelAdapterRegistry;

  beforeEach(() => {
    registry = new ChannelAdapterRegistry();
  });

  it("registers and retrieves an adapter by channel type", () => {
    const adapter = makeAdapter("TELEGRAM");
    registry.register(adapter);
    expect(registry.get("TELEGRAM")).toBe(adapter);
    expect(registry.has("TELEGRAM")).toBe(true);
  });

  it("returns undefined for an unregistered channel type via get()", () => {
    expect(registry.get("WHATSAPP")).toBeUndefined();
    expect(registry.has("WHATSAPP")).toBe(false);
  });

  it("throws NotConfiguredError via getOrThrow() for an unregistered channel type", () => {
    expect(() => registry.getOrThrow("WHATSAPP")).toThrow(NotConfiguredError);
  });

  it("throws ConflictError when registering the same channel type twice", () => {
    registry.register(makeAdapter("TELEGRAM"));
    expect(() => registry.register(makeAdapter("TELEGRAM"))).toThrow(ConflictError);
  });

  it("registerOverride replaces an existing registration without throwing (test-only escape hatch)", () => {
    const first = makeAdapter("TELEGRAM");
    const second = makeAdapter("TELEGRAM");
    registry.register(first);
    registry.registerOverride(second);
    expect(registry.get("TELEGRAM")).toBe(second);
  });

  it("lists every registered adapter", () => {
    const telegram = makeAdapter("TELEGRAM");
    const whatsapp = makeAdapter("WHATSAPP");
    registry.register(telegram);
    registry.register(whatsapp);
    expect(registry.list()).toEqual(expect.arrayContaining([telegram, whatsapp]));
    expect(registry.list()).toHaveLength(2);
  });

  it("unregister and clear remove registrations", () => {
    registry.register(makeAdapter("TELEGRAM"));
    registry.register(makeAdapter("WHATSAPP"));
    registry.unregister("TELEGRAM");
    expect(registry.has("TELEGRAM")).toBe(false);
    expect(registry.has("WHATSAPP")).toBe(true);
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });
});
