/**
 * The try-on flow. Runs on our own origin (app.<domain>), either:
 *  - inside the widget's iframe:   /frame#ctx=…&p=<productId>&k=<kind>&lang=en|ar
 *  - as the hosted link page:      /t/<brandSlug>/<productId>?lang=ar
 *
 * The shopper's photo only ever exists in this page's memory and in one request to our API.
 * The result is shown from a blob: URL that is revoked when the flow closes.
 */
import { dir, langFromPage, tryOnStrings, type Lang } from "@garrab/shared/strings";
import { PHOTO } from "@garrab/shared/plans";

declare global {
  interface Window {
    __GARRAB__: { api: string; turnstileSiteKey: string };
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      execute(id: string): void;
      reset(id: string): void;
    };
  }
}

type Kind = "clothing" | "accessory" | "decor";
type S = ReturnType<typeof tryOnStrings>;

interface State {
  mode: "widget" | "hosted";
  ctx: string;
  productId: string;
  kind: Kind;
  lang: Lang;
  t: S;
  privacyClaim: boolean;
  hosted?: { brand: string; title: string; image: string | null; buyUrl: string | null };
  resultUrl: string | null;
  hadPhoto: boolean;
}

const cfg = window.__GARRAB__;
const root = document.getElementById("app") as HTMLElement;
const live = document.getElementById("live") as HTMLElement;

// ---------------------------------------------------------------------------
// tiny DOM helper

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c !== null) el.append(c);
  return el;
}

function show(...nodes: (Node | null)[]): void {
  root.replaceChildren(...nodes.filter((n): n is Node => n !== null));
  // Focus the heading (announced by screen readers, no ring); Tab reaches the main button next.
  const focusable = root.querySelector<HTMLElement>("h1") ?? root.querySelector<HTMLElement>("[data-autofocus]");
  focusable?.focus();
}

function announce(text: string): void {
  live.textContent = text;
}

// ---------------------------------------------------------------------------
// API

function sendEvent(st: State, e: string): void {
  try {
    void fetch(`${cfg.api}/v1/events`, {
      method: "POST",
      body: JSON.stringify({ ctx: st.ctx, e }),
      headers: { "content-type": "text/plain" },
      keepalive: true,
      credentials: "omit",
    }).catch(() => undefined);
  } catch {
    /* analytics never break the flow */
  }
}

/** Decode, downscale and re-encode as JPEG. Drops EXIF (location, device) and converts HEIC. */
export async function prepare(file: File): Promise<Blob> {
  if (file.size > PHOTO.maxBytes * 3) throw new Error("too_large");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, PHOTO.maxSidePx / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const hgt = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = hgt;
  const c2d = canvas.getContext("2d");
  if (!c2d) throw new Error("canvas");
  c2d.drawImage(bitmap, 0, 0, w, hgt);
  bitmap.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.9));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("encode");
  return blob;
}

let turnstileId: string | null = null;
let pending: { ok: (t: string) => void; fail: () => void } | null = null;

/** One fresh Turnstile token per try-on. Invisible unless Cloudflare needs an interaction. */
async function turnstileToken(): Promise<string> {
  if (cfg.turnstileSiteKey === "mock") return "mock";
  const ts = window.turnstile;
  if (!ts) throw new Error("bot_check");
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bot_check")), 20_000);
    pending = {
      ok: (t) => {
        clearTimeout(timer);
        resolve(t);
      },
      fail: () => {
        clearTimeout(timer);
        reject(new Error("bot_check"));
      },
    };
    if (turnstileId === null) {
      turnstileId = ts.render(document.getElementById("ts") as HTMLElement, {
        sitekey: cfg.turnstileSiteKey,
        size: "flexible",
        appearance: "interaction-only",
        callback: (t: string) => pending?.ok(t),
        "error-callback": () => pending?.fail(),
      });
    } else {
      ts.reset(turnstileId);
      ts.execute(turnstileId);
    }
  });
}

// ---------------------------------------------------------------------------
// Screens

function chip(t: S): HTMLElement {
  return h("span", { class: "chip" }, t.aiPreview);
}

function startScreen(st: State, error?: string): void {
  const t = st.t;
  const uploadLabel = st.kind === "decor" ? t.uploadRoom : t.upload;
  // The visible button opens this input; it stays out of the tab order but keeps a name for screen readers.
  const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/heic,image/heif", class: "sr-only", id: "photo", tabindex: "-1", "aria-label": uploadLabel });
  const pick = h("button", { type: "button", class: "btn primary", "data-autofocus": "" }, uploadLabel);
  pick.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    input.value = "";
    if (f) void run(st, f);
  });

  const hosted = st.hosted;
  show(
    hosted
      ? h(
          "header",
          { class: "product" },
          hosted.image ? h("img", { src: hosted.image, alt: "", class: "thumb" }) : null,
          h("div", {}, h("p", { class: "brand" }, hosted.brand), h("h1", { tabindex: "-1" }, hosted.title)),
        )
      : h("h1", { tabindex: "-1", class: "title" }, st.kind === "decor" ? t.buttonRoom : t.buttonTryOn),
    error ? h("p", { class: "error", role: "alert" }, error) : null,
    pick,
    input,
    h("p", { class: "small" }, t.consent),
    h("p", { class: "small muted" }, t.expectation),
    st.privacyClaim ? h("p", { class: "small muted" }, t.privacy) : null,
    closeButton(st),
  );
}

function progressScreen(st: State): void {
  show(h("div", { class: "progress", "aria-busy": "true" }, h("div", { class: "spinner", "aria-hidden": "true" }), h("h1", { tabindex: "-1" }, st.t.progress)));
  announce(st.t.progress);
}

function resultScreen(st: State, url: string): void {
  const t = st.t;
  const img = h("img", { src: url, alt: t.aiPreview, class: "result" });
  const dl = h("a", { href: url, download: "preview.jpg", class: "btn primary", "data-autofocus": "" }, t.download);
  const buy =
    st.mode === "hosted" && st.hosted?.buyUrl
      ? h("a", { href: st.hosted.buyUrl, target: "_blank", rel: "noopener", class: "btn accent" }, t.buy)
      : null;
  buy?.addEventListener("click", () => sendEvent(st, "buy_click"));
  show(
    h("h1", { tabindex: "-1", class: "sr-only" }, t.aiPreview),
    h("figure", { class: "frame" }, chip(t), img),
    h("p", { class: "small" }, t.disclaimer),
    buy,
    dl,
    closeButton(st),
  );
}

function closeButton(st: State): HTMLElement {
  const b = h("button", { type: "button", class: "btn ghost" }, st.t.close);
  b.addEventListener("click", () => close(st));
  return b;
}

/** Forget the photo and the result. */
function wipe(st: State): void {
  if (st.resultUrl) URL.revokeObjectURL(st.resultUrl);
  st.resultUrl = null;
}

function close(st: State): void {
  const had = st.hadPhoto;
  wipe(st);
  st.hadPhoto = false;
  if (st.mode === "widget") {
    root.replaceChildren();
    parent.postMessage({ type: "garrab:close", deleted: had }, "*");
  } else {
    startScreen(st);
    // role="status" announces it once; no second copy in the live region.
    if (had) root.prepend(h("p", { class: "note", role: "status" }, st.t.closed));
  }
}

// ---------------------------------------------------------------------------
// Flow

async function run(st: State, file: File): Promise<void> {
  const t = st.t;
  wipe(st);
  st.hadPhoto = true;
  progressScreen(st);
  sendEvent(st, "try_on_started");
  let photo: Blob;
  try {
    photo = await prepare(file);
  } catch {
    startScreen(st, t.error);
    return;
  }
  try {
    const form = new FormData();
    form.set("ctx", st.ctx);
    form.set("product", st.productId);
    form.set("turnstile", await turnstileToken());
    form.set("photo", photo, "photo.jpg");
    const r = await fetch(`${cfg.api}/v1/tryon`, { method: "POST", body: form, credentials: "omit" });
    if (!r.ok) {
      const code = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "";
      // Only blame the photo when the photo was the problem.
      const photoProblem = code === "bad_photo" || code === "content_policy" || code.startsWith("photo");
      startScreen(st, code === "unavailable" || code === "quota" || code === "session_expired" ? t.unavailable : photoProblem ? t.error : t.errorRetry);
      return;
    }
    const blob = await r.blob();
    st.resultUrl = URL.createObjectURL(blob);
    sendEvent(st, "try_on_completed");
    resultScreen(st, st.resultUrl);
  } catch {
    startScreen(st, t.errorRetry); // bot check or network: not the photo
  }
}

function unavailable(lang: Lang): void {
  const t = tryOnStrings(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = dir(lang);
  show(h("h1", { tabindex: "-1", class: "title" }, t.unavailable));
}

/** /t/<slug>: the brand page (one link for an Instagram bio). Lists every live product. */
async function brandPage(slug: string, lang: Lang): Promise<void> {
  const t = tryOnStrings(lang);
  let j: { enabled: boolean; brand?: { name: string }; products?: { id: string; title: string; image: string | null }[] };
  try {
    j = (await (await fetch(`${cfg.api}/v1/hosted/${slug}`, { credentials: "omit" })).json()) as typeof j;
  } catch {
    return unavailable(lang);
  }
  if (!j.enabled || !j.brand || !j.products?.length) return unavailable(lang);
  document.title = `${j.brand.name} · ${t.buttonTryOn}`;
  const q = new URLSearchParams(location.search).get("lang") ? `?lang=${lang}` : "";
  show(
    h("header", {}, h("p", { class: "brand" }, j.brand.name), h("h1", { tabindex: "-1" }, t.pickProduct)),
    h(
      "ul",
      { class: "picks" },
      ...j.products.map((p) =>
        h(
          "li",
          {},
          h(
            "a",
            { href: `/t/${slug}/${p.id}${q}`, class: "pick" },
            p.image ? h("img", { src: p.image, alt: "", class: "thumb", loading: "lazy" }) : h("span", { class: "thumb" }),
            h("span", { class: "pick-title" }, p.title),
            h("span", { class: "pick-go", "aria-hidden": "true" }, t.buttonTryOn),
          ),
        ),
      ),
    ),
    h("p", { class: "small muted" }, t.expectation),
  );
}

async function boot(): Promise<void> {
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const hostedMatch = /^\/t\/([a-z0-9-]{1,60})\/([A-Za-z0-9]{1,40})\/?$/.exec(location.pathname);
  const brandMatch = /^\/t\/([a-z0-9-]{1,60})\/?$/.exec(location.pathname);
  const lang: Lang = langFromPage(hash.get("lang") ?? query.get("lang") ?? (hostedMatch || brandMatch ? navigator.language : "en"));
  document.documentElement.lang = lang;
  document.documentElement.dir = dir(lang);
  if (brandMatch) return brandPage(brandMatch[1]!, lang);
  // The ctx token is in the fragment; remove it from the address bar and history.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);

  let st: State;
  try {
    if (hostedMatch) {
      const r = await fetch(`${cfg.api}/v1/hosted/${hostedMatch[1]}/${hostedMatch[2]}`, { credentials: "omit" });
      const j = (await r.json()) as {
        enabled: boolean;
        ctx?: string;
        brand?: { name: string };
        product?: { id: string; title: string; image: string | null; kind: Kind };
        buyUrl?: string | null;
        privacyClaim?: boolean;
      };
      if (!j.enabled || !j.ctx || !j.product || !j.brand || j.product.kind === "decor") return unavailable(lang);
      document.title = `${j.product.title} · ${j.brand.name}`;
      st = {
        mode: "hosted",
        ctx: j.ctx,
        productId: j.product.id,
        kind: j.product.kind,
        lang,
        t: tryOnStrings(lang),
        privacyClaim: j.privacyClaim === true,
        hosted: { brand: j.brand.name, title: j.product.title, image: j.product.image, buyUrl: j.buyUrl ?? null },
        resultUrl: null,
        hadPhoto: false,
      };
    } else {
      const ctx = hash.get("ctx");
      const productId = hash.get("p");
      if (!ctx || !productId) return unavailable(lang);
      const info = (await (await fetch(`${cfg.api}/v1/frame-info?ctx=${encodeURIComponent(ctx)}`, { credentials: "omit" })).json()) as {
        enabled: boolean;
        privacyClaim?: boolean;
      };
      if (!info.enabled) return unavailable(lang);
      const k = hash.get("k");
      st = {
        mode: "widget",
        ctx,
        productId,
        kind: k === "accessory" || k === "decor" ? k : "clothing",
        lang,
        t: tryOnStrings(lang),
        privacyClaim: info.privacyClaim === true,
        resultUrl: null,
        hadPhoto: false,
      };
    }
  } catch {
    return unavailable(lang);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close(st);
  });
  window.addEventListener("pagehide", () => wipe(st));
  startScreen(st);
}

void boot();
