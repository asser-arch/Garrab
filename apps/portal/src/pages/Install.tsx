import { BrandLook } from "./BrandLook.js";
import { captions } from "@garrab/shared/captions";
import qrcode from "qrcode-generator";
import { useState } from "react";
import { api, atOrAfter, type Me } from "../api.js";

type Platform = "shopify" | "woocommerce" | "other_website" | "social_only";

const STEPS: Record<Exclude<Platform, "social_only">, string[]> = {
  shopify: ["In Shopify admin go to Online Store → Themes.", "On your live theme click ⋯ → Edit code.", "Open layout/theme.liquid.", "Paste the line just before </body> and click Save."],
  woocommerce: [
    "In WordPress, install a header and footer plugin (for example WPCode).",
    "Add a new snippet in the footer (site-wide).",
    "Paste the line and save. A Garrab WordPress plugin is coming soon.",
  ],
  other_website: ["Open your site's HTML template (the part shared by product pages).", "Paste the line just before </body>.", "Publish your site."],
};

function Qr({ text, label }: { text: string; label: string }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  const href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return (
    <div>
      <img src={href} alt={`QR code for ${label}`} width={140} height={140} style={{ background: "#fff", borderRadius: 12 }} />
      <div>
        <a className="small" href={href} download={`garrab-qr-${label.replace(/\W+/g, "-").toLowerCase()}.svg`}>
          Download QR
        </a>
      </div>
    </div>
  );
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn small ghost"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 2000);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Install({ me, refresh }: { me: Me; refresh: () => Promise<void> }) {
  const initial: Platform = (me.account.platform as Platform | null) ?? "other_website";
  const [tab, setTab] = useState<Platform>(initial);
  const [check, setCheck] = useState<"idle" | "checking" | "found" | "not_found">(me.install?.install_status === "installed" ? "found" : "idle");
  const approved = atOrAfter(me.step, "products_approved");

  return (
    <>
      <h1>
        Install <span className="soft">and share</span>
      </h1>
      {!approved && <p className="note">Approve at least one product first. Then this page shows how to go live.</p>}
      <BrandLook me={me} refresh={refresh} />

      <div className="card">
        <h2>On your website</h2>
        <nav className="tabs wrap" aria-label="Platform">
          {(["shopify", "woocommerce", "other_website", "social_only"] as Platform[]).map((p) => (
            <a key={p} href="#" aria-current={tab === p ? "page" : undefined} onClick={(e) => (e.preventDefault(), setTab(p))}>
              {{ shopify: "Shopify", woocommerce: "WooCommerce", other_website: "Other website", social_only: "Instagram / WhatsApp" }[p]}
            </a>
          ))}
        </nav>
        {tab === "social_only" ? (
          <p>No install needed. Share the links below in your bio, stories and WhatsApp chats.</p>
        ) : (
          <>
            <ol>
              {STEPS[tab].map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {me.snippet && (
              <>
                <pre className="code" aria-label="Install code">
                  {me.snippet}
                </pre>
                <div className="row">
                  <Copy text={me.snippet} label="Copy the line" />
                  <button
                    className="btn"
                    disabled={!approved || check === "checking"}
                    onClick={async () => {
                      setCheck("checking");
                      const r = await api<{ installed: boolean }>("/install/check", { body: {} });
                      setCheck(r.installed ? "found" : "not_found");
                      await refresh();
                    }}
                  >
                    Check installation
                  </button>
                </div>
                <p role="status" aria-live="polite">
                  {check === "checking" && "Checking your shop…"}
                  {check === "found" && <span className="chip mint">Installed ✓</span>}
                  {check === "not_found" && <span className="warn">We couldn't find it yet. Make sure you saved, then check again.</span>}
                </p>
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Your try-on link</h2>
        {!me.brandLink ? (
          <p className="muted">Your link appears here once you approve products.</p>
        ) : (
          <>
            <p>
              One link for all your products. Put it in your Instagram bio, your TikTok profile or your WhatsApp Business catalogue. Shoppers
              pick a piece and try it on.
            </p>
            <p className="small" style={{ wordBreak: "break-all" }}>
              <a href={me.brandLink.url} target="_blank" rel="noopener">
                {me.brandLink.url}
              </a>
            </p>
            <div className="row">
              <Copy text={me.brandLink.url} label="Copy link" />
              <Copy text={me.brandLink.urlAr} label="Copy Arabic link" />
              <a className="btn small ghost" href={`https://wa.me/?text=${encodeURIComponent(me.brandLink.url)}`} target="_blank" rel="noopener">
                Share on WhatsApp
              </a>
            </div>
          </>
        )}
      </div>

      {me.hostedLinks.length > 0 && (
        <div className="card">
          <h2>Links for single products</h2>
          <p className="muted">For a post, a story or a reply to a customer about one piece.</p>
          {me.hostedLinks.map((l) => (
            <div key={l.productId} style={{ borderTop: "1px solid var(--mist)", paddingTop: 16, marginTop: 16 }}>
              <h3 style={{ margin: "0 0 4px" }}>{l.title}</h3>
              <p className="small" style={{ wordBreak: "break-all" }}>
                <a href={l.url} target="_blank" rel="noopener">
                  {l.url}
                </a>
              </p>
              <div className="row">
                <Copy text={l.url} label="Copy link" />
                <Copy text={captions.en(l.title, l.url)} label="Copy caption (EN)" />
                <Copy text={captions.ar(l.title, l.urlAr)} label="Copy caption (AR)" />
                <Copy text={captions.whatsappAr(l.title, l.urlAr)} label="WhatsApp reply (AR)" />
              </div>
              <details style={{ marginTop: 8 }}>
                <summary className="small">QR code for print (flyers, shop counter, packaging)</summary>
                <div style={{ marginTop: 8 }}>
                  <Qr text={l.url} label={l.title} />
                </div>
              </details>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
