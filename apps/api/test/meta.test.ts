import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { metaLeadBody, sendMetaLead } from "../src/lib/meta.js";

describe("Meta Conversions API (Garrab's own sign-ups)", () => {
  it("hashes email and phone (Egyptian local numbers get the country code) and keeps the shared event ID", async () => {
    const b = (await metaLeadBody({ eventId: "abc-12345", email: "  Owner@Brand.Example ", phone: "0100 911 0001", sourceUrl: "https://app.garrabb.com/start", ip: "192.0.2.1", fbp: "fb.1.1700000000.123" }, 1_700_000_000_000)) as {
      data: { event_name: string; event_id: string; event_time: number; user_data: Record<string, unknown> }[];
    };
    const e = b.data[0]!;
    expect(e).toMatchObject({ event_name: "Lead", event_id: "abc-12345", event_time: 1_700_000_000 });
    const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(e.user_data.em).toEqual([await hex("owner@brand.example")]);
    expect(e.user_data.ph).toEqual([await hex("201009110001")]);
    expect(JSON.stringify(b)).not.toContain("owner@brand");
    expect(e.user_data.fbp).toBe("fb.1.1700000000.123");
  });

  it("sends nothing outside production or without the token", async () => {
    let calls = 0;
    const f = (async () => ((calls++), new Response("{}"))) as unknown as typeof fetch;
    expect(await sendMetaLead({ ...env, ENVIRONMENT: "staging", META_CAPI_TOKEN: "x" }, { eventId: "e-1234567", email: "a@b.example", sourceUrl: "u" }, f)).toBe(false);
    expect(await sendMetaLead({ ...env, ENVIRONMENT: "prod", META_CAPI_TOKEN: "" }, { eventId: "e-1234567", email: "a@b.example", sourceUrl: "u" }, f)).toBe(false);
    expect(calls).toBe(0);
    let sent = "";
    const g = (async (_u: string, init: RequestInit) => ((sent = String(init.body)), new Response("{}"))) as unknown as typeof fetch;
    expect(await sendMetaLead({ ...env, ENVIRONMENT: "prod", META_CAPI_TOKEN: "tok" }, { eventId: "e-1234567", email: "a@b.example", sourceUrl: "u" }, g)).toBe(true);
    expect(JSON.parse(sent).access_token).toBe("tok");
  });
});
