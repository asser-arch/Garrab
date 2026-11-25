import { useEffect, useState } from "react";
import { go } from "../main.js";
import { api, atOrAfter, type Me } from "../api.js";

interface Week {
  totals: { shoppers?: number; previews: number; buys: number; views: number };
  products: { id: string; title: string; image: string | null; previews: number }[];
}

const cairoToday = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const daysAgo = (n: number): string => new Date(Date.parse(`${cairoToday()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Live brands: what Garrab did for them in the last 7 days, or what to do when nothing happened yet. */
function ThisWeek({ me }: { me: Me }) {
  const [w, setW] = useState<Week | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void api<Week>(`/results?from=${daysAgo(6)}&to=${cairoToday()}`).then(setW, () => undefined);
  }, []);
  if (!w) return null;
  const t = w.totals;
  const top = w.products[0];
  const quiet = t.views === 0 && t.previews === 0;
  return (
    <div className="card week">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>This week</h2>
        <button className="linkish small" onClick={() => go("/portal/results")}>
          See full results
        </button>
      </div>
      {quiet ? (
        <div className="empty-next">
          <p>
            <strong>No shoppers have reached your try-on yet this week.</strong> Most try-ons start from an Instagram story or the link in your bio.
          </p>
          {me.brandLink && (
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(me.brandLink!.url).then(() => setCopied(true));
              }}
            >
              {copied ? "Link copied ✓" : "Copy my try-on link"}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="week-stats">
            <div>
              <span className="week-value">{(t.shoppers ?? 0).toLocaleString("en-US")}</span>
              <span className="week-label">Shoppers</span>
            </div>
            <div>
              <span className="week-value">{t.previews.toLocaleString("en-US")}</span>
              <span className="week-label">Previews</span>
            </div>
            <div>
              <span className="week-value">{t.buys.toLocaleString("en-US")}</span>
              <span className="week-label">Buy taps</span>
            </div>
          </div>
          {top && top.previews > 0 && (
            <p className="week-top">
              {top.image && <img src={top.image} alt="" referrerPolicy="no-referrer" />}
              <span>
                <span className="small muted">Most tried</span>
                <br />
                <strong>{top.title}</strong> · {top.previews} previews
              </span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

function NextAction({ me }: { me: Me }) {
  const social = me.account.platform === "social_only" || !me.account.website;
  switch (me.step) {
    case "invited":
    case "account_created":
      return social ? (
        <>
          <h2>Add your products</h2>
          <p>
            Add your products: a name, a photo and the link where people
            buy. About 5 minutes.
          </p>
          <button className="btn" onClick={() => go("/portal/products")}>
            Add products
          </button>
        </>
      ) : (
        <>
          <h2>We're reading your products</h2>
          <p>
            This usually takes a minute or two. If we can't read your site, you
            can add products by hand.
          </p>
          <button className="btn ghost" onClick={() => go("/portal/products")}>
            See products
          </button>
        </>
      );
    case "products_imported":
      return (
        <>
          <h2>Testing your products</h2>
          <p>
            {me.account.category === "home"
              ? "We're placing each product in our test rooms and checking the results."
              : "We're trying each product on our test models and checking the results."}{" "}
            Usually under 10 minutes. This page updates by itself.
          </p>
        </>
      );
    case "products_tested":
      return (
        <>
          <h2>Your previews are ready</h2>
          <p>
            Approve the products you're happy with. Nothing goes live until you
            do.
          </p>
          <button className="btn" onClick={() => go("/portal/approve")}>
            Review previews
          </button>
        </>
      );
    case "products_approved":
      return (
        <>
          <h2>Add Garrab to your shop</h2>
          <p>One line of code. We'll check it for you.</p>
          <button className="btn" onClick={() => go("/portal/install")}>
            Show me how
          </button>
        </>
      );
    default:
      return (
        <>
          <h2>Your pilot is live</h2>
          {me.account.pilotEndsAt && (
            <p>
              {Math.max(
                0,
                Math.ceil(
                  (Date.parse(me.account.pilotEndsAt) - Date.now()) /
                    86_400_000,
                ),
              )}{" "}
              days left · ends{" "}
              {new Date(me.account.pilotEndsAt).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                timeZone: "Africa/Cairo",
              })}
            </p>
          )}
          <div className="row">
            <button
              className="btn accent"
              onClick={() => go("/portal/install")}
            >
              Get my try-on link
            </button>
            <button
              className="btn ghost"
              onClick={() => go("/portal/products")}
            >
              Add more products
            </button>
          </div>
        </>
      );
  }
}

export function Home({
  me,
  refresh,
}: {
  me: Me;
  refresh: () => Promise<void>;
}) {
  // While we work in the background, keep the page current.
  useEffect(() => {
    if (!["account_created", "products_imported", "invited"].includes(me.step))
      return;
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [me.step, refresh]);

  const n = me.usage ? me.usage.included + me.usage.extra : 0;
  const live = atOrAfter(me.step, "pilot_live");
  return (
    <>
      <h1>
        Welcome, <span className="soft">{me.account.name}</span>
      </h1>
      <div className="card dark">
        <NextAction me={me} />
      </div>
      {live && <ThisWeek me={me} />}
      <div className="grid">
        <details className="card setup" open={!live}>
          <summary>
            <h2>Setup</h2>
            {live && <span className="chip mint">All done</span>}
          </summary>
          <ol className="steps">
            {me.steps.map((s, i) => (
              <li key={s.step}>
                <span
                  className={`dot ${s.state === "done" || s.state === "overridden" ? "done" : s.state === "active" ? "active" : ""}`}
                  aria-hidden="true"
                >
                  {s.state === "done" || s.state === "overridden" ? "✓" : i + 1}
                </span>
                <span>
                  {s.label}
                  <span className="sr-only">
                    {" "}
                    (
                    {s.state === "pending"
                      ? "not started"
                      : s.state === "active"
                        ? "in progress"
                        : "done"}
                    )
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </details>
        <div className="card">
          <h2>
            Previews this {me.account.status === "pilot" ? "pilot" : "month"}
          </h2>
          {me.usage ? (
            <>
              <p className="stat">
                {me.usage.used} <span className="muted small">of {n}</span>
              </p>
              <p className="small muted">
                Previews pause at 100% until the next month, or until you add an
                extra pack.
              </p>
            </>
          ) : (
            <p className="muted">Starts when your pilot goes live.</p>
          )}
          <p className="small muted">Plan after the pilot: {me.account.plan}</p>
        </div>
      </div>
    </>
  );
}
