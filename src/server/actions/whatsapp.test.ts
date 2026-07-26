/**
 * Tests for the WhatsApp Server Actions (`getWhatsAppHealthStatus`), per
 * docs/implementation-plan.md §5/Phase 9 task brief deliverable #7. `../auth`'s `auth()` is
 * mocked; no live Graph API call is ever made — `global.fetch` is mocked where relevant.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Explicitly "false" (not just "left unset") — process.env is shared across test FILES in
// this worker (fileParallelism: false), so another file (e.g. the WhatsApp webhook route's
// tests) may have already set WHATSAPP_ENABLED="true" by the time this file's module graph
// evaluates `env.ts` for the first time. Same defensive precedent as
// `src/server/channels/index.test.ts`'s per-case explicit sets.
process.env.WHATSAPP_ENABLED = "false";

vi.mock("../auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("../auth")).auth as unknown as () => Promise<Session | null>;
const { getWhatsAppHealthStatus } = await import("./whatsapp");

function fakeSession(role: Session["user"]["role"]): Session {
  return { user: { id: "u1", organizationId: "org1", role }, expires: "" } as Session;
}

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.unstubAllGlobals();
});

describe("getWhatsAppHealthStatus", () => {
  it("rejects a session below Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT"));
    const result = await getWhatsAppHealthStatus();
    expect(result.ok).toBe(false);
  });

  it("reports enabled:false when WHATSAPP_ENABLED is false (the adapter isn't registered)", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR"));
    const result = await getWhatsAppHealthStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.enabled).toBe(false);
    expect(result.data.healthy).toBe(false);
  });
});
