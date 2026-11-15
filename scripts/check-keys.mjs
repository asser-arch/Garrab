#!/usr/bin/env node
/**
 * Post-deploy: confirm each provider key that is set is accepted, without spending anything.
 * Prints only the outcome, never the key. Problems are warnings: they never block a deploy.
 *  - Genlook: DELETE /customers/<random id> (deleting a customer that never existed is free)
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
console.log(out.join("\n") || "No provider keys set yet");
