/**
 * Outreach preview: when a prospect asks, show them Garrab on ONE of their own products before they sign up.
 * Give a product photo (upload, or a link to the image, product page or post), pick a stock model or room,
 * and get a ready-to-send image: their product next to the AI preview, with Garrab's name. Download it and
 * send it on WhatsApp or Instagram. Nothing about the prospect is saved.
 */
import { useEffect, useRef, useState } from "react";

type Mode = "person" | "room";
interface Result {
  product: string;
  preview: string;
  fixture: string;
}

const T = {
  en: { yours: "Your product", ai: "On our model · AI preview", aiRoom: "In a room · AI preview", aiOwn: "On the model · AI preview", aiOwnRoom: "In the room · AI preview", foot: "Garrab · AI virtual try-on for online brands · garrabb.com", made: "Made for" },
  ar: { yours: "منتجك", ai: "على موديلنا · معاينة بالذكاء الاصطناعي", aiRoom: "في أوضة · معاينة بالذكاء الاصطناعي", aiOwn: "على الموديل · معاينة بالذكاء الاصطناعي", aiOwnRoom: "في الأوضة · معاينة بالذكاء الاصطناعي", foot: "جرّاب · تجربة افتراضية بالذكاء الاصطناعي · garrabb.com", made: "معمول لـ" },
};

const load = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });

/** Their product (left) and the AI preview (right) on one 1600×1000 card, flat Garrab colours. */
async function compose(r: Result, mode: Mode, brand: string, lang: "en" | "ar", own: boolean): Promise<string> {
  const t = T[lang];
  const aiLabel = own ? (mode === "room" ? t.aiOwnRoom : t.aiOwn) : mode === "room" ? t.aiRoom : t.ai;
  const W = 1600, H = 1000, pad = 56, top = 150, boxH = H - top - 120, gap = 40, boxW = (W - pad * 2 - gap) / 2;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#F4F2EB";
  g.fillRect(0, 0, W, H);
  const rtl = lang === "ar";
  g.direction = rtl ? "rtl" : "ltr";
  g.textAlign = rtl ? "right" : "left";
  const x0 = rtl ? W - pad : pad;
  g.fillStyle = "#143822";
  g.font = "700 44px Cairo, Arial, sans-serif";
  g.fillText(brand ? `${t.made} ${brand}` : "Garrab", x0, 86);
  g.fillStyle = "#5C5D57";
  g.font = "400 24px Cairo, Arial, sans-serif";
  g.fillText(brand ? t.foot : t.foot.replace(/^(Garrab|جرّاب) · /, ""), x0, 124);
  const [a, b] = await Promise.all([load(r.product), load(r.preview)]);
  const boxes = rtl ? [b, a] : [a, b];
  const labels = rtl ? [aiLabel, t.yours] : [t.yours, aiLabel];
  boxes.forEach((img, k) => {
    const bx = pad + k * (boxW + gap);
    g.fillStyle = "#FCFBF8";
    g.beginPath();
    g.roundRect(bx, top, boxW, boxH, 24);
    g.fill();
    const s = Math.min((boxW - 32) / img.width, (boxH - 32) / img.height);
    const w = img.width * s, h = img.height * s;
    g.save();
    g.beginPath();
    g.roundRect(bx + (boxW - w) / 2, top + (boxH - h) / 2, w, h, 16);
    g.clip();
    g.drawImage(img, bx + (boxW - w) / 2, top + (boxH - h) / 2, w, h);
    g.restore();
    const ai = (labels[k] ?? "").includes("AI") || (labels[k] ?? "").includes("معاينة");
    g.font = "700 26px Cairo, Arial, sans-serif";
    const tw = g.measureText(labels[k]!).width + 36;
    const lx = rtl ? bx + boxW - 20 - tw : bx + 20;
    g.fillStyle = ai ? "#F3D6A8" : "#143822";
    g.beginPath();
    g.roundRect(lx, top + boxH + 24, tw, 46, 23);
    g.fill();
    g.fillStyle = ai ? "#143822" : "#FCFBF8";
    g.textAlign = "center";
    g.fillText(labels[k]!, lx + tw / 2, top + boxH + 56);
    g.textAlign = rtl ? "right" : "left";
  });
  return c.toDataURL("image/jpeg", 0.92);
}

const save = (href: string, name: string): void => {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
};

export function Outreach() {
  const [mode, setMode] = useState<Mode>("person");
  const [fixtures, setFixtures] = useState<Record<Mode, string[]>>({ person: [], room: [] });
  const [fixture, setFixture] = useState<number | "own">(0);
  const [ownFile, setOwnFile] = useState<File | null>(null);
  const [ownUrl, setOwnUrl] = useState<string | null>(null);
  const [usedOwn, setUsedOwn] = useState(false);
  const [brand, setBrand] = useState("");
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [lang, setLang] = useState<"en" | "ar">("en");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetch("/admin-api/outreach/fixtures")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Record<Mode, string[]> | null) => j && setFixtures(j));
  }, []);
  useEffect(() => {
    if (result) void compose(result, mode, brand.trim(), lang, usedOwn).then(setCard);
  }, [result, brand, lang, mode, usedOwn]);
  // A new person/room photo for each kind: forget the old one when switching fashion ↔ home décor.
  const pickOwn = (f: File | null): void => {
    if (ownUrl) URL.revokeObjectURL(ownUrl);
    setOwnFile(f);
    setOwnUrl(f ? URL.createObjectURL(f) : null);
    if (f) setFixture("own");
  };

  const make = async (): Promise<void> => {
    setErr(null);
    setResult(null);
    setCard(null);
    if (!file && !link.trim()) return setErr("Add a photo or paste a link.");
    if (fixture === "own" && !ownFile) return setErr(`Upload the ${mode === "room" ? "room" : "person"} photo, or pick one of ours.`);
    setBusy(true);
    try {
      const fd = new FormData();
      if (file) fd.set("photo", file);
      else fd.set("link", link.trim());
      fd.set("title", title.trim());
      fd.set("mode", mode);
      fd.set("fixture", String(fixture === "own" ? 0 : fixture));
      if (fixture === "own" && ownFile) fd.set("own", ownFile);
      const r = await fetch("/admin-api/outreach/preview", { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as Result & { reason?: string; error?: string };
      if (!r.ok) throw new Error(j.reason ?? j.error ?? `HTTP ${r.status}`);
      setUsedOwn(fixture === "own");
      setResult(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const slug = (brand.trim() || "prospect").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "prospect";
  const list = fixtures[mode];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Outreach <span className="soft">one free preview</span>
          </h1>
          <p className="small muted">
            When a brand you're talking to asks, show them Garrab on one of their own products. Nothing about them is saved; the AI cost counts in the dashboard.
          </p>
        </div>
      </div>
      <div className="card outreach">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void make();
          }}
        >
          <fieldset className="seg-field">
            <legend>Their shop sells</legend>
            <label>
              <input type="radio" name="o-mode" checked={mode === "person"} onChange={() => (setMode("person"), setFixture(0), pickOwn(null))} /> Fashion (on a model)
            </label>
            <label>
              <input type="radio" name="o-mode" checked={mode === "room"} onChange={() => (setMode("room"), setFixture(0), pickOwn(null))} /> Home décor (in a room)
            </label>
          </fieldset>

          <div className="bh-grid">
            <label>
              Brand name (shown on the image)
              <input value={brand} maxLength={60} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. Havva" />
            </label>
            <label>
              Product name (optional, helps the AI)
              <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Beige fringed two-piece set" />
            </label>
          </div>

          <label>
            Product photo
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                if (e.target.files?.[0]) setLink("");
              }}
            />
          </label>
          <label>
            …or a link: the photo, their product page, or an Instagram post
            <input
              type="url"
              inputMode="url"
              value={link}
              disabled={!!file}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://…"
            />
          </label>
          {file && (
            <p className="small">
              Using the uploaded photo.{" "}
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  setFile(null);
                  if (fileRef.current) fileRef.current.value = "";
                }}
              >
                Use a link instead
              </button>
            </p>
          )}
          <p className="small muted">Instagram often hides photos from links: if a post link doesn't work, save the photo and upload it.</p>

          <fieldset className="seg-field">
            <legend>{mode === "room" ? "Room" : "Model"}</legend>
            <div className="fixture-pick">
              {list.map((src, i) => (
                <label key={i} className={fixture === i ? "on" : ""}>
                  <input type="radio" name="o-fix" checked={fixture === i} onChange={() => setFixture(i)} className="sr-only" />
                  <img src={src} alt={`${mode === "room" ? "Room" : "Model"} ${String.fromCharCode(65 + i)}`} />
                  <span>{`${mode === "room" ? "Room" : "Model"} ${String.fromCharCode(65 + i)}`}</span>
                </label>
              ))}
              <label className={`own ${fixture === "own" ? "on" : ""}`}>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic"
                  className="sr-only"
                  aria-label={mode === "room" ? "Upload a room photo" : "Upload a person photo"}
                  onChange={(e) => pickOwn(e.target.files?.[0] ?? null)}
                />
                {ownUrl ? <img src={ownUrl} alt={mode === "room" ? "Your room photo" : "Your person photo"} /> : <span className="own-tile" aria-hidden="true">+</span>}
                <span>{ownUrl ? "Your photo" : "Upload your own"}</span>
              </label>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              {mode === "room"
                ? "Your own: any room photo, e.g. one the customer sent. Straight on, good light, the spot for the piece visible."
                : "Your own: any person photo, e.g. one the customer sent. Full body, standing, good light. Only with their permission; it's used for this one preview and never saved."}
            </p>
          </fieldset>

          <p>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Making the preview… (about 20 seconds)" : "Make preview"}
            </button>
          </p>
          {err && (
            <p className="warn" role="alert">
              {err}
            </p>
          )}
        </form>

        {result && (
          <div className="outreach-result" aria-live="polite">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2>Ready to send</h2>
              <div className="seg" role="radiogroup" aria-label="Image language">
                <button type="button" aria-pressed={lang === "en"} className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
                  English
                </button>
                <button type="button" aria-pressed={lang === "ar"} className={lang === "ar" ? "on" : ""} onClick={() => setLang("ar")}>
                  عربي
                </button>
              </div>
            </div>
            {card && <img className="outreach-card" src={card} alt={`Their product and the AI preview (${result.fixture})`} />}
            <div className="row">
              <button className="btn" type="button" disabled={!card} onClick={() => card && save(card, `garrab-preview-${slug}.jpg`)}>
                Download image
              </button>
              <button className="btn ghost" type="button" onClick={() => save(result.preview, `garrab-ai-preview-${slug}.jpg`)}>
                Download the preview only
              </button>
              <button className="btn ghost" type="button" onClick={() => void make()} disabled={busy}>
                Make another version
              </button>
            </div>
            <p className="small muted">AI previews vary: if this one isn't great, make another version or try another {mode === "room" ? "room" : "model"}.</p>
          </div>
        )}
      </div>
    </>
  );
}
