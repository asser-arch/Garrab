import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendOnce } from "../src/lib/email.js";
import { sendDigest } from "../src/ops/digest.js";

/**
 * 26 Nov 2026: staging and live both sent the daily digest through the same Resend account with the same
 * idempotency key ("digest:<day>") but different content, so Resend refused the second one (HTTP 409).
 */
describe("email idempotency keys", () => {
  afterEach(() => vi.restoreAllMocks());

  it("differ per environment and per content; staging subjects are labelled", async () => {
    const seen: { key: string; subject: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      const h = new Headers(init?.headers);
      seen.push({ key: h.get("Idempotency-Key") ?? "", subject: (JSON.parse(String(init?.body)) as { subject: string }).subject });
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    });
    const msg = (html: string) => ({ to: "op@garrab.example", subject: "Garrab digest", html, text: html });
    const day = `k-${Date.now()}`;
    await sendOnce({ ...env, ENVIRONMENT: "prod", RESEND_API_KEY: "re_x" }, { accountId: null, template: "digest", dedupeKey: `digest:${day}:p`, msg: msg("live") });
    await sendOnce({ ...env, ENVIRONMENT: "staging", RESEND_API_KEY: "re_x" }, { accountId: null, template: "digest", dedupeKey: `digest:${day}:s`, msg: msg("staging") });
    expect(seen[0]!.key).toMatch(/^prod:digest:/);
    expect(seen[1]!.key).toMatch(/^staging:digest:/);
    expect(seen[0]!.subject).toBe("Garrab digest");
    expect(seen[1]!.subject).toBe("[Staging] Garrab digest");
  });

  it("staging doesn't send the daily digest at all", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await sendDigest({ ...env, ENVIRONMENT: "staging", RESEND_API_KEY: "re_x", OPERATOR_EMAIL: "op@garrab.example" }, new Date());
    expect(spy).not.toHaveBeenCalled();
  });
});
