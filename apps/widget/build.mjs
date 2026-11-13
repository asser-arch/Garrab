// Builds w.js into apps/site/public and enforces the 30 KB gzip budget (brief §4).
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync } from "node:fs";

const out = new URL("../site/public/w.js", import.meta.url).pathname;
mkdirSync(new URL("../site/public/", import.meta.url).pathname, { recursive: true });
await build({
  entryPoints: [new URL("./src/w.ts", import.meta.url).pathname],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2019"],
  outfile: out,
  define: { __API__: JSON.stringify(process.env.GARRAB_API ?? "http://localhost:8787") },
  legalComments: "none",
});
const gz = gzipSync(readFileSync(out)).length;
console.log(`w.js: ${(gz / 1024).toFixed(1)} KB gzipped (budget 30 KB)`);
if (gz > 30 * 1024) {
  console.error("w.js is over the 30 KB gzip budget");
  process.exit(1);
}
