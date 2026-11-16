import { useEffect, useState } from "react";
import { api } from "../api.js";

interface Totals {
  views: number;
  started: number;
  previews: number;
  buys: number;
}
interface Report {
  brand: string;
  from: string;
  to: string;
  days: number;
  totals: Totals;
  byDay: { day: string; previews: number; views: number }[];
  products: (Totals & { id: string; title: string; image: string | null })[];
  rates: { tryRate: number | null; buyRate: number | null };
  pilot: { startedAt: string | null; endsAt: string | null } | null;
}

const n = (x: number): string => x.toLocaleString("en-US");
const short = (d: string): string => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const rate = (x: number | null): string => (x === null ? "–" : `${x}%`);

/** Single-series daily bars (forest on paper). Hover/focus shows the exact value; a table carries the same data. */
function DailyChart({ days }: { days: Report["byDay"] }) {
  const max = Math.max(1, ...days.map((d) => d.previews));
  const [hover, setHover] = useState<number | null>(null);
  const tickEvery = days.length > 16 ? 7 : days.length > 8 ? 2 : 1;
  return (
    <figure className="daychart" aria-label="Previews per day">
      <div className="daychart-plot" role="img" aria-label={`Previews per day, highest ${max}`}>
        {days.map((d, i) => (
          <div
            key={d.day}
            className="daychart-col"
            tabIndex={0}
            aria-label={`${short(d.day)}: ${d.previews} previews, ${d.views} views`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <div className={`daychart-bar${d.previews === 0 ? " zero" : ""}`} style={{ height: `${Math.max(d.previews ? 4 : 2, (d.previews / max) * 100)}%` }} />
            {hover === i && (
              <div className="daychart-tip" role="status">
                <strong>{n(d.previews)}</strong> previews
                <br />
                <span className="muted">
                  {short(d.day)} · {n(d.views)} views
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="daychart-axis" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.day}>{i % tickEvery === 0 || i === days.length - 1 ? short(d.day) : ""}</span>
        ))}
      </div>
    </figure>
  );
}

export function Results() {
  const [r, setR] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<Report>("/results").then(setR, () => setFailed(true));
  }, []);

  if (failed) return <p className="warn">We couldn't load your results. Please refresh the page.</p>;
  if (!r) return <p className="muted">Loading…</p>;
  const t = r.totals;
  const empty = t.views === 0 && t.previews === 0;

  return (
    <div className="results">
      <div className="row results-head" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <h1>
            Results <span className="soft">{r.pilot ? "of your pilot" : "for the last 30 days"}</span>
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            {r.brand} · {short(r.from)} – {short(r.to)} {r.to.slice(0, 4)}
          </p>
        </div>
        <button className="btn ghost small no-print" onClick={() => print()}>
          Save as PDF
        </button>
      </div>

      {empty && (
        <p className="note">
          No shopper has reached your try-on yet. Put your try-on link in your Instagram bio and share it in a story: that's where most try-ons start.
        </p>
      )}

      <div className="kpis">
        <div className="kpi mist">
          <span className="kpi-label">Views</span>
          <span className="kpi-value">{n(t.views)}</span>
          <span className="kpi-note">Shoppers who saw the try-on</span>
        </div>
        <div className="kpi lavender">
          <span className="kpi-label">Try-ons started</span>
          <span className="kpi-value">{n(t.started)}</span>
          <span className="kpi-note">Uploaded a photo</span>
        </div>
        <div className="kpi mint">
          <span className="kpi-label">Previews</span>
          <span className="kpi-value">{n(t.previews)}</span>
          <span className="kpi-note">AI previews created</span>
        </div>
        <div className="kpi peach">
          <span className="kpi-label">Buy taps</span>
          <span className="kpi-value">{n(t.buys)}</span>
          <span className="kpi-note">Tapped Buy after a preview</span>
        </div>
      </div>

      <div className="card rates">
        <div>
          <span className="rate-value">{rate(r.rates.tryRate)}</span>
          <span className="muted small">of viewers started a try-on</span>
        </div>
        <div>
          <span className="rate-value">{rate(r.rates.buyRate)}</span>
          <span className="muted small">of previews led to a Buy tap</span>
        </div>
      </div>

      <div className="card">
        <h2>Previews per day</h2>
        <DailyChart days={r.byDay} />
        <details className="no-print">
          <summary className="small">Show as a table</summary>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Views</th>
                <th scope="col">Previews</th>
              </tr>
            </thead>
            <tbody>
              {r.byDay.map((d) => (
                <tr key={d.day}>
                  <td>{short(d.day)}</td>
                  <td>{n(d.views)}</td>
                  <td>{n(d.previews)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>

      <div className="card">
        <h2>Products</h2>
        {r.products.length === 0 ? (
          <p className="muted">No product has been tried on yet.</p>
        ) : (
          <table className="data products-table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Views</th>
                <th scope="col">Try-ons</th>
                <th scope="col">Previews</th>
                <th scope="col">Buy taps</th>
              </tr>
            </thead>
            <tbody>
              {r.products.map((p, i) => (
                <tr key={p.id}>
                  <th scope="row">
                    <span className="prod">
                      <span className={`rank${i === 0 ? " top" : ""}`}>{i + 1}</span>
                      {p.image ? <img src={p.image} alt="" referrerPolicy="no-referrer" /> : <span className="noimg" />}
                      <span>{p.title}</span>
                    </span>
                  </th>
                  <td>{n(p.views)}</td>
                  <td>{n(p.started)}</td>
                  <td>
                    <strong>{n(p.previews)}</strong>
                  </td>
                  <td>{n(p.buys)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="small muted">
        Counts are anonymous: we never know who your shoppers are. "Views" counts shoppers who saw the Try it on button on your website or opened your try-on link.
      </p>
    </div>
  );
}
