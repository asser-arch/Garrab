import { Hono } from "hono";
import type { Env } from "./env.js";
import { log } from "./lib/log.js";
import { handleQueue, runScheduled } from "./jobs.js";
import type { Job } from "./jobs-types.js";
import { admin } from "./routes/admin.js";
import { portal } from "./routes/portal.js";
import { start } from "./routes/start.js";
import { pay } from "./routes/pay.js";
import { tryon } from "./routes/tryon.js";
import { webhooks } from "./routes/webhooks.js";
import { widget } from "./routes/widget.js";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
});

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
