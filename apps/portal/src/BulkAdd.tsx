/**
 * Add many products at once: pick (or drop) a batch of photos, give each a name (pre-filled from the file
 * name), save all. Photos are shrunk in the browser first, so a batch of phone photos goes up quickly.
 * Used by the brand portal and by Garrab support in the admin (each passes its own `upload`).
 */
import { removeCornerMarks } from "@garrab/shared/watermark";
import { useEffect, useRef, useState } from "react";

interface Item {
  key: string;
  file: File;
  url: string;
  title: string;
  sizes: string;
  state: "ready" | "saving" | "saved" | "error";
  error?: string | undefined;
}

const MAX_SIDE = 1600;
const MAX_FILES = 100;

/** "olive-linen_dress 02.JPG" → "Olive linen dress 02"; camera names ("IMG_2041") → "". */
export function nameFromFile(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, "").replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^(img|dsc|dscn|pxl|photo|image|whatsapp image|screenshot)\b/i.test(base) || /^[\d\s]+$/.test(base)) return "";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Ready a product photo for upload: at most 1600 px on the long side, any brand logo stamped in a corner
 * removed (plain-background photos only), JPEG on white. Falls back to the original file.
 */
export async function prepareProductPhoto(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#FFFFFF"; // transparent PNGs get a white background, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const cleaned = removeCornerMarks(img.data, canvas.width, canvas.height);
    if (cleaned) ctx.putImageData(img, 0, 0);
    // Already small, JPEG, nothing removed: send as it is (no extra quality loss).
    if (!cleaned && scale === 1 && file.type === "image/jpeg" && file.size < 1.5 * 1024 * 1024) return file;
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.9));
  } catch {
    return file;
  }
}

const errorText = (m: string): string =>
  m === "too_large" ? "Photo too big (max 10 MB)." : m === "not_an_image" ? "Not a photo we can read." : m === "limit_reached" ? "Product limit reached." : "Didn't save. Try again.";

export function BulkAdd({ upload, onDone, sizes = true }: { upload: (fd: FormData) => Promise<unknown>; onDone: () => void | Promise<void>; sizes?: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const addFiles = (list: FileList | File[]): void => {
    setNote(null);
    const files = [...list].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
    const room = MAX_FILES - items.filter((i) => i.state !== "saved").length;
    if (files.length > room) setNote(`Up to ${MAX_FILES} photos at a time: the first ${Math.max(room, 0)} were added.`);
    const next = files.slice(0, Math.max(room, 0)).map((file) => {
      const url = URL.createObjectURL(file);
      urls.current.push(url);
      return { key: `${file.name}-${file.size}-${Math.random()}`, file, url, title: nameFromFile(file.name), sizes: "", state: "ready" as const };
    });
    setItems((cur) => [...cur.filter((i) => i.state !== "saved"), ...next]);
  };

  const set = (key: string, patch: Partial<Item>): void => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const pending = items.filter((i) => i.state === "ready" || i.state === "error");
  const missing = pending.filter((i) => i.title.trim().length < 2).length;
  const saved = items.filter((i) => i.state === "saved").length;

  const saveAll = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    const queue = [...pending];
    // Three at a time: fast, without flooding a phone connection.
    const worker = async (): Promise<void> => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        set(it.key, { state: "saving", error: undefined });
        try {
          const blob = await prepareProductPhoto(it.file);
          const fd = new FormData();
          fd.set("title", it.title.trim());
          if (it.sizes.trim()) fd.set("sizes", it.sizes.trim());
          fd.set("photo", blob, it.file.name.replace(/\.[a-z0-9]+$/i, "") + (blob === it.file ? "" : ".jpg"));
          await upload(fd);
          set(it.key, { state: "saved" });
        } catch (e) {
          set(it.key, { state: "error", error: errorText(e instanceof Error ? e.message : "") });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setBusy(false);
    await onDone();
  };

  const failed = items.filter((i) => i.state === "error").length;

  return (
    <div className="card bulk">
      <h2>Add many products</h2>
      <p className="small muted">Choose all your product photos at once, give each a name, and save them together.</p>
      <div
        className={`drop${drag ? " over" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <button type="button" className="btn ghost" onClick={() => input.current?.click()} disabled={busy}>
          Choose photos
        </button>
        <span className="small muted">or drag them here · JPG, PNG or WEBP</span>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          hidden
          aria-label="Product photos"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {note && <p className="small muted">{note}</p>}

      {items.length > 0 && (
        <>
          <ul className="bulk-grid">
            {items.map((i, n) => (
              <li key={i.key} className={`bulk-item ${i.state}`}>
                <img src={i.url} alt="" />
                <label className="sr-only" htmlFor={`bulk-t-${i.key}`}>
                  Name for photo {n + 1}
                </label>
                <input
                  id={`bulk-t-${i.key}`}
                  placeholder="Product name"
                  value={i.title}
                  maxLength={200}
                  disabled={busy || i.state === "saved"}
                  onChange={(e) => set(i.key, { title: e.target.value })}
                />
                {sizes && (
                  <>
                    <label className="sr-only" htmlFor={`bulk-s-${i.key}`}>
                      Sizes for photo {n + 1}
                    </label>
                    <input
                      id={`bulk-s-${i.key}`}
                      placeholder="Sizes (optional): S, M, L"
                      value={i.sizes}
                      maxLength={120}
                      disabled={busy || i.state === "saved"}
                      onChange={(e) => set(i.key, { sizes: e.target.value })}
                    />
                  </>
                )}
                <p className={`small bulk-state ${i.state}`} role={i.state === "error" ? "alert" : undefined}>
                  {i.state === "saving" ? "Saving…" : i.state === "saved" ? "✓ Saved" : i.state === "error" ? i.error : ""}
                </p>
                {i.state !== "saved" && !busy && (
                  <button type="button" className="bulk-remove" aria-label={`Remove photo ${n + 1}`} onClick={() => setItems((cur) => cur.filter((x) => x.key !== i.key))}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="row bulk-actions">
            <button className="btn" type="button" disabled={busy || pending.length === 0 || missing > 0} onClick={() => void saveAll()}>
              {busy ? `Saving… ${saved} of ${items.length} done` : failed ? `Try again (${failed})` : `Save all ${pending.length} products`}
            </button>
            {!busy && missing > 0 && (
              <span className="small muted">
                {missing} {missing === 1 ? "photo needs" : "photos need"} a name.
              </span>
            )}
            {!busy && pending.length === 0 && saved > 0 && <span className="small">All {saved} saved. We're testing them now.</span>}
          </div>
        </>
      )}
    </div>
  );
}
