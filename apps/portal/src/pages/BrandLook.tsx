import { useState } from "react";
import { api, type Me } from "../api.js";

/** The brand's look on its try-on pages and website button: logo and main colour. */
export function BrandLook({ me, refresh }: { me: Me; refresh: () => Promise<void> }) {
  const [color, setColor] = useState(me.look.color ?? "#143822");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const logo = preview ?? me.look.logo;
  const n = parseInt(color.slice(1), 16);
  const lum = [n >> 16, (n >> 8) & 255, n & 255].map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const onDark = 0.2126 * lum[0]! + 0.7152 * lum[1]! + 0.0722 * lum[2]! < 0.3;

  const save = async (extra?: Record<string, string>) => {
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("color", color);
      if (file) fd.set("logo", file);
      for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
      await api("/brand", { form: fd });
      setFile(null);
      if (preview) URL.revokeObjectURL(preview);
      setPreview(null);
      await refresh();
      setMsg("Saved. Your try-on pages and website button now use your look.");
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      setMsg(m === "too_large" ? "That logo is too big. Please use one under 2 MB." : m === "not_an_image" ? "Please use a PNG, JPG or WEBP logo." : "Couldn't save. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Your brand look</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Your logo and main colour on your try-on pages, and the colour of the Try it on button on your website. The button also copies your own Add to
        cart button's shape and font.
      </p>
      <div className="look-grid">
        <div>
          <label htmlFor="logo">Logo (PNG with a transparent background works best)</label>
          <input
            id="logo"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (preview) URL.revokeObjectURL(preview);
              setPreview(f ? URL.createObjectURL(f) : null);
            }}
          />
          <label htmlFor="color">Main colour</label>
          <div className="row">
            <input id="color" type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 64, padding: 4 }} />
            <input
              aria-label="Main colour code"
              value={color}
              maxLength={7}
              spellCheck={false}
              onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && setColor(e.target.value)}
              style={{ width: 130, fontVariantNumeric: "tabular-nums" }}
            />
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" disabled={busy || !/^#[0-9a-fA-F]{6}$/.test(color)} onClick={() => void save()}>
              {busy ? "Saving…" : "Save my look"}
            </button>
            {me.look.logo && (
              <button className="btn ghost small" disabled={busy} onClick={() => void save({ removeLogo: "1" })}>
                Remove logo
              </button>
            )}
          </div>
          {msg && (
            <p className="note" role="status" style={{ marginTop: 12 }}>
              {msg}
            </p>
          )}
        </div>
        <div className="look-preview" aria-label="Preview">
          <p className="small muted" style={{ margin: "0 0 8px" }}>
            Preview
          </p>
          <div className="look-sheet">
            {logo ? <img src={logo} alt={`${me.account.name} logo`} className="look-logo" /> : <p className="look-name">{me.account.name}</p>}
            <p className="look-title">Choose a piece to try on</p>
            <span className="look-btn" style={{ background: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#143822", color: onDark ? "#FFFFFF" : "#0F1A13" }}>
              Upload a clear photo of yourself
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
