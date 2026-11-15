#!/usr/bin/env node
/**
 * Post-deploy: confirm each provider key that is set is accepted, without spending anything.
 * Prints only the outcome, never the key. Problems are warnings: they never block a deploy.
 *  - Genlook: DELETE /customers/<random id> (deleting a customer that never existed is free)
 *  - Google AI: GET /v1beta/models (listing models is free) and confirm the configured models exist
 */
const out = [];
async function check(name, fn) {
  try {
    const r = await fn();
    const bad = r.status === 401 || r.status === 403;
    out.push(`${bad ? "::warning::" : ""}${name}: ${bad ? "KEY REJECTED" : "key accepted"} (HTTP ${r.status})`);
  } catch (e) {
    out.push(`::warning::${name}: could not reach the service (${e.message})`);
  }
}
if (process.env.GENLOOK_API_KEY) {
  await check("Genlook", () =>
    fetch(`https://api.genlook.app/tryon/v1/customers/garrab-keycheck-${crypto.randomUUID()}`, {
      method: "DELETE",
      headers: { "x-api-key": process.env.GENLOOK_API_KEY },
    }),
  );
}
if (process.env.GEMINI_API_KEY) {
  let models = [];
  await check("Google AI", async () => {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
    });
    if (r.ok) models = ((await r.json()).models ?? []).map((m) => m.name.replace(/^models\//, ""));
    return r;
  });
  for (const m of ["gemini-3.5-flash-lite", "gemini-3.1-flash-image"]) {
    if (models.length) out.push(`${models.includes(m) ? "" : "::warning::"}Google AI model ${m}: ${models.includes(m) ? "available" : "NOT FOUND"}`);
  }
}
console.log(out.join("\n") || "No provider keys set yet");
