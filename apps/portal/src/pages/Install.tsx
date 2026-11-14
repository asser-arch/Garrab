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

      <div className="card">
        <h2>On your website</h2>
        <nav className="tabs" aria-label="Platform">
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
        <h2>Try-on links for Instagram and WhatsApp</h2>
        {me.hostedLinks.length === 0 ? (
          <p className="muted">Your links appear here once you approve products.</p>
        ) : (
          me.hostedLinks.map((l) => (
            <div key={l.productId} className="row" style={{ alignItems: "flex-start", borderTop: "1px solid var(--mist)", paddingTop: 16, marginTop: 16, gap: 16 }}>
              <Qr text={l.url} label={l.title} />
              <div style={{ flex: 1, minWidth: 220 }}>
                <h2>{l.title}</h2>
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
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
