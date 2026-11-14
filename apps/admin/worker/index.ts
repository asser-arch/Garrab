/**
 * Admin Worker: serves the admin app and forwards /admin-api/* to the API Worker.
 * In staging/prod the whole hostname sits behind Cloudflare Access, which adds the
 * Cf-Access-Jwt-Assertion header that the API verifies. Locally, a dev token is added instead.
 */
interface Env {
  ASSETS: Fetcher;
  API: Fetcher;
  ENVIRONMENT: string;
  ADMIN_DEV_TOKEN?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/admin-api/")) {
      const headers = new Headers(req.headers);
      headers.delete("authorization");
      if (env.ENVIRONMENT === "dev" && env.ADMIN_DEV_TOKEN) headers.set("authorization", `Bearer ${env.ADMIN_DEV_TOKEN}`);
      return env.API.fetch(new Request(req, { headers }));
    }
    const res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    out.headers.set("x-frame-options", "DENY");
    out.headers.set("x-content-type-options", "nosniff");
    out.headers.set("referrer-policy", "no-referrer");
    out.headers.set(
      "content-security-policy",
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
    );
    return out;
  },
} satisfies ExportedHandler<Env>;
