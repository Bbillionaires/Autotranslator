/**
 * `ChannelAdapterRegistry`, per docs/implementation-plan.md §3.2.
 *
 * Maps `ChannelType -> MessagingChannelAdapter`. Built once at boot (see ./index.ts) from
 * parsed env: each real adapter self-registers only if its `*_ENABLED` flag (or, for
 * Telegram, presence of required config) says so. Route Handlers for webhooks look up the
 * adapter by channel type and delegate — they never talk to Telegram/Meta/the device HTTP
 * APIs directly.
 *
 * Phase 5 wires this mechanism only; no real adapter is registered yet (see ./index.ts).
 */
import type { ChannelType } from "@prisma/client";
import { ConflictError, NotConfiguredError } from "../errors";
import type { MessagingChannelAdapter } from "./types";

export class ChannelAdapterRegistry {
  private readonly adapters = new Map<ChannelType, MessagingChannelAdapter>();

  /**
   * Registers an adapter for its `channelType`. Throws if an adapter for that channel type
   * is already registered — each channel type should be wired exactly once at boot.
   */
  register(adapter: MessagingChannelAdapter): void {
    if (this.adapters.has(adapter.channelType)) {
      throw new ConflictError(`An adapter for channel type ${adapter.channelType} is already registered.`, {
        channelType: adapter.channelType,
      });
    }
    this.adapters.set(adapter.channelType, adapter);
  }

  /** Replaces any existing registration for this channel type. Intended for tests only. */
  registerOverride(adapter: MessagingChannelAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
  }

  unregister(channelType: ChannelType): void {
    this.adapters.delete(channelType);
  }

  has(channelType: ChannelType): boolean {
    return this.adapters.has(channelType);
  }

  get(channelType: ChannelType): MessagingChannelAdapter | undefined {
    return this.adapters.get(channelType);
  }

  /** Use when the caller requires the adapter to exist (e.g. a webhook route for a channel that must be enabled). */
  getOrThrow(channelType: ChannelType): MessagingChannelAdapter {
    const adapter = this.adapters.get(channelType);
    if (!adapter) {
      throw new NotConfiguredError(`No adapter is registered for channel type ${channelType}.`, {
        channelType,
      });
    }
    return adapter;
  }

  list(): MessagingChannelAdapter[] {
    return [...this.adapters.values()];
  }

  /** Test-only helper: clears every registration so tests don't leak adapters across cases. */
  clear(): void {
    this.adapters.clear();
  }
}

/**
 * Process-wide registry instance. Phases 6/8/9 populate it at boot (see ./index.ts);
 * nothing is registered here directly so importing this module has no side effects.
 */
export const channelAdapterRegistry = new ChannelAdapterRegistry();
