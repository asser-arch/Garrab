// Wait until a URL answers, then exit 0. Used to start the local Workers one after another:
// parallel `wrangler dev` processes race for the same service-binding socket.
const url = process.argv[2];
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  try {
    const r = await fetch(url);
    if (r.status < 500) process.exit(0);
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.error(`timed out waiting for ${url}`);
process.exit(1);
