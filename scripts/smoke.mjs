#!/usr/bin/env node
/** Post-deploy smoke test. Retries for up to 5 minutes while new custom-domain certificates are issued. */
const env = process.argv[2];
const sfx = env === "prod" ? "" : `-${env}`;
const d = "garrabb.com";
const checks = [
  { url: `https://api${sfx}.${d}/healthz`, ok: async (r) => r.status === 200 && (await r.json()).env === env },
  { url: `https://app${sfx}.${d}/w.js`, ok: async (r) => r.status === 200 && (await r.text()).length > 100 },
  { url: `https://app${sfx}.${d}/start`, ok: async (r) => r.status === 200 },
  { url: `https://app${sfx}.${d}/portal`, ok: async (r) => r.status === 200 },
  // No admin login is configured yet (or it is, via Cloudflare Access): either way, never open to the public.
  { url: `https://admin${sfx}.${d}/admin-api/dashboard`, ok: async (r) => r.status !== 200 },
];
const deadline = Date.now() + 5 * 60_000;
let failed = checks;
while (failed.length && Date.now() < deadline) {
  const next = [];
  for (const c of failed) {
    let good = false, why = "";
    try {
      const r = await fetch(c.url, { redirect: "manual" });
      good = await c.ok(r);
      why = `HTTP ${r.status}`;
    } catch (e) {
      why = e.cause?.code ?? e.message;
    }
    console.log(`${good ? "PASS" : "wait"} ${c.url} (${why})`);
    if (!good) next.push(c);
  }
  failed = next;
  if (failed.length) await new Promise((r) => setTimeout(r, 20_000));
}
if (failed.length) {
  console.error(`FAIL: ${failed.map((c) => c.url).join(", ")}`);
  process.exit(1);
}
console.log("Smoke test passed");
