/**
 * Home décor: the product's real size, which room previews keep (e.g. "height 35 cm, diameter 15 cm").
 * Garrab reads it from the shop's text; the brand can correct or add it. After a change, "Test again" shows
 * the product at the new size.
 */
import { useState } from "react";
import { api } from "./api.js";

export function ProductSize({ id, size, byBrand, onSaved }: { id: string; size: string | null; byBrand: boolean; onSaved: () => void | Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(size ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!editing)
    return (
      <p className="small size-line">
        <span className={size ? "" : "warn-text"}>
          Size: {size ?? "not found. Add it so previews show the right size"}
          {size && !byBrand ? <span className="muted"> (read from your shop)</span> : null}
        </span>{" "}
        <button
          type="button"
          className="linkish small"
          aria-label={`${size ? "Change" : "Add"} the size`}
          onClick={() => {
            setValue(size ?? "");
            setSaved(false);
            setEditing(true);
          }}
        >
          {size ? "Change" : "Add size"}
        </button>
        {saved && <span className="muted" role="status"> Saved. Use “Test again” on Approve to see it at this size.</span>}
      </p>
    );

  return (
    <form
      className="rename"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api(`/products/${id}/size`, { body: { size: value } });
          setEditing(false);
          setSaved(true);
          await onSaved();
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={`sz-${id}`} className="small">
        Real size (e.g. “height 35 cm, diameter 15 cm” or “160 × 230 cm”)
      </label>
      <input id={`sz-${id}`} autoFocus maxLength={80} value={value} placeholder="height 35 cm" onChange={(e) => setValue(e.target.value)} />
      <div className="row">
        <button className="btn small" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save size"}
        </button>
        <button className="btn small ghost" type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Leave it empty and save to let Garrab read it from your shop again.</p>
    </form>
  );
}
