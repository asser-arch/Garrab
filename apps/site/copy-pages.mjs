// Copies the static public pages and the shared UI stylesheet into the assets folder.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

const out = new URL("./public/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const f of readdirSync(new URL("./pages/", import.meta.url))) copyFileSync(new URL(`./pages/${f}`, import.meta.url), `${out}${f}`);
copyFileSync(new URL("../../packages/shared/src/ui.css", import.meta.url), `${out}site.css`);
copyFileSync(new URL("../../docs/brand/logo/garrab-mark.svg", import.meta.url), `${out}favicon.svg`);
console.log("pages copied");
