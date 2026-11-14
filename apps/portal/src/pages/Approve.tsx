import { useEffect, useState } from "react";
import { go } from "../main.js";
import { api, atOrAfter, type Me, type Product } from "../api.js";

export function Approve({ me, refresh }: { me: Me; refresh: () => Promise<void> }) {
  const [list, setList] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => setList((await api<{ products: Product[] }>("/products")).products.filter((p) => p.selected));
  useEffect(() => void load(), []);

  if (!list) return <p className="muted">Loading…</p>;
  if (!atOrAfter(me.step, "products_tested"))
    return (
      <div className="card">
        <h1>
          Previews <span className="soft">are on their way</span>
        </h1>
        <p>We're still testing your products. We'll email you when they're ready to approve.</p>
      </div>
    );

  const decide = async (id: string, decision: "approved" | "hidden") => {
    await api(`/products/${id}/decision`, { body: { decision } });
    await load();
  };
  const approved = list.filter((p) => p.decision === "approved" && p.result === "passed").length;

  return (
    <>
      <h1>
        Approve <span className="soft">your previews</span>
      </h1>
      <p>These are AI previews on our test models. Approve the ones you'd be happy for shoppers to see. You can change this any time.</p>
      <div className="grid">
        {list.map((p) => (
          <article key={p.id} className="card" style={{ margin: 0 }} aria-label={p.title}>
            <h2>{p.title}</h2>
            <div className="thumbs">
              {p.image && (
                <div className="preview">
                  <img src={p.image} alt={`${p.title}, product photo`} referrerPolicy="no-referrer" />
                </div>
              )}
              {p.tests.map((src, i) => (
                <div className="preview" key={src}>
                  <span className="chip">AI preview</span>
                  <img src={src} alt={`AI preview ${i + 1} of ${p.title} on a test model`} />
                </div>
              ))}
            </div>
            {p.result === "passed" && (
              <div className="row" style={{ marginTop: 12 }}>
                <button className={`btn small ${p.decision === "approved" ? "" : "ghost"}`} aria-pressed={p.decision === "approved"} onClick={() => decide(p.id, "approved")}>
                  {p.decision === "approved" ? "✓ Approved" : "Approve"}
                </button>
                <button className={`btn small ${p.decision === "hidden" ? "" : "ghost"}`} aria-pressed={p.decision === "hidden"} onClick={() => decide(p.id, "hidden")}>
                  {p.decision === "hidden" ? "Hidden" : "Hide"}
                </button>
              </div>
            )}
            {p.result === "review" && <p className="small muted">We're checking this one by hand and will let you know.</p>}
            {p.result === "failed" && <p className="small warn">Not available for try-on: {p.reason}</p>}
            {p.result === "pending" && <p className="small muted">Still testing…</p>}
          </article>
        ))}
      </div>
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      {!atOrAfter(me.step, "products_approved") ? (
        <p style={{ marginTop: 16 }}>
          <button
            className="btn accent"
            disabled={approved === 0}
            onClick={async () => {
              try {
                await api("/approve/confirm", { body: {} });
                await refresh();
                go("/portal/install");
              } catch {
                setError("Approve at least one product first.");
              }
            }}
          >
            Done: {approved} approved, go live next
          </button>
        </p>
      ) : (
        <p className="note" style={{ marginTop: 16 }}>
          Approved products go live as soon as Garrab is on your shop.
        </p>
      )}
    </>
  );
}
