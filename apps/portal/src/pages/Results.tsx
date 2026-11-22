import { useEffect, useState } from "react";
import { api } from "../api.js";

interface Totals {
  shoppers?: number;
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
  byDay: { day: string; previews: number; views: number; shoppers: number }[];
  products: (Totals & { id: string; title: string; image: string | null })[];
  rates: { tryRate: number | null; buyRate: number | null };
  pilot: { startedAt: string | null; endsAt: string | null } | null;
}

const n = (x: number): string => x.toLocaleString("en-US");
const short = (d: string): string => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const rate = (x: number | null): string => (x === null ? "–" : `${x}%`);

// ---------------------------------------------------------------- period filter (Cairo days)

export type Preset = "7d" | "30d" | "month" | "lastMonth" | "pilot" | "custom";
const cairoToday = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const plusDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The from/to (inclusive) of a preset; null = the server's default (pilot so far, or last 30 days). */
export function presetRange(p: Preset, pilotStart: string | null): { from: string; to: string } | null {
  const today = cairoToday();
  if (p === "7d") return { from: plusDays(today, -6), to: today };
  if (p === "30d") return { from: plusDays(today, -29), to: today };
  if (p === "month") return { from: `${today.slice(0, 8)}01`, to: today };
  if (p === "lastMonth") {
    const firstThis = `${today.slice(0, 8)}01`;
    const lastPrev = plusDays(firstThis, -1);
    return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev };
  }
  if (p === "pilot" && pilotStart) return { from: new Date(pilotStart).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" }), to: today };
  return null;
}

export function PeriodFilter({
  preset,
  setPreset,
  custom,
  setCustom,
  pilot,
}: {
  preset: Preset;
  setPreset: (p: Preset) => void;
  custom: { from: string; to: string };
  setCustom: (c: { from: string; to: string }) => void;
  pilot: boolean;
}) {
  const options: [Preset, string][] = [
    ["7d", "Last 7 days"],
    ["30d", "Last 30 days"],
    ["month", "This month"],
    ["lastMonth", "Last month"],
    ...(pilot ? ([["pilot", "Whole pilot"]] as [Preset, string][]) : []),
    ["custom", "Custom dates"],
  ];
  return (
    <div className="period no-print">
      <label htmlFor="period" className="sr-only">
        Period
      </label>
      <select id="period" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {preset === "custom" && (
        <span className="period-custom">
          <label htmlFor="p-from" className="sr-only">
            From
          </label>
          <input id="p-from" type="date" max={custom.to || cairoToday()} value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
          <span aria-hidden="true">–</span>
          <label htmlFor="p-to" className="sr-only">
            To
          </label>
          <input id="p-to" type="date" min={custom.from} max={cairoToday()} value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
        </span>
      )}
    </div>
  );
}

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
  const [preset, setPreset] = useState<Preset | null>(null); // null = the server's default
  const [custom, setCustom] = useState({ from: plusDays(cairoToday(), -6), to: cairoToday() });
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const range = preset === "custom" ? (custom.from && custom.to && custom.from <= custom.to ? custom : undefined) : preset ? presetRange(preset, r?.pilot?.startedAt ?? null) : null;
    if (range === undefined) return; // custom dates not complete yet
    setLoading(true);
    api<Report>(range ? `/results?from=${range.from}&to=${range.to}` : "/results")
      .then((x) => {
        setR(x);
        if (preset === null) setPreset(x.pilot ? "pilot" : "30d");
      }, () => setFailed(true))
      .finally(() => setLoading(false));
  }, [preset, custom.from, custom.to]);

  if (failed) return <p className="warn">We couldn't load your results. Please refresh the page.</p>;
  if (!r) return <p className="muted">Loading…</p>;
  const t = r.totals;
  const empty = t.views === 0 && t.previews === 0;

  return (
    <div className="results">
      <div className="row results-head" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <h1>Results</h1>
          <p className="muted" style={{ margin: 0 }}>
            {r.brand} · {short(r.from)} – {short(r.to)} {r.to.slice(0, 4)}
          </p>
        </div>
        <div className="row no-print">
          {preset && <PeriodFilter preset={preset} setPreset={setPreset} custom={custom} setCustom={setCustom} pilot={!!r.pilot} />}
          <button className="btn ghost small" onClick={() => print()}>
            Save as PDF
          </button>
        </div>
      </div>
      {loading && <p className="small muted" role="status">Updating…</p>}

      {empty && (
        <p className="note">
          No shopper has reached your try-on yet. Put your try-on link in your Instagram bio and share it in a story: that's where most try-ons start.
        </p>
      )}

      <div className="kpis">
        <div className="kpi forest">
          <span className="kpi-label">Shoppers</span>
          <span className="kpi-value">{n(t.shoppers ?? 0)}</span>
          <span className="kpi-note">People who got a preview (each once a day)</span>
        </div>
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
                <th scope="col">Shoppers</th>
                <th scope="col">Views</th>
                <th scope="col">Previews</th>
              </tr>
            </thead>
            <tbody>
              {r.byDay.map((d) => (
                <tr key={d.day}>
                  <td>{short(d.day)}</td>
                  <td>{n(d.shoppers ?? 0)}</td>
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
        Counts are anonymous: we never know who your shoppers are. "Shoppers" counts each person once a day, using only a date kept on their own phone or computer. "Views" counts shoppers who saw the Try it on button on your website or opened your try-on link.
      </p>
    </div>
  );
}
