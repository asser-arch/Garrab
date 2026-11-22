/**
 * Usage per brand: shoppers, views, try-ons, previews, Buy taps and AI cost for a period.
 * Filters: period (presets or custom dates), status, brand name. Columns sort; a totals row on top.
 */
import { useEffect, useMemo, useState } from "react";
import { PeriodFilter, presetRange, type Preset } from "../../portal/src/pages/Results.js";

interface Row {
  id: string;
  name: string;
  status: string;
  plan: string;
  category: string;
  shoppers: number;
  views: number;
  started: number;
  previews: number;
  buys: number;
  aiUsd: number;
}
type Key = "name" | "shoppers" | "views" | "started" | "previews" | "buys" | "aiUsd";

const STATUS: Record<string, string> = {
  all: "All brands",
  pilot: "In free pilot",
  paying: "Paying",
  onboarding: "Setting up",
  off: "Switched off or ended",
};
const inStatus = (s: string, f: string): boolean =>
  f === "all" ||
  (f === "pilot" && s === "pilot") ||
  (f === "paying" && (s === "active" || s === "past_due")) ||
  (f === "onboarding" && s === "onboarding") ||
  (f === "off" && !["pilot", "active", "past_due", "onboarding"].includes(s));
const STATUS_NAME: Record<string, string> = {
  pilot: "Pilot",
  active: "Paying",
  past_due: "Payment due",
  onboarding: "Setting up",
  suspended: "Suspended",
  paused: "Paused",
  expired: "Pilot ended",
  cancelled: "Cancelled",
};
const n = (x: number): string => x.toLocaleString("en-US");
const cairoToday = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const short = (d: string): string => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function Usage({ openBrand }: { openBrand: (id: string) => void }) {
  const [preset, setPreset] = useState<Preset>("30d");
  const [custom, setCustom] = useState({ from: cairoToday().slice(0, 8) + "01", to: cairoToday() });
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: Key; desc: boolean }>({ key: "previews", desc: true });
  const [data, setData] = useState<{ from: string; to: string; rows: Row[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const range = preset === "custom" ? (custom.from && custom.to && custom.from <= custom.to ? custom : null) : presetRange(preset, null);
    if (!range) return;
    setErr(null);
    fetch(`/admin-api/usage?from=${range.from}&to=${range.to}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData, () => setErr("Couldn't load usage. Refresh to try again."));
  }, [preset, custom.from, custom.to]);

  const rows = useMemo(() => {
    const list = (data?.rows ?? []).filter((r) => inStatus(r.status, status) && r.name.toLowerCase().includes(q.trim().toLowerCase()));
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => (sort.key === "name" ? a.name.localeCompare(b.name) * dir : (a[sort.key] - b[sort.key]) * dir || a.name.localeCompare(b.name)));
  }, [data, status, q, sort]);
  const total = rows.reduce(
    (t, r) => ({ shoppers: t.shoppers + r.shoppers, views: t.views + r.views, started: t.started + r.started, previews: t.previews + r.previews, buys: t.buys + r.buys, aiUsd: t.aiUsd + r.aiUsd }),
    { shoppers: 0, views: 0, started: 0, previews: 0, buys: 0, aiUsd: 0 },
  );

  const head = (key: Key, label: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className="sort" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : key !== "name" })}>
        {label}
        <span aria-hidden="true">{sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}</span>
      </button>
    </th>
  );

  const csv = (): void => {
    const lines = [
      ["Brand", "Status", "Plan", "Shoppers", "Views", "Try-ons started", "Previews", "Buy taps", "AI cost (USD)"].join(","),
      ...rows.map((r) => [`"${r.name.replace(/"/g, '""')}"`, STATUS_NAME[r.status] ?? r.status, r.plan, r.shoppers, r.views, r.started, r.previews, r.buys, r.aiUsd.toFixed(2)].join(",")),
    ];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `garrab-usage-${data?.from}-to-${data?.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Usage <span className="soft">per brand</span>
          </h1>
          <p className="small muted">
            {data ? `${short(data.from)} – ${short(data.to)}. ` : ""}Shoppers counts each person who got a preview once a day (no personal data). Click a brand
            for its details.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="usage-filters">
          <PeriodFilter preset={preset} setPreset={setPreset} custom={custom} setCustom={setCustom} pilot={false} />
          <label htmlFor="u-status" className="sr-only">
            Status
          </label>
          <select id="u-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {Object.entries(STATUS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <label htmlFor="u-q" className="sr-only">
            Search brands
          </label>
          <input id="u-q" type="search" placeholder="Search brands" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className="btn ghost small" onClick={csv} disabled={!rows.length}>
            Download CSV
          </button>
        </div>
        {err && (
          <p className="warn" role="alert">
            {err}
          </p>
        )}
        {!data && !err && <p className="small muted">Loading…</p>}
        {data && rows.length === 0 && <p className="small muted">No brands match these filters.</p>}
        {data && rows.length > 0 && (
          <div className="table-wrap">
            <table className="usage">
              <thead>
                <tr>
                  {head("name", "Brand")}
                  <th scope="col">Status</th>
                  {head("shoppers", "Shoppers")}
                  {head("views", "Views")}
                  {head("started", "Try-ons")}
                  {head("previews", "Previews")}
                  {head("buys", "Buy taps")}
                  {head("aiUsd", "AI cost")}
                </tr>
              </thead>
              <tbody>
                <tr className="total">
                  <td>
                    All {rows.length} {rows.length === 1 ? "brand" : "brands"}
                  </td>
                  <td />
                  <td>{n(total.shoppers)}</td>
                  <td>{n(total.views)}</td>
                  <td>{n(total.started)}</td>
                  <td>{n(total.previews)}</td>
                  <td>{n(total.buys)}</td>
                  <td>{total.aiUsd.toFixed(2)} USD</td>
                </tr>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a href={`#account=${r.id}`} onClick={(e) => (e.preventDefault(), openBrand(r.id))}>
                        {r.name}
                      </a>
                      <span className="small muted"> · {r.plan}</span>
                    </td>
                    <td>
                      <span className="chip">{STATUS_NAME[r.status] ?? r.status}</span>
                    </td>
                    <td>
                      <strong>{n(r.shoppers)}</strong>
                    </td>
                    <td>{n(r.views)}</td>
                    <td>{n(r.started)}</td>
                    <td>{n(r.previews)}</td>
                    <td>{n(r.buys)}</td>
                    <td>{r.aiUsd.toFixed(2)} USD</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
