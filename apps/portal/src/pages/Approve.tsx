import { useEffect, useRef, useState } from "react";
import { go } from "../main.js";
import { api, atOrAfter, type Me, type Product } from "../api.js";
import { ProductName } from "../Rename.js";

interface Shot {
  src: string;
  label: string;
  ai: boolean;
}

/** Full-size view of one product's pictures; arrows move between them. Native <dialog>: focus trap and Escape for free. */
function Viewer({
  title,
  shots,
  start,
  onClose,
}: {
  title: string;
  shots: Shot[];
  start: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [i, setI] = useState(start);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const go = (step: number) =>
    setI((n) => (n + step + shots.length) % shots.length);
  const shot = shots[i]!;
  return (
    <dialog
      ref={ref}
      className="viewer"
      aria-label={`${title}: ${shot.label}`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close(); // tap outside the picture
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(1);
        if (e.key === "ArrowLeft") go(-1);
      }}
    >
      <div className="viewer-top">
        <p>
          <strong>{title}</strong> · {shot.label}{" "}
          <span className="muted">
            ({i + 1} of {shots.length})
          </span>
        </p>
        <button
          className="btn small ghost"
          onClick={() => ref.current?.close()}
          autoFocus
        >
          Close
        </button>
      </div>
      <figure className="viewer-shot">
        {shot.ai && <span className="chip">AI preview</span>}
        <img
          src={shot.src}
          alt={`${title}, ${shot.label}`}
          referrerPolicy="no-referrer"
        />
      </figure>
      {shots.length > 1 && (
        <div className="row" style={{ justifyContent: "center" }}>
          <button
            className="btn small ghost"
            onClick={() => go(-1)}
            aria-label="Previous picture"
          >
            ← Previous
          </button>
          <button
            className="btn small ghost"
            onClick={() => go(1)}
            aria-label="Next picture"
          >
            Next →
          </button>
        </div>
      )}
    </dialog>
  );
}

export function Approve({
  me,
  refresh,
}: {
  me: Me;
  refresh: () => Promise<void>;
}) {
  const [list, setList] = useState<Product[] | null>(null);
  const [open, setOpen] = useState<{
    title: string;
    shots: Shot[];
    start: number;
  } | null>(null);
  const load = async () =>
    setList(
      (await api<{ products: Product[] }>("/products")).products.filter(
        (p) => p.selected,
      ),
    );
  useEffect(() => void load(), []);
  // While any product is being (re)tested, check back every 10 seconds so its previews appear on their own.
  const testing = list?.some((p) => p.result === "pending") ?? false;
  useEffect(() => {
    if (!testing) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [testing]);
  const [note, setNote] = useState<Record<string, string>>({});

  if (!list) return <p className="muted">Loading…</p>;
  if (!atOrAfter(me.step, "products_tested"))
    return (
      <div className="card">
        <h1>
          Previews <span className="soft">are on their way</span>
        </h1>
        <p>
          We're still testing your products. We'll email you when they're ready
          to approve.
        </p>
      </div>
    );

  if (list.length === 0)
    return (
      <>
        <h1>
          Approve <span className="soft">your previews</span>
        </h1>
        <div className="card empty-card">
          <h2>Nothing to approve yet</h2>
          <p className="muted">Add your products and we'll test them. Their previews appear here for you to approve, usually within 10 minutes.</p>
          <button className="btn" onClick={() => go("/portal/products")}>
            Add products
          </button>
        </div>
      </>
    );

  const retest = async (id: string) => {
    try {
      await api(`/products/${id}/retest`, { body: {} });
      setNote((n) => ({ ...n, [id]: "" }));
      await load();
    } catch {
      setNote((n) => ({ ...n, [id]: "Couldn't start a new test. Message us in Support and we'll take a look." }));
    }
  };

  const decide = async (id: string, decision: "approved" | "hidden") => {
    await api(`/products/${id}/decision`, { body: { decision } });
    await load();
    await refresh(); // the first approval puts the brand live
  };

  return (
    <>
      <h1>
        Approve <span className="soft">your previews</span>
      </h1>
      <p>
        {me.account.category === "home"
          ? "These are AI previews in our test rooms."
          : "These are AI previews on our test models."}{" "}
        Tap any picture to see it full size. Approve the ones you'd be happy for
        shoppers to see. You can change this any time.
      </p>
      <div className="grid">
        {list.map((p) => (
          <article
            key={p.id}
            className="card"
            style={{ margin: 0 }}
            aria-label={p.title}
          >
            <ProductName id={p.id} title={p.title} onSaved={load} />
            <div className="thumbs">
              {(() => {
                const shots: Shot[] = [
                  ...(p.image
                    ? [{ src: p.image, label: "Your photo", ai: false }]
                    : []),
                  ...p.tests.map((src, i) => ({
                    src,
                    label: `${me.account.category === "home" ? "In room" : "On model"} ${String.fromCharCode(65 + i)}`,
                    ai: true,
                  })),
                ];
                return shots.map((shot, i) => (
                  <figure className="shot" key={shot.src}>
                    <button
                      type="button"
                      className="preview zoom"
                      onClick={() =>
                        setOpen({ title: p.title, shots, start: i })
                      }
                      aria-label={`Enlarge ${shot.label.toLowerCase()} of ${p.title}`}
                    >
                      {shot.ai && <span className="chip mini">AI preview</span>}
                      <img src={shot.src} alt="" referrerPolicy="no-referrer" />
                    </button>
                    <figcaption>{shot.label}</figcaption>
                  </figure>
                ));
              })()}
            </div>
            {p.result === "review" && (
              <p className="small muted" style={{ margin: "10px 0 0" }}>
                Our automatic check wasn't sure about this one. Look closely at the previews: approve it if you're happy, or test it again.
              </p>
            )}
            {(p.result === "passed" || (p.result === "review" && p.tests.length > 0)) && (
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className={`btn small ${p.decision === "approved" ? "chosen" : ""}`}
                  aria-pressed={p.decision === "approved"}
                  onClick={() => decide(p.id, "approved")}
                >
                  {p.decision === "approved" ? "✓ Approved" : "Approve"}
                </button>
                <button
                  className={`btn small ghost ${p.decision === "hidden" ? "chosen-off" : ""}`}
                  aria-pressed={p.decision === "hidden"}
                  onClick={() => decide(p.id, "hidden")}
                >
                  {p.decision === "hidden" ? "Hidden" : "Hide"}
                </button>
                {p.result === "review" && p.retestsLeft > 0 && (
                  <button type="button" className="btn small ghost" onClick={() => void retest(p.id)}>
                    Test again
                  </button>
                )}
              </div>
            )}
            {p.result === "failed" && (
              <p className="small warn">
                {p.reason ?? "Our AI couldn't make a good preview from this photo."}
                {p.retestsLeft > 0 && p.reason !== "This product can't be shown in try-on (content rules)."
                  ? " AI previews vary, so a new test often works. A clear photo of just the product helps too."
                  : " Message us in Support and we'll take a look."}
              </p>
            )}
            {p.result === "failed" && p.retestsLeft > 0 && p.reason !== "This product can't be shown in try-on (content rules)." && (
              <p style={{ margin: "10px 0 0" }}>
                <button type="button" className="btn small ghost" onClick={() => void retest(p.id)}>
                  Test again
                </button>
              </p>
            )}
            {note[p.id] && (
              <p className="small warn" role="alert">
                {note[p.id]}
              </p>
            )}
            {p.result === "pending" && (
              <p className="small muted" role="status">Making new previews… this takes about a minute.</p>
            )}
          </article>
        ))}
      </div>
      {open && (
        <Viewer
          title={open.title}
          shots={open.shots}
          start={open.start}
          onClose={() => setOpen(null)}
        />
      )}
      {!atOrAfter(me.step, "products_approved") ? (
        <p className="note" style={{ marginTop: 16 }}>
          Approve the products you're happy with: each one goes live on your
          try-on link as soon as you approve it.
        </p>
      ) : (
        <div className="note" style={{ marginTop: 16 }}>
          <p style={{ margin: 0 }}>
            Approved products are live on your try-on link straight away. Hide a
            product to take it off.
          </p>
          <p style={{ margin: "8px 0 0" }}>
            <a
              href="/portal/products"
              onClick={(e) => {
                e.preventDefault();
                go("/portal/products");
              }}
            >
              Add more products
            </a>
          </p>
        </div>
      )}
    </>
  );
}
