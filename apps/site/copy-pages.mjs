// Copies the static public pages and the shared UI stylesheet into the assets folder.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

const out = new URL("./public/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const f of readdirSync(new URL("./pages/", import.meta.url))) copyFileSync(new URL(`./pages/${f}`, import.meta.url), `${out}${f}`);
copyFileSync(new URL("../../packages/shared/src/ui.css", import.meta.url), `${out}site.css`);
copyFileSync(new URL("../../docs/brand/logo/garrab-mark.svg", import.meta.url), `${out}favicon.svg`);
// PNG and ICO icons: Safari (tabs and the iPhone home screen) doesn't use SVG icons.
for (const f of ["favicon-32.png", "apple-touch-icon.png", "favicon.ico"]) copyFileSync(new URL(`../../docs/brand/icons/${f}`, import.meta.url), `${out}${f}`);
// Garrab logo for emails (PNG; email apps don't show SVG), served at app.<domain>/email-logo*.png.
copyFileSync(new URL("../../docs/brand/email/garrab-email-logo.png", import.meta.url), `${out}email-logo.png`);
copyFileSync(new URL("../../docs/brand/email/garrab-email-logo-dark.png", import.meta.url), `${out}email-logo-dark.png`);
console.log("pages copied");
