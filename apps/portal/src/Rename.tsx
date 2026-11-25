/**
 * A product's name with a "Rename" button next to it: brands often upload photos named by their camera or
 * an app ("ChatGPT Image…", "IMG_2041"), so the name can be fixed any time after upload.
 */
import { useState } from "react";
import { api } from "./api.js";

export function ProductName({ id, title, as = "h2", onSaved }: { id: string; title: string; as?: "h2" | "span"; onSaved: () => void | Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Tag = as;

  if (!editing)
    return (
      <div className="name-row">
        <Tag className="name">{title}</Tag>
        <button
          type="button"
          className="linkish small"
          aria-label={`Rename ${title}`}
          onClick={() => {
            setValue(title);
            setError(null);
            setEditing(true);
          }}
        >
          Rename
        </button>
      </div>
    );

  const save = async (): Promise<void> => {
    const t = value.trim();
    if (t.length < 2) return setError("Give it a name of at least 2 letters.");
    if (t === title) return setEditing(false);
    setBusy(true);
    try {
      await api(`/products/${id}/rename`, { body: { title: t } });
      setEditing(false);
      await onSaved();
    } catch {
      setError("Didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="rename"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={`rn-${id}`} className="sr-only">
        Product name
      </label>
      <input
        id={`rn-${id}`}
        autoFocus
        maxLength={200}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
      />
      <div className="row">
        <button className="btn small" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save name"}
        </button>
        <button className="btn small ghost" type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="small warn" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
