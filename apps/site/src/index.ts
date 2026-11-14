/**
 * Site Worker (app.<domain>):
 *  - /w.js, /frame.*            widget and try-on flow assets
 *  - /frame                     try-on flow inside brand pages' iframes (embeddable anywhere)
 *  - /t/<slug>/<product>        hosted try-on page (not embeddable)
 *  - /portal, /portal/*         brand portal (single-page app)
 *  - /start, /privacy, /terms   public pages
 *  - /portal-api/*, /api/start  forwarded to the API Worker (same origin: first-party cookies, no CORS)
 */
interface Env {
  ASSETS: Fetcher;
  API: Fetcher;
  API_ORIGIN: string;
  TURNSTILE_SITE_KEY: string;
  ENVIRONMENT: string;
}

const FRAME_RE = /^\/frame\/?$/;
const HOSTED_RE = /^\/t\/[a-z0-9-]{1,60}\/[A-Za-z0-9]{1,40}\/?$/;

const BASE_HEADERS: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function frameCsp(env: Env, embeddable: boolean): string {
  const turnstile = env.TURNSTILE_SITE_KEY === "mock" ? "" : " https://challenges.cloudflare.com";
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${turnstile}`,
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    `img-src 'self' blob: https:${env.ENVIRONMENT === "dev" ? " http://localhost:* http://127.0.0.1:*" : ""}`,
    `connect-src ${env.API_ORIGIN}`,
    `frame-src${turnstile || " 'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${embeddable ? "*" : "'none'"}`,
  ].join("; ");
}

function pageCsp(env: Env, extraScript = ""): string {
  const turnstile = env.TURNSTILE_SITE_KEY === "mock" ? "" : " https://challenges.cloudflare.com";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${turnstile}${extraScript}`,
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    `img-src 'self' data: blob: https:${env.ENVIRONMENT === "dev" ? " http://localhost:* http://127.0.0.1:*" : ""}`,
    "connect-src 'self'",
    `frame-src${turnstile || " 'none'"}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

async function template(req: Request, env: Env, path: string, csp: string, inject: Record<string, string>): Promise<Response> {
  const tpl = await env.ASSETS.fetch(new Request(new URL(path, req.url)));
  let html = await tpl.text();
  html = html.replace(/\/\*GARRAB_CONFIG\*\/.*?\/\*END\*\//, JSON.stringify(inject));
  if (env.TURNSTILE_SITE_KEY !== "mock") {
    html = html.replace("<!--TURNSTILE-->", '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>');
  }
  return new Response(html, {
    headers: {
      ...BASE_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": csp,
      "permissions-policy": "camera=(self), microphone=(), geolocation=()",
    },
  });
}

/** Forward to the API Worker, keeping cookies; the API checks Origin itself. */
function forward(req: Request, env: Env, path: string): Promise<Response> {
  const url = new URL(req.url);
  return env.API.fetch(new Request(`https://api.internal${path}${url.search}`, req));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p.startsWith("/portal-api/")) return forward(req, env, p);
    if (p === "/api/start" && req.method === "POST") return forward(req, env, "/v1/start");
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    const cfg = { api: env.API_ORIGIN, turnstileSiteKey: env.TURNSTILE_SITE_KEY };
    if (FRAME_RE.test(p)) return template(req, env, "/frame.html", frameCsp(env, true), cfg);
    if (HOSTED_RE.test(p)) return template(req, env, "/frame.html", frameCsp(env, false), cfg);
    if (p === "/start" || p === "/") return template(req, env, "/start.html", pageCsp(env), cfg);
    if (p === "/privacy" || p === "/terms") {
      const res = await env.ASSETS.fetch(new Request(new URL(`${p}.html`, req.url)));
      return new Response(res.body, { headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": pageCsp(env) } });
    }
    if (p === "/portal" || (p.startsWith("/portal/") && !p.startsWith("/portal/assets/"))) {
      const res = await env.ASSETS.fetch(new Request(new URL("/portal/index.html", req.url)));
      return new Response(res.body, {
        headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": pageCsp(env) },
      });
    }
    if (p === "/frame.html" || p === "/start.html") return new Response("Not found", { status: 404 });

    const res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(BASE_HEADERS)) out.headers.set(k, v);
    if (p === "/w.js") {
      // Short cache: a widget fix reaches every shop within 5 minutes.
      out.headers.set("cache-control", "public, max-age=300");
      out.headers.set("access-control-allow-origin", "*");
    }
    return out;
  },
} satisfies ExportedHandler<Env>;
