import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";
import { contrastOnWhite, logoColors } from "../logoColors.js";

const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_BUTTON = "#143822";

type Target = "button" | "text";

/**
 * The brand's look on its try-on pages and website button: logo, button colour and text colour.
 * The main colours of the logo are read in the browser and offered as swatches.
 */
export function BrandLook({ me, refresh }: { me: Me; refresh: () => Promise<void> }) {
  const [color, setColor] = useState(me.look.color ?? DEFAULT_BUTTON);
  // "" = automatic (same as the buttons when readable).
  const [textColor, setTextColor] = useState(me.look.textColor ?? "");
  const [target, setTarget] = useState<Target>("button");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [swatches, setSwatches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const logo = preview ?? me.look.logo;

  // Read the logo's main colours whenever the logo changes.
  useEffect(() => {
    let live = true;
    if (!logo) {
      setSwatches([]);
      return;
    }
    void logoColors(logo).then((c) => {
      if (!live) return;
      setSwatches(c);
      // A brand without its own colours yet starts from its logo's main colour.
      if (preview && !me.look.color && c[0]) setColor(c[0]);
    });
    return () => {
      live = false;
    };
  }, [logo, preview, me.look.color]);

  const button = HEX.test(color) ? color : DEFAULT_BUTTON;
  const onDark = contrastOnWhite(button) > 3;
  const textChosen = HEX.test(textColor);
  const textReadable = textChosen && contrastOnWhite(textColor) >= 4.5;
  const shownText = textReadable ? textColor : contrastOnWhite(button) >= 4.5 ? button : "#0F1A13";
  const current = target === "button" ? color : textColor;

  const pick = (hex: string): void => (target === "button" ? setColor(hex) : setTextColor(hex));

  const save = async (extra?: Record<string, string>) => {
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("color", color);
      fd.set("textColor", textChosen ? textColor : "");
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

  const colorRow = (id: string, label: string, value: string, set: (v: string) => void, fallback: string) => (
    <div className="row">
      <input id={id} type="color" value={HEX.test(value) ? value : fallback} onChange={(e) => set(e.target.value)} style={{ width: 64, padding: 4 }} />
      <input
        aria-label={`${label} code`}
        value={value}
        placeholder={fallback}
        maxLength={7}
        spellCheck={false}
        onChange={(e) => /^#?[0-9a-fA-F]{0,6}$/.test(e.target.value) && set(e.target.value && !e.target.value.startsWith("#") ? `#${e.target.value}` : e.target.value)}
        style={{ width: 130, fontVariantNumeric: "tabular-nums" }}
      />
    </div>
  );

  return (
    <div className="card">
      <h2>Your brand look</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Your logo and colours on your try-on pages, and the colour of the Try it on button on your website. The button also copies your own Add to cart
        button's shape and font.
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

          {swatches.length > 0 && (
            <div className="swatch-box">
              <p className="swatch-head" id="swatch-head">
                Colours from your logo
              </p>
              <div className="seg" role="radiogroup" aria-label="Use a logo colour for">
                {(["button", "text"] as const).map((t) => (
                  <button key={t} type="button" role="radio" aria-checked={target === t} className="seg-btn" onClick={() => setTarget(t)}>
                    {t === "button" ? "For buttons" : "For text & links"}
                  </button>
                ))}
              </div>
              <div className="swatches" aria-labelledby="swatch-head">
                {swatches.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="swatch"
                    style={{ background: s }}
                    aria-pressed={current.toLowerCase() === s}
                    aria-label={`Use ${s} ${target === "button" ? "for buttons" : "for text and links"}`}
                    title={s}
                    onClick={() => pick(s)}
                  />
                ))}
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                Tap a colour to use it {target === "button" ? "for your buttons" : "for text and links"}.
              </p>
            </div>
          )}

          <label htmlFor="color">Buttons</label>
          {colorRow("color", "Button colour", color, setColor, DEFAULT_BUTTON)}

          <label htmlFor="text-color">Text &amp; links</label>
          {colorRow("text-color", "Text colour", textColor, setTextColor, shownText)}
          <p className="small muted" style={{ margin: "4px 0 0" }}>
            {!textChosen ? (
              "Automatic: the button colour when it's easy to read, otherwise near-black."
            ) : (
              <>
                {!textReadable && <span className="look-warn">Too light to read on a white page, so near-black is used instead. </span>}
                <button type="button" className="linkish" onClick={() => setTextColor("")}>
                  Use automatic
                </button>
              </>
            )}
          </p>

          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" disabled={busy || !HEX.test(color) || (textColor !== "" && !textChosen)} onClick={() => void save()}>
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
            <p className="look-title" style={textReadable ? { color: textColor } : undefined}>
              Choose a piece to try on
            </p>
            <span className="look-btn" style={{ background: button, color: onDark ? "#FFFFFF" : "#0F1A13" }}>
              Upload a clear photo of yourself
            </span>
            <span className="look-link" style={{ color: shownText }}>
              See all products
            </span>
          </div>
          <p className="small muted" style={{ margin: "12px 0 6px" }}>
            On your website
          </p>
          <div className="look-sheet look-site">
            <span className="look-cart">Add to cart</span>
            <span className="look-outline" style={{ color: button, borderColor: button }}>
              Try it on
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
