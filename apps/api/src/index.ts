import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PRODUCT_PHOTO_MAX_BYTES } from "./routes/portal.js";
import type { Env } from "./env.js";
import { log } from "./lib/log.js";
import { handleQueue, runScheduled } from "./jobs.js";
import type { Job } from "./jobs-types.js";
import { admin } from "./routes/admin.js";
import { portal } from "./routes/portal.js";
import { start } from "./routes/start.js";
import { pay } from "./routes/pay.js";
import { size } from "./routes/size.js";
import { tryon } from "./routes/tryon.js";
import { webhooks } from "./routes/webhooks.js";
import { widget } from "./routes/widget.js";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
});

// Request size limits (brief §10). /v1/tryon checks its own (8 MB photo) before parsing.
const tooLarge = { onError: (c: import("hono").Context) => c.json({ error: "too_large" }, 413) };
const uploadLimit = bodyLimit({ maxSize: PRODUCT_PHOTO_MAX_BYTES + 64 * 1024, ...tooLarge });
const portalLimit = bodyLimit({ maxSize: 256 * 1024, ...tooLarge });
app.use("/portal-api/*", (c, next) => (c.req.path === "/portal-api/products/upload" ? uploadLimit(c, next) : portalLimit(c, next)));
const smallLimit = bodyLimit({ maxSize: 64 * 1024, ...tooLarge });
// Admin: small bodies, except adding product photos for a brand.
app.use("/admin-api/*", (c, next) => (/^\/admin-api\/accounts\/[^/]+\/products\/upload$/.test(c.req.path) ? uploadLimit(c, next) : smallLimit(c, next)));
for (const path of ["/webhooks/*", "/v1/start", "/v1/events", "/v1/pay/*"]) {
  app.use(path, smallLimit);
}

app.get("/healthz", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, env: c.env.ENVIRONMENT });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

app.route("/v1", widget);
app.route("/v1", tryon);
app.route("/v1", size);
app.route("/v1", start);
app.route("/v1", pay);
app.route("/webhooks", webhooks);
app.route("/portal-api", portal);
app.route("/admin-api", admin);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((_err, c) => {
  // Never log the error object: it could carry request data.
  log("unhandled_error", { route: c.req.path.slice(0, 40) });
  return c.json({ error: "internal" }, 500);
});

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, new Date(controller.scheduledTime)));
  },
  async queue(batch, env) {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env, Job>;

export { app };
