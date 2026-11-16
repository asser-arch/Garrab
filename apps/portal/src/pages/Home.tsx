import { useEffect } from "react";
import { go } from "../main.js";
import type { Me } from "../api.js";

function NextAction({ me }: { me: Me }) {
  const social = me.account.platform === "social_only" || !me.account.website;
  switch (me.step) {
    case "invited":
    case "account_created":
      return social ? (
        <>
          <h2>Add your products</h2>
          <p>
            Add up to 10 products: a name, a photo and the link where people
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
              ? "We're placing each product in two test rooms and checking the results."
              : "We're trying each product on two test models and checking the results."}{" "}
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
  return (
    <>
      <h1>
        Welcome, <span className="soft">{me.account.name}</span>
      </h1>
      <div className="card dark">
        <NextAction me={me} />
      </div>
      <div className="grid">
        <div className="card">
          <h2>Setup</h2>
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
        </div>
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
