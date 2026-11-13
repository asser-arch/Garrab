/**
 * Site Worker: serves static assets (w.js, frame.js, frame.css) and the HTML for
 *  - /frame              the try-on flow inside brand pages' iframes (embeddable anywhere)
 *  - /t/<slug>/<product> the hosted try-on page for Instagram / WhatsApp brands (not embeddable)
 */
interface Env {
  ASSETS: Fetcher;
  API_ORIGIN: string;
  TURNSTILE_SITE_KEY: string;
  ENVIRONMENT: string;
}

const FRAME_RE = /^\/frame\/?$/;
const HOSTED_RE = /^\/t\/[a-z0-9-]{1,60}\/[A-Za-z0-9]{1,40}\/?$/;

function csp(env: Env, embeddable: boolean): string {
  const turnstile = env.TURNSTILE_SITE_KEY === "mock" ? "" : " https://challenges.cloudflare.com";
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${turnstile}`,
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    `img-src 'self' blob: https:${env.ENVIRONMENT === "dev" ? " http://localhost:*" : ""}`,
    `connect-src ${env.API_ORIGIN}`,
    `frame-src${turnstile || " 'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${embeddable ? "*" : "'none'"}`,
  ].join("; ");
}

async function page(req: Request, env: Env, embeddable: boolean): Promise<Response> {
  const tpl = await env.ASSETS.fetch(new Request(new URL("/frame.html", req.url)));
  let html = await tpl.text();
  const config = JSON.stringify({ api: env.API_ORIGIN, turnstileSiteKey: env.TURNSTILE_SITE_KEY });
  html = html.replace(/\/\*GARRAB_CONFIG\*\/.*?\/\*END\*\//, config);
  if (env.TURNSTILE_SITE_KEY !== "mock") {
    html = html.replace(
      "<!--TURNSTILE-->",
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>',
    );
  }
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": csp(env, embeddable),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "permissions-policy": "camera=(self), microphone=(), geolocation=()",
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    if (FRAME_RE.test(url.pathname)) return page(req, env, true);
    if (HOSTED_RE.test(url.pathname)) return page(req, env, false);
    if (url.pathname === "/frame.html") return new Response("Not found", { status: 404 });

    const res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    out.headers.set("x-content-type-options", "nosniff");
    if (url.pathname === "/w.js") {
      // Short cache: a widget fix reaches every shop within 5 minutes.
      out.headers.set("cache-control", "public, max-age=300");
      out.headers.set("access-control-allow-origin", "*");
    }
    return out;
  },
} satisfies ExportedHandler<Env>;
