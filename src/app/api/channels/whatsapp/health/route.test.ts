/**
 * Route-handler-level tests for `GET /api/channels/whatsapp/health` — Session+Role
 * (Administrator+) guarded, per docs/implementation-plan.md §5. Exact same shape as
 * `src/app/api/channels/telegram/health/route.test.ts` — see that file for the precedent
 * this mirrors. `auth()` is mocked; `channelAdapterRegistry.get` is spied on so no real
 * Graph API call is ever made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/server/auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("@/server/auth")).auth as unknown as () => Promise<Session | null>;
const { channelAdapterRegistry } = await import("@/server/channels");
const { GET } = await import("./route");

function fakeSession(role: Session["user"]["role"]): Session {
  return { user: { id: "u1", organizationId: "org1", role }, expires: "" } as Session;
}

describe("GET /api/channels/whatsapp/health", () => {
  beforeEach(() => {
    vi.mocked(auth).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a 403 error when the session role is below Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT"));
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns a 403 error when there is no session at all", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns enabled:false when WhatsApp is not registered (WHATSAPP_ENABLED=false)", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR"));
    vi.spyOn(channelAdapterRegistry, "get").mockReturnValue(undefined);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; healthy: boolean };
    expect(body.enabled).toBe(false);
    expect(body.healthy).toBe(false);
  });

  it("returns 200 with healthy:true when adapter.healthCheck() succeeds", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR"));
    vi.spyOn(channelAdapterRegistry, "get").mockReturnValue({
      channelType: "WHATSAPP",
      sendMessage: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, detail: "+1 555 000 1111" }),
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; healthy: boolean; detail?: string };
    expect(body).toEqual({ enabled: true, healthy: true, detail: "+1 555 000 1111" });
  });

  it("returns 503 when adapter.healthCheck() reports unhealthy", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR"));
    vi.spyOn(channelAdapterRegistry, "get").mockReturnValue({
      channelType: "WHATSAPP",
      sendMessage: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ healthy: false, detail: "invalid token" }),
    });

    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { healthy: boolean; detail?: string };
    expect(body.healthy).toBe(false);
    expect(body.detail).toBe("invalid token");
  });
});
