/**
 * Site Worker (app.<domain>):
 *  - /w.js, /frame.*            widget and try-on flow assets
 *  - /frame                     try-on flow inside brand pages' iframes (embeddable anywhere)
 *  - /t/<slug>/<product>        hosted try-on page (not embeddable)
 *  - /t/<slug>                  brand page listing those products (the Instagram bio link)
 *  - /portal, /portal/*         brand portal (single-page app)
 *  - /start, /privacy, /terms   public pages
 *  - garrabb.com (LANDING_HOST)  landing page (EN /, AR /ar), robots.txt, sitemap.xml, llms.txt; www redirects there
 *  - /portal-api/*, /api/start  forwarded to the API Worker (same origin: first-party cookies, no CORS)
 */
interface Env {
  ASSETS: Fetcher;
  API: Fetcher;
  API_ORIGIN: string;
  TURNSTILE_SITE_KEY: string;
  ENVIRONMENT: string;
  /** Canonical host (app.<domain>). The apex and www redirect here; cdn.<domain> serves only the widget. */
  APP_HOST?: string;
  /** Marketing host (prod: garrabb.com): serves the landing page, robots, sitemap, llms.txt. www redirects here.
   *  Unset (dev, staging): the landing page is served on the app host instead, marked noindex. */
  LANDING_HOST?: string;
  /** Local dev only: reach the API over HTTP (local service bindings between wrangler processes are flaky). */
  API_DEV_URL?: string;
}

const FRAME_RE = /^\/frame\/?$/;
const HOSTED_RE = /^\/t\/[a-z0-9-]{1,60}(\/[A-Za-z0-9]{1,40})?\/?$/;

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

// ---------------------------------------------------------------- landing page (garrabb.com)

const LANDING_PAGES: Record<string, string> = { "/": "/landing.html", "/ar": "/landing-ar.html", "/ar/": "/landing-ar.html" };
const LANDING_FILES = new Set([
  "/landing.css", "/robots.txt", "/sitemap.xml", "/llms.txt", "/og-en.png", "/og-ar.png",
  "/favicon.ico", "/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png", "/email-logo.png", "/email-logo-dark.png",
]);

async function landingPage(req: Request, env: Env, file: string, indexable: boolean): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL(file, req.url)));
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=300",
    "content-security-policy": pageCsp(env),
    // Keep the referrer for outbound links from marketing pages (WhatsApp, the app) — still nothing sensitive here.
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  if (!indexable) headers["x-robots-tag"] = "noindex"; // staging/dev copies must never compete with garrabb.com
  return new Response(res.body, { headers });
}

async function landingFile(req: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(BASE_HEADERS)) out.headers.set(k, v);
  out.headers.set("cache-control", "public, max-age=3600");
  if (new URL(req.url).pathname.endsWith(".txt")) out.headers.set("content-type", "text/plain; charset=utf-8");
  return out;
}

/** robots.txt on the app host: public pages yes; brand portal, payments and the try-on internals no. */
function appRobots(env: Env): Response {
  const body =
    env.ENVIRONMENT === "prod"
      ? [
          "User-agent: *",
          "Allow: /start",
          "Allow: /privacy",
          "Allow: /terms",
          "Disallow: /portal",
          "Disallow: /portal-api/",
          "Disallow: /pay",
          "Disallow: /pay-api/",
          "Disallow: /frame",
          "Disallow: /api/",
          "Disallow: /pi/",
          "Disallow: /bl/",
          "",
          `Sitemap: https://${env.LANDING_HOST ?? "garrabb.com"}/sitemap.xml`,
        ].join("\n")
      : "User-agent: *\nDisallow: /"; // staging and dev: never indexed
  return new Response(`${body}\n`, { headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}

/** Forward to the API Worker, keeping cookies; the API checks Origin itself. */
function forward(req: Request, env: Env, path: string): Promise<Response> {
  const url = new URL(req.url);
  if (env.ENVIRONMENT === "dev" && env.API_DEV_URL) return fetch(new Request(`${env.API_DEV_URL}${path}${url.search}`, req));
  return env.API.fetch(new Request(`https://api.internal${path}${url.search}`, req));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // Marketing site: garrabb.com (www redirects to it). Only the landing files live there; anything
    // else (/start, /portal, /privacy…) goes to the app host.
    const landing = env.LANDING_HOST;
    if (landing && url.hostname === `www.${landing}`) return Response.redirect(`https://${landing}${p}${url.search}`, 301);
    if (landing && url.hostname === landing) {
      if (LANDING_PAGES[p]) return landingPage(req, env, LANDING_PAGES[p], true);
      if (LANDING_FILES.has(p)) return landingFile(req, env);
      return Response.redirect(`https://${env.APP_HOST ?? landing}${p}${url.search}`, 301);
    }

    if (env.APP_HOST && env.ENVIRONMENT !== "dev" && url.hostname !== env.APP_HOST) {
      const cdnWidget = url.hostname.startsWith("cdn.") && p === "/w.js";
      if (!cdnWidget) return Response.redirect(`https://${env.APP_HOST}${p}${url.search}`, 301);
    }

    // App host: the landing page lives on the marketing host in prod; elsewhere it's shown here (noindex).
    if (LANDING_PAGES[p]) {
      if (landing) return Response.redirect(`https://${landing}${p === "/" ? "/" : p}`, 301);
      return landingPage(req, env, LANDING_PAGES[p], false);
    }
    if (p === "/robots.txt") return appRobots(env);

    if (p.startsWith("/portal-api/")) return forward(req, env, p);
    const productImage = /^\/pi\/([A-Z0-9]{26})\/([a-z0-9]{26}\.(?:jpg|png|webp))$/.exec(p);
    if (productImage && (req.method === "GET" || req.method === "HEAD")) return forward(req, env, `/v1/product-image/${productImage[1]}/${productImage[2]}`);
    // Brand logos (portal → Your brand look), served from our own address like product photos.
    const brandLogo = /^\/bl\/([A-Za-z0-9_]{1,40})\/([a-z0-9]{26}\.(?:jpg|png|webp))$/.exec(p);
    if (brandLogo && (req.method === "GET" || req.method === "HEAD")) return forward(req, env, `/v1/brand-logo/${brandLogo[1]}/${brandLogo[2]}`);
    const payApi = /^\/pay-api\/([A-Za-z0-9]{32})(\/claim)?$/.exec(p);
    if (payApi) return forward(req, env, `/v1/pay/${payApi[1]}${payApi[2] ?? ""}`);
    const payPdf = /^\/pay\/([A-Za-z0-9]{32})\/invoice\.pdf$/.exec(p);
    if (payPdf) return forward(req, env, `/v1/pay/${payPdf[1]}/pdf`);
    if (p === "/api/start" && req.method === "POST") return forward(req, env, "/v1/start");
    if (p === "/api/contact" && req.method === "POST") return forward(req, env, "/v1/contact");
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    const cfg = { api: env.API_ORIGIN, turnstileSiteKey: env.TURNSTILE_SITE_KEY };
    if (FRAME_RE.test(p)) return template(req, env, "/frame.html", frameCsp(env, true), cfg);
    if (HOSTED_RE.test(p)) return template(req, env, "/frame.html", frameCsp(env, false), cfg);
    if (p === "/start") return template(req, env, "/start.html", pageCsp(env), cfg);
    if (/^\/pay\/[A-Za-z0-9]{32}\/?$/.test(p)) {
      const res = await env.ASSETS.fetch(new Request(new URL("/pay.html", req.url)));
      return new Response(res.body, {
        headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": pageCsp(env), "x-robots-tag": "noindex" },
      });
    }
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
    if (p === "/frame.html" || p === "/start.html" || p === "/pay.html") return new Response("Not found", { status: 404 });

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
