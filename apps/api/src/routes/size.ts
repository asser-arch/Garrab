/**
 * POST /v1/size  JSON: { ctx, product, lang, input }  → { size, alternative, confidence, reasons }
 * Growth plan (a pilot counts as its target plan), clothing with at least two sizes.
 * The shopper's answers live only in this request: never stored, never logged.
 */
import { SizeInput } from "@garrab/shared";
import { PLANS } from "@garrab/shared/plans";
import { langFromPage } from "@garrab/shared/strings";
import { Hono } from "hono";
import { z } from "zod";
import { ctxKey, isLocal, type Env } from "../env.js";
import { verifyCtx } from "../lib/crypto.js";
import { accountFresh, domainAllowed, getSetting, isServing, servableProduct } from "../lib/db.js";
import { log } from "../lib/log.js";
import { bumpCounter, checkCaps, recordUsage } from "../lib/metering.js";
import { appFetch } from "../lib/products.js";
import { adviseSize, GeminiSizer, MockSizer, sizeFinderFits, type Sizer } from "../providers/size.js";

export function sizer(env: Env): Sizer {
  if (env.AI_MOCK === "true" && env.ENVIRONMENT !== "prod") return new MockSizer();
  if (env.GEMINI_API_KEY && env.ENVIRONMENT !== "test") return new GeminiSizer(env.GEMINI_API_KEY, env.GEMINI_TEXT_MODEL ?? "gemini-3.5-flash-lite", appFetch(env));
  if (isLocal(env) || env.ENVIRONMENT === "test") return new MockSizer();
  throw new Error("GEMINI_API_KEY missing");
}

/** The plan whose features apply: a pilot gets the features of the plan it converts to. */
export function featurePlan(a: { plan_id: string; target_plan_id: string | null }): keyof typeof PLANS {
  return (a.plan_id === "pilot" ? (a.target_plan_id ?? "starter") : a.plan_id) as keyof typeof PLANS;
}

const Body = z.object({ ctx: z.string().max(2000), product: z.string().regex(/^[A-Za-z0-9]{1,40}$/), lang: z.string().max(10).optional(), input: SizeInput });

export const size = new Hono<{ Bindings: Env }>();

size.post("/size", async (c) => {
  c.header("Cache-Control", "no-store");
  if ((c.req.header("origin") ?? "") !== c.env.APP_ORIGIN) return c.json({ error: "forbidden_origin" }, 403);
  c.header("Access-Control-Allow-Origin", c.env.APP_ORIGIN);
  c.header("Vary", "Origin");
  const body = Body.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "bad_request" }, 400); // never echo the shopper's answers
  const claims = await verifyCtx(ctxKey(c.env), body.data.ctx);
  if (!claims) return c.json({ error: "session_expired" }, 401);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (c.env.RL_TRYON_IP && !(await c.env.RL_TRYON_IP.limit({ key: `size:${ip}` })).success) return c.json({ error: "rate_limited" }, 429);

  if (await getSetting(c.env, "global_kill", false)) return c.json({ error: "unavailable" }, 503);
  const account = await accountFresh(c.env, claims.a);
  if (!account || !isServing(account.status)) return c.json({ error: "unavailable" }, 403);
  if (claims.o !== "hosted" && !(await domainAllowed(c.env, account.id, claims.o))) return c.json({ error: "unavailable" }, 403);
  const plan = await c.env.DB.prepare("SELECT plan_id, target_plan_id FROM accounts WHERE id = ?").bind(account.id).first<{ plan_id: string; target_plan_id: string | null }>();
  if (!plan || !PLANS[featurePlan(plan)].sizeFinder) return c.json({ error: "not_supported" }, 403);

  const p = await servableProduct(c.env, account.id, body.data.product);
  if (!p) return c.json({ error: "product_unavailable" }, 404);
  const sizes = JSON.parse(p.sizes_json ?? "[]") as string[];
  if (!sizeFinderFits(p.kind, sizes)) return c.json({ error: "not_supported" }, 422);
  if ((await checkCaps(c.env, account)) !== "ok") return c.json({ error: "unavailable" }, 503);

  const s = sizer(c.env);
  const { answer, costMicroUsd } = await adviseSize(
    s,
    body.data.input,
    { title: p.title, description: p.description ?? "", sizes, imageUrl: (JSON.parse(p.images_json) as string[])[0] ?? null },
    langFromPage(body.data.lang),
  );
  await recordUsage(c.env, account.id, "size", s.name, true, costMicroUsd, answer.source === "rules" ? "rules_fallback" : null);
  await bumpCounter(c.env, account.id, "size_completed");
  await bumpCounter(c.env, account.id, `size_completed@${p.id}`);
  log("size_ok", { route: "size", account: account.id, kind: answer.source });
  return c.json({ size: answer.size, alternative: answer.alternative, confidence: answer.confidence, reasons: answer.reasons });
});
