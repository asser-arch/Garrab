/**
 * Garrab widget. Install: <script src="https://cdn.<domain>/w.js" data-key="gk_live_…" async></script>
 *
 * Rules (brief §4): fail silent, never break the host page, no console output, config in
 * memory only (never localStorage), re-checked every 30 s so the kill switch bites fast.
 * The photo flow runs in an iframe on our own origin; this script never touches photos.
 */
import { dir, langFromPage, tryOnStrings } from "@garrab/shared/strings";
import { colors, font, radius } from "@garrab/shared/tokens";

declare const __API__: string;

interface WidgetProduct {
  id: string;
  ref: string | null;
  path: string | null;
  kind: "clothing" | "accessory" | "decor";
}
interface Config {
  enabled: boolean;
  ttl: number;
  ctx: string;
  frame: string;
  selector: string | null;
  sizeFinder: boolean;
  /** The brand's main colour, set in its portal (overrides the colour read from the page). */
  brandColor?: string | null;
  products: WidgetProduct[];
}

((): void => {
  try {
    const script = document.currentScript as HTMLScriptElement | null;
    const key = script?.dataset.key;
    if (!key || (window as unknown as { __garrab?: boolean }).__garrab) return;
    (window as unknown as { __garrab?: boolean }).__garrab = true;
    const api = script?.dataset.api ?? __API__;

    let cfg: Config | null = null;
    let fetchedAt = 0;
    let host: HTMLElement | null = null;
    let shadow: ShadowRoot | null = null;
    let product: WidgetProduct | null = null;
    let viewSent = false;
    let modal: HTMLElement | null = null;
    let lastFocus: HTMLElement | null = null;

    const lang = langFromPage(document.documentElement.lang);
    const t = tryOnStrings(lang);

    // ------------------------------------------------------------------ detection

    function normPath(p: string): string {
      let x = p.replace(/\/+$/, "") || "/";
      // Shopify: /collections/<c>/products/<h> and locale prefixes → /products/<h>
      const m = /\/products\/[^/?#]+/.exec(x);
      if (m) x = m[0];
      return x.toLowerCase();
    }

    function candidates(): Set<string> {
      const ids = new Set<string>();
      const add = (v: unknown): void => {
        if (v !== undefined && v !== null && String(v).trim()) ids.add(String(v).trim());
      };
      const w = window as unknown as { ShopifyAnalytics?: { meta?: { product?: { id?: unknown } } } };
      add(w.ShopifyAnalytics?.meta?.product?.id);
      const body = document.body;
      if (body?.classList.contains("single-product")) {
        const m = /(?:^|\s)postid-(\d+)/.exec(body.className);
        add(m?.[1]);
      }
      document.querySelectorAll<HTMLElement>("[data-garrab-product]").forEach((el) => add(el.dataset.garrabProduct));
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        try {
          const visit = (n: unknown): void => {
            if (!n || typeof n !== "object") return;
            if (Array.isArray(n)) return n.forEach(visit);
            const o = n as Record<string, unknown>;
            const type = o["@type"];
            if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
              add(o.sku);
              add(o.productID);
              add(o.mpn);
            }
            visit(o["@graph"]);
          };
          visit(JSON.parse(s.textContent ?? ""));
        } catch {
          /* ignore broken JSON-LD */
        }
      });
      return ids;
    }

    function match(c: Config): WidgetProduct | null {
      const ids = candidates();
      const path = normPath(location.pathname);
      return (
        c.products.find((p) => (p.ref !== null && ids.has(p.ref)) || ids.has(p.id)) ??
        c.products.find((p) => p.path !== null && normPath(p.path) === path) ??
        null
      );
    }

    function anchor(c: Config): Element | null {
      const sels = [
        c.selector,
        "[data-garrab-product]",
        'form[action*="/cart/add"] [type="submit"]',
        'form[action*="/cart/add"] button[name="add"]',
        ".single_add_to_cart_button",
        'button[name="add-to-cart"]',
        '[name="add-to-cart"]',
      ];
      for (const s of sels) {
        if (!s) continue;
        try {
          const el = document.querySelector(s);
          if (el) return el;
        } catch {
          /* bad selector from portal: try the next */
        }
      }
      return null;
    }

    // ------------------------------------------------------------------ network

    async function load(): Promise<Config | null> {
      const r = await fetch(`${api}/v1/config?key=${encodeURIComponent(key!)}`, { credentials: "omit", mode: "cors" });
      const j = (await r.json()) as Config;
      return j && j.enabled ? j : null;
    }

    function event(e: string): void {
      if (!cfg) return;
      try {
        void fetch(`${api}/v1/events`, {
          method: "POST",
          body: JSON.stringify({ ctx: cfg.ctx, e, p: product?.id }),
          headers: { "content-type": "text/plain" },
          keepalive: true,
          credentials: "omit",
        }).catch(() => undefined);
      } catch {
        /* never */
      }
    }

    // ------------------------------------------------------------------ UI

    const css = `
      :host{all:initial;display:block;margin-top:8px}
      button{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;
        min-height:var(--g-h,48px);padding:0 24px;border-radius:var(--g-r,${radius.pill});
        background:transparent;color:var(--g-c,${colors.forest});border:1px solid var(--g-c,${colors.forest});
        font-family:var(--g-f,${font});font-size:var(--g-s,15px);font-weight:var(--g-w,600);line-height:1.2;
        letter-spacing:.08em;text-transform:uppercase;cursor:pointer;text-align:center;transition:background-color 150ms ease,color 150ms ease}
      button:hover{background:var(--g-c,${colors.forest});color:var(--g-on,${colors.paper})}
      button:lang(ar){letter-spacing:0;text-transform:none}
      button:focus-visible{outline:2px solid var(--g-c,${colors.forest});outline-offset:3px}
      @media (prefers-reduced-motion:reduce){button{transition:none}}
      .overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(15,26,19,.55);display:flex;align-items:center;justify-content:center;
        opacity:0;transition:opacity 200ms ease}
      .overlay.on{opacity:1}
      iframe{border:0;background:${colors.paper};width:100%;height:100%;max-width:480px;max-height:min(760px,100%)}
      @media (min-width:520px){iframe{border-radius:${radius.card};border:1px solid ${colors.sand}}}
      .toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;background:${colors.mint};color:${colors.ink};
        border-radius:16px;padding:12px 16px;font:400 14px/1.4 ${font}}
      @media (prefers-reduced-motion:reduce){.overlay{transition:none}}
    `;

    function remove(): void {
      closeModal(false);
      host?.remove();
      host = null;
      shadow = null;
      product = null;
    }

    // ------------------------------------------------------------------ the shop's own look

    function rgb(s: string): [number, number, number, number] | null {
      const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?/.exec(s);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
    }
    function hexRgb(h: string): [number, number, number, number] | null {
      const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
      if (!m) return null;
      const n = parseInt(m[1]!, 16);
      return [n >> 16, (n >> 8) & 255, n & 255, 1];
    }
    function lum(c: [number, number, number, number]): number {
      const f = (v: number): number => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    }
    const css3 = (c: [number, number, number, number]): string => `rgb(${c[0]},${c[1]},${c[2]})`;

    /**
     * Dress the button like the shop's own Add to cart button: same corners, font and height, in the shop's main
     * colour, as its outlined partner. The brand's chosen colour (portal) wins; a colour too pale to read on the
     * page falls back to the button's text colour, then to Garrab Forest.
     */
    function shopLook(h: HTMLElement, at: Element, c: Config): void {
      const ref = at.matches("button,input,a,[role=button]") ? at : at.querySelector("button,[type=submit]");
      const cs = ref ? getComputedStyle(ref) : null;
      const pageBg = rgb(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
      const bgL = lum(pageBg[3] === 0 ? [255, 255, 255, 1] : pageBg);
      const readable = (x: [number, number, number, number] | null): boolean =>
        !!x && x[3] > 0.5 && (Math.max(lum(x), bgL) + 0.05) / (Math.min(lum(x), bgL) + 0.05) >= 3;
      const candidates = [c.brandColor ? hexRgb(c.brandColor) : null, cs ? rgb(cs.backgroundColor) : null, cs ? rgb(cs.color) : null];
      const color = candidates.find(readable) ?? null;
      const set = (k: string, v: string | undefined | null): void => {
        if (v) h.style.setProperty(k, v);
      };
      if (color) {
        set("--g-c", css3(color));
        set("--g-on", lum(color) > 0.35 ? "#0F1A13" : "#FCFBF8");
      }
      if (cs) {
        set("--g-r", cs.borderRadius);
        set("--g-f", cs.fontFamily);
        set("--g-s", cs.fontSize);
        set("--g-w", Number(cs.fontWeight) >= 500 ? cs.fontWeight : "600");
        const hgt = (ref as HTMLElement).offsetHeight;
        if (hgt >= 36 && hgt <= 72) set("--g-h", `${hgt}px`);
      }
    }

    function render(c: Config, p: WidgetProduct): void {
      const at = anchor(c);
      if (!at) return;
      host = document.createElement("garrab-try-on");
      shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = css;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dir = dir(lang);
      btn.lang = lang;
      btn.textContent = p.kind === "decor" ? t.buttonRoom : t.buttonTryOn; // home décor brands: room preview
      btn.setAttribute("aria-haspopup", "dialog");
      btn.addEventListener("click", () => void open(btn));
      shadow.append(style, btn);
      if (at.hasAttribute("data-garrab-product")) at.append(host);
      else at.insertAdjacentElement("afterend", host);
      try {
        shopLook(host, at, c);
      } catch {
        /* never break the shop: keep the Garrab look */
      }
      product = p;
      if (!viewSent) {
        viewSent = true;
        event("button_view");
      }
    }

    async function open(btn: HTMLElement): Promise<void> {
      try {
        if (!cfg || Date.now() - fetchedAt > cfg.ttl * 1000) await refresh();
        if (!cfg || !product || !shadow) return;
        lastFocus = btn;
        const frameOrigin = new URL(cfg.frame).origin;
        const overlay = document.createElement("div");
        overlay.className = "overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        const label = product.kind === "decor" ? t.buttonRoom : t.buttonTryOn;
        overlay.setAttribute("aria-label", label);
        const iframe = document.createElement("iframe");
        iframe.title = label;
        iframe.allow = "camera";
        iframe.referrerPolicy = "no-referrer";
        const params = new URLSearchParams({ ctx: cfg.ctx, p: product.id, k: product.kind, lang });
        iframe.src = `${cfg.frame}#${params.toString()}`;
        overlay.append(iframe);
        overlay.addEventListener("click", (e) => {
          if (e.target === overlay) closeModal(false);
        });
        shadow.append(overlay);
        modal = overlay;
        document.documentElement.style.setProperty("overflow", "hidden");
        requestAnimationFrame(() => overlay.classList.add("on"));
        iframe.addEventListener("load", () => iframe.focus());
        const onMsg = (e: MessageEvent): void => {
          if (e.origin !== frameOrigin || e.source !== iframe.contentWindow) return;
          const d = e.data as { type?: string; deleted?: boolean };
          if (d?.type === "garrab:close") {
            window.removeEventListener("message", onMsg);
            closeModal(d.deleted === true);
          }
        };
        window.addEventListener("message", onMsg);
      } catch {
        closeModal(false);
      }
    }

    function closeModal(deleted: boolean): void {
      if (!modal) return;
      modal.remove();
      modal = null;
      document.documentElement.style.removeProperty("overflow");
      lastFocus?.focus();
      if (deleted && shadow) {
        const toast = document.createElement("div");
        toast.className = "toast";
        toast.setAttribute("role", "status");
        toast.dir = dir(lang);
        toast.textContent = t.closed;
        shadow.append(toast);
        setTimeout(() => toast.remove(), 4000);
      }
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal) closeModal(false);
    });

    // ------------------------------------------------------------------ lifecycle

    async function refresh(): Promise<void> {
      try {
        const c = await load();
        if (!c) {
          cfg = null;
          return remove();
        }
        cfg = c;
        fetchedAt = Date.now();
        const p = match(c);
        if (!p) return remove();
        if (!host || !host.isConnected) render(c, p);
        else product = p;
      } catch {
        // offline, blocked, error: render nothing
        cfg = null;
        remove();
      }
    }

    const start = (): void => {
      void refresh();
      // Re-check while the tab is visible so a kill takes effect without a reload.
      setInterval(() => {
        if (document.visibilityState === "visible") void refresh();
      }, 30_000);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  } catch {
    /* fail silent */
  }
})();
