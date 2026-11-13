// Builds the try-on flow (frame.js, frame.css, frame.html) into apps/site/public.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const pub = new URL("../site/public/", import.meta.url).pathname;
mkdirSync(pub, { recursive: true });
await build({
  entryPoints: [new URL("./src/main.ts", import.meta.url).pathname],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2019"],
  outfile: `${pub}frame.js`,
  legalComments: "none",
});
copyFileSync(new URL("./src/frame.css", import.meta.url).pathname, `${pub}frame.css`);
copyFileSync(new URL("./src/frame.html", import.meta.url).pathname, `${pub}frame.html`);
console.log("frame built");
