import { Hono } from "hono";
import type { Env } from "./env.js";
import { log } from "./lib/log.js";
import { runScheduled } from "./jobs.js";
import { tryon } from "./routes/tryon.js";
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
} satisfies ExportedHandler<Env>;

export { app };
