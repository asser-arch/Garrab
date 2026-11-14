import { useEffect, useState } from "react";
import { api, atOrAfter, type Me, type Product } from "../api.js";

export function Products({ me, refresh }: { me: Me; refresh: () => Promise<void> }) {
  const [list, setList] = useState<Product[] | null>(null);
  const [max, setMax] = useState<number | null>(10);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", imageUrl: "", productUrl: "" });
  const locked = atOrAfter(me.step, "products_approved");

  const load = async () => {
    const r = await api<{ products: Product[]; maxProducts: number | null }>("/products");
    setList(r.products);
    setMax(r.maxProducts);
    setChosen(new Set(r.products.filter((p) => p.selected).map((p) => p.id)));
  };
  useEffect(() => void load(), []);

  if (!list) return <p className="muted">Loading…</p>;
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else if (max === null || next.size < max) next.add(id);
    setChosen(next);
  };

  return (
    <>
      <h1>
        Your products <span className="soft">for try-on</span>
      </h1>
      {msg && (
        <p className="note" role="status">
          {msg}
        </p>
      )}
      {list.length > 0 && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>
              Chosen {chosen.size}
              {max !== null ? ` of ${max}` : ""}
            </h2>
            {!locked && (
              <button
                className="btn"
                onClick={async () => {
                  await api("/products/select", { body: { ids: [...chosen] } });
                  setMsg("Saved. We'll test any new products on our models now.");
                  await load();
                  await refresh();
                }}
              >
                Save my choice
              </button>
            )}
          </div>
          <p className="small muted">We picked the products with the most photos first. Swap any you like before approving.</p>
          <div className="grid">
            {list.map((p) => (
              <label key={p.id} className="card" style={{ margin: 0, cursor: locked ? "default" : "pointer", fontWeight: 400 }}>
                {p.image && <img src={p.image} alt="" style={{ width: "100%", aspectRatio: "4/5", objectFit: "cover", borderRadius: 12 }} referrerPolicy="no-referrer" />}
                <span className="row" style={{ marginTop: 8 }}>
                  <input type="checkbox" style={{ width: 20, minHeight: 20 }} checked={chosen.has(p.id)} disabled={locked || (p.tested && p.selected)} onChange={() => toggle(p.id)} />
                  <span>{p.title}</span>
                </span>
                {p.kind === "decor" && <span className="chip lavender">Room preview: coming soon</span>}
              </label>
            ))}
          </div>
        </div>
      )}
      {!locked && (
        <div className="card">
          <h2>Add a product by hand</h2>
          <p className="small muted">For Instagram and WhatsApp shops, or products we couldn't read. Use a clear photo of the product on a plain background.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/products", { body: { title: form.title, imageUrl: form.imageUrl, productUrl: form.productUrl || undefined } });
                setForm({ title: "", imageUrl: "", productUrl: "" });
                setMsg("Added. We'll test it on our models now.");
                await load();
                await refresh();
              } catch (err) {
                setMsg(err instanceof Error && err.message === "limit_reached" ? `You can have up to ${max ?? "unlimited"} products right now.` : "Please check the fields and try again.");
              }
            }}
          >
            <label htmlFor="t">Product name</label>
            <input id="t" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <label htmlFor="i">Photo link (https://…)</label>
            <input id="i" type="url" required value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} />
            <label htmlFor="u">Where people buy it (optional)</label>
            <input id="u" type="url" value={form.productUrl} onChange={(e) => setForm({ ...form, productUrl: e.target.value })} />
            <p>
              <button className="btn" type="submit">
                Add product
              </button>
            </p>
          </form>
          <h2>Or upload a CSV</h2>
          <p className="small muted">Columns: name, photo link, product link, description.</p>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Upload CSV"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const r = await api<{ added: number; skipped: number }>("/products/csv", { raw: await f.text() });
              setMsg(`Added ${r.added} products${r.skipped ? `, skipped ${r.skipped} rows we couldn't read` : ""}.`);
              await load();
              await refresh();
            }}
          />
        </div>
      )}
    </>
  );
}
