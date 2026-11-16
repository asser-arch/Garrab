/**
 * Size finder: the 30-case evaluation harness (Phase 4) plus the API rules.
 * Each case is a product + a shopper + what the AI said (or null = AI failed) → what the shopper must see.
 * The code rules decide what is shown, so these cases pin the behaviour whatever the model does.
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseSizes } from "../src/routes/portal.js";
import { adviseSize, checkAnswer, orderSizes, ruleSize, sizeFinderFits, usualIndex, type SizeQuestion, type Sizer } from "../src/providers/size.js";
import { APP, getConfig, seedAccount } from "./helpers.js";

const LETTERS = ["S", "M", "L", "XL"];
const q = (o: Partial<SizeQuestion> = {}): SizeQuestion => ({ heightCm: 165, weightKg: 62, usualSize: "M", bodyType: "average", prefer: "regular", ...o });
const prod = (sizes: string[] = LETTERS) => ({ title: "Linen abaya", description: "Relaxed cut, falls to the ankle.", sizes, imageUrl: null });
const ai = (size: string, alt: string | null = null, reasons: string[] = ["Fits your usual size.", "The cut is relaxed."], confidence = "medium") => ({
  recommended_size: size,
  alternative_size: alt,
  confidence,
  reasons,
});
const fixed = (raw: unknown): Sizer => ({ name: "fixed", advise: async () => ({ raw, costMicroUsd: 1 }) });

type Case = [name: string, sizes: string[], shopper: Partial<SizeQuestion>, said: unknown, expected: { size: string; alt?: string | null; confidence?: "medium" | "low"; source: "ai" | "rules" }];

const CASES: Case[] = [
  // The AI's answer is shown when it follows the rules
  ["1 AI picks the usual size", LETTERS, {}, ai("M"), { size: "M", alt: null, confidence: "medium", source: "ai" }],
  ["2 AI sizes up one for a slim cut", LETTERS, {}, ai("L", "M"), { size: "L", alt: "M", source: "ai" }],
  ["3 AI sizes down one for an oversized cut", LETTERS, { usualSize: "L" }, ai("M"), { size: "M", source: "ai" }],
  ["4 AI answer in lower case is matched to the brand's label", LETTERS, {}, ai("m"), { size: "M", source: "ai" }],
  ["5 numeric sizes", ["36", "38", "40", "42", "44"], { usualSize: "40" }, ai("40", "42"), { size: "40", alt: "42", source: "ai" }],
  ["6 two sizes away is allowed, with low confidence", LETTERS, { usualSize: "S" }, ai("L"), { size: "L", confidence: "low", source: "ai" }],
  ["7 no weight → low confidence", LETTERS, { weightKg: null }, ai("M"), { size: "M", confidence: "low", source: "ai" }],
  ["8 AI says low → stays low", LETTERS, {}, ai("M", null, undefined, "low"), { size: "M", confidence: "low", source: "ai" }],
  ["9 AI 'high' is never shown as high", LETTERS, {}, ai("M", null, undefined, "high"), { size: "M", confidence: "medium", source: "ai" }],
  ["10 2XL alias matches XXL", ["L", "XL", "XXL", "3XL"], { usualSize: "XL" }, ai("2XL"), { size: "XXL", source: "ai" }],
  ["11 Arabic reasons pass through", LETTERS, {}, ai("M", null, ["مقاسك المعتاد مناسب.", "القصّة واسعة."]), { size: "M", source: "ai" }],
  // The AI's answer is corrected or replaced when it breaks a rule
  ["12 non-adjacent alternative is dropped", LETTERS, {}, ai("M", "XL"), { size: "M", alt: null, source: "ai" }],
  ["13 alternative equal to the size is dropped", LETTERS, {}, ai("M", "M"), { size: "M", alt: null, source: "ai" }],
  ["14 alternative not sold is dropped", LETTERS, {}, ai("M", "XS"), { size: "M", alt: null, source: "ai" }],
  ["15 a size the brand doesn't sell → rules", LETTERS, {}, ai("XXL"), { size: "M", source: "rules" }],
  ["16 three sizes away → rules", LETTERS, { usualSize: "S" }, ai("XL"), { size: "S", source: "rules" }],
  ["17 only one reason → rules", LETTERS, {}, ai("M", null, ["Just one."]), { size: "M", source: "rules" }],
  ["18 empty reasons → rules", LETTERS, {}, ai("M", null, ["", "  "]), { size: "M", source: "rules" }],
  ["19 garbage answer → rules", LETTERS, {}, { hello: "world" }, { size: "M", source: "rules" }],
  ["20 AI failed (null) → rules", LETTERS, {}, null, { size: "M", source: "rules" }],
  ["21 AI returned a number, not a label → rules", LETTERS, {}, { ...ai("M"), recommended_size: 3 }, { size: "M", source: "rules" }],
  // The rule answer (fallback) on its own
  ["22 rules: loose fit → next size up as the alternative", LETTERS, { prefer: "loose" }, null, { size: "M", alt: "L", source: "rules" }],
  ["23 rules: fitted → no alternative", LETTERS, { prefer: "fitted" }, null, { size: "M", alt: null, source: "rules" }],
  ["24 rules: curvy → next size up as the alternative", LETTERS, { bodyType: "curvy" }, null, { size: "M", alt: "L", source: "rules" }],
  ["25 rules: largest size has no size up", LETTERS, { usualSize: "XL", prefer: "loose" }, null, { size: "XL", alt: null, source: "rules" }],
  ["26 rules: usual size not sold → nearest, low", ["S", "M", "L"], { usualSize: "XL" }, null, { size: "L", confidence: "low", source: "rules" }],
  ["27 rules: usual size unrelated → middle size, low", LETTERS, { usualSize: "Free" }, null, { size: "M", alt: null, confidence: "low", source: "rules" }],
  ["28 rules: numeric usual against numeric sizes", ["38", "40", "42"], { usualSize: "41" }, null, { size: "40", confidence: "low", source: "rules" }],
  ["29 rules: sizes listed out of order are sorted", ["XL", "S", "L", "M"], { usualSize: "M", prefer: "loose" }, null, { size: "M", alt: "L", source: "rules" }],
  ["30 rules: exact size with weight → medium", LETTERS, {}, null, { size: "M", confidence: "medium", source: "rules" }],
];

describe("size finder: 30-case evaluation harness", () => {
  it("has exactly 30 cases", () => expect(CASES).toHaveLength(30));
  for (const [name, sizes, shopper, said, want] of CASES) {
    it(name, async () => {
      const { answer } = await adviseSize(fixed(said), q(shopper), prod(sizes), "en");
      expect(answer.size).toBe(want.size);
      expect(answer.source).toBe(want.source);
      if (want.alt !== undefined) expect(answer.alternative).toBe(want.alt);
      if (want.confidence) expect(answer.confidence).toBe(want.confidence);
      expect(answer.confidence).not.toBe("high");
      expect(answer.reasons).toHaveLength(2);
      expect(orderSizes(sizes).map((s) => s.toUpperCase())).toContain(answer.size.toUpperCase());
    });
  }
});

describe("size helpers", () => {
  it("orders letter and numeric sizes", () => {
    expect(orderSizes(["XL", "s", "M", "2XS"])).toEqual(["2XS", "s", "M", "XL"]);
    expect(orderSizes(["44", "38", "40"])).toEqual(["38", "40", "44"]);
  });
  it("finds the usual size or the nearest", () => {
    expect(usualIndex(["S", "M", "L"], "m")).toBe(1);
    expect(usualIndex(["S", "M", "L"], "XL")).toBe(2);
    expect(usualIndex(["S", "M", "L"], "Free")).toBe(-1);
  });
  it("is offered only for clothing with two or more real sizes", () => {
    expect(sizeFinderFits("clothing", ["S", "M"])).toBe(true);
    expect(sizeFinderFits("clothing", ["One size"])).toBe(false);
    expect(sizeFinderFits("clothing", [])).toBe(false);
    expect(sizeFinderFits("accessory", ["S", "M"])).toBe(false);
    expect(sizeFinderFits("decor", ["S", "M"])).toBe(false);
  });
  it("parses the sizes a brand types", () => {
    expect(parseSizes("S, M, L, XL")).toEqual(["S", "M", "L", "XL"]);
    expect(parseSizes("S M L")).toEqual(["S", "M", "L"]);
    expect(parseSizes("38/40/42")).toEqual(["38", "40", "42"]);
    expect(parseSizes("S، M، L")).toEqual(["S", "M", "L"]);
    expect(parseSizes("One size")).toEqual(["One size"]);
    expect(parseSizes(undefined)).toEqual([]);
  });
  it("Arabic fallback reasons are in Arabic", () => {
    const r = ruleSize(q(), prod(), "ar");
    expect(r.reasons[0]).toMatch(/[؀-ۿ]/);
  });
  it("Arabic answers use our fixed sentences, whatever the model wrote", async () => {
    const { answer } = await adviseSize(fixed(ai("L", "XL", ["broken text", "more"])), q(), prod(), "ar");
    expect(answer.source).toBe("ai");
    expect(answer.size).toBe("L");
    expect(answer.reasons).toEqual(["L أكبر بدرجة من مقاسك المعتاد، بناءً على قصّة القطعة ووصفها.", "إذا كنت بين مقاسين، فجرّب XL أيضًا."]);
  });

  it("checkAnswer never invents a size", () => {
    expect(checkAnswer(ai("XXXL"), q(), prod())).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------- API

const post = (body: unknown, origin = APP) =>
  exports.default.fetch("https://api.test/v1/size", { method: "POST", headers: { origin, "content-type": "text/plain" }, body: JSON.stringify(body) });
const answers = { heightCm: 168, weightKg: 64, usualSize: "M", bodyType: "average", prefer: "regular" };

async function withSizes(s: { accountId: string; productId: string }, sizes: string[], kind = "clothing") {
  await env.DB.prepare("UPDATE products SET sizes_json = ?, kind = ? WHERE id = ?").bind(JSON.stringify(sizes), kind, s.productId).run();
}

describe("POST /v1/size", () => {
  it("Growth: answers with a size the brand sells, counts it, and stores none of the shopper's answers", async () => {
    const s = await seedAccount({ plan: "growth" });
    await withSizes(s, ["S", "M", "L", "XL"]);
    const ctx = (await getConfig(s)).body.ctx as string;
    const r = await post({ ctx, product: s.productId, lang: "ar", input: answers });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { size: string; reasons: string[]; confidence: string };
    expect(j.size).toBe("M");
    expect(j.reasons).toHaveLength(2);
    expect(j.reasons[0]).toMatch(/[؀-ۿ]/);
    const counters = await env.DB.prepare("SELECT metric FROM daily_counters WHERE account_id = ?").bind(s.accountId).all<{ metric: string }>();
    expect(counters.results.map((x) => x.metric)).toEqual(expect.arrayContaining(["size_completed", `size_completed@${s.productId}`]));
    // Nothing the shopper typed is kept anywhere.
    for (const t of ["usage_events", "daily_counters", "audit_log", "notifications"]) {
      const dump = JSON.stringify((await env.DB.prepare(`SELECT * FROM ${t}`).all()).results);
      expect(dump, t).not.toContain("168");
    }
  });

  it("a pilot heading to Growth gets it; Starter (and pilots heading to Starter) do not", async () => {
    const g = await seedAccount({ plan: "growth" });
    await env.DB.prepare("UPDATE accounts SET plan_id = 'pilot', target_plan_id = 'growth' WHERE id = ?").bind(g.accountId).run();
    await withSizes(g, ["S", "M", "L"]);
    expect((await post({ ctx: (await getConfig(g)).body.ctx, product: g.productId, input: answers })).status).toBe(200);

    const st = await seedAccount({ plan: "starter" });
    await withSizes(st, ["S", "M", "L"]);
    const r = await post({ ctx: (await getConfig(st)).body.ctx, product: st.productId, input: answers });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "not_supported" });
  });

  it("not offered for accessories or one-size pieces; bad input is refused without echoing it", async () => {
    const s = await seedAccount({ plan: "growth" });
    const ctx = (await getConfig(s)).body.ctx as string;
    await withSizes(s, ["One size"]);
    expect((await post({ ctx, product: s.productId, input: answers })).status).toBe(422);
    await withSizes(s, ["S", "M"], "accessory");
    expect((await post({ ctx, product: s.productId, input: answers })).status).toBe(422);
    const bad = await post({ ctx, product: s.productId, input: { ...answers, heightCm: 9999 } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("9999");
    expect((await post({ ctx, product: s.productId, input: answers }, "https://evil.example")).status).toBe(403);
  });

  it("frame-info tells the try-on window whether to show 'Find my size'", async () => {
    const s = await seedAccount({ plan: "growth" });
    await withSizes(s, ["S", "M", "L"]);
    const ctx = (await getConfig(s)).body.ctx as string;
    const info = (await (await exports.default.fetch(`https://api.test/v1/frame-info?ctx=${encodeURIComponent(ctx)}&p=${s.productId}`)).json()) as { sizeFinder: boolean };
    expect(info.sizeFinder).toBe(true);
    await withSizes(s, []);
    const none = (await (await exports.default.fetch(`https://api.test/v1/frame-info?ctx=${encodeURIComponent(ctx)}&p=${s.productId}`)).json()) as { sizeFinder: boolean };
    expect(none.sizeFinder).toBe(false);
  });
});
