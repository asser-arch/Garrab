import { useEffect, useState } from "react";
import { api } from "../api.js";

interface Billing {
  status: string;
  plan: { name: string; price: number; previews: number };
  paidThrough: string | null;
  pilotEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  usage: { used: number; included: number; extra: number };
  canBuyPack: boolean;
  pack: { previews: number; price: number };
  pendingClaim: { number: string } | null;
  invoices: { number: string; kind: string; total: number; status: string; dueDate: string; period: string | null; payUrl: string; pdfUrl: string }[];
}

const egp = (p: number): string => `${(p / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP`;

const STATUS_TEXT: Record<string, string> = {
  pilot: "Pilot",
  active: "Active",
  past_due: "Payment late: try-on still on",
  suspended: "Switched off: payment needed",
  expired: "Pilot ended",
  archived: "Switched off",
  paused: "Paused by Garrab",
  cancelled: "Cancelled",
  onboarding: "Setting up",
};

export function Billing() {
  const [b, setB] = useState<Billing | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => setB(await api<Billing>("/billing"));
  useEffect(() => void load(), []);
  if (!b) return <p className="muted">Loading…</p>;

  const total = b.usage.included + b.usage.extra;
  const off = ["suspended", "expired", "archived", "cancelled"].includes(b.status);
  const open = b.invoices.find((i) => i.status === "open" && i.kind === "plan");

  return (
    <>
      <h1>
        Billing <span className="soft">and plan</span>
      </h1>
      {msg && (
        <p className="note" role="status">
          {msg}
        </p>
      )}
      <div className={`card ${off ? "dark" : ""}`}>
        <p className="small" style={{ opacity: 0.8 }}>
          {STATUS_TEXT[b.status] ?? b.status}
        </p>
        <h2>
          {b.plan.name}: {egp(b.plan.price)} a month, {b.plan.previews} previews
        </h2>
        <p>
          {b.paidThrough
            ? b.cancelAtPeriodEnd
              ? `Ends on ${b.paidThrough}. No more invoices.`
              : `Paid until ${b.paidThrough}. Payment is due before each month starts.`
            : b.pilotEndsAt
              ? `Your free pilot ends on ${b.pilotEndsAt.slice(0, 10)}.`
              : "Your pilot starts when your first product goes live."}
        </p>
        {b.pendingClaim ? (
          <p className="note">We're confirming your InstaPay transfer for {b.pendingClaim.number}. Try-on stays on while we check.</p>
        ) : (
          b.status !== "onboarding" &&
          (open || off || b.status === "pilot" || b.status === "past_due") && (
            <button
              className={`btn ${off ? "accent" : ""}`}
              onClick={async () => {
                const r = await api<{ payUrl: string }>("/billing/pay-now", { body: {} });
                location.href = r.payUrl;
              }}
            >
              {off ? "Pay and switch back on" : "Pay now"}
            </button>
          )
        )}
      </div>

      <div className="grid">
        <div className="card">
          <h2>Previews this month</h2>
          <p className="stat">
            {b.usage.used} <span className="muted small">of {total}</span>
          </p>
          {b.canBuyPack && (
            <>
              <p className="small muted">
                At 100% previews pause until next month. Add {b.pack.previews} more for {egp(b.pack.price)}; they unlock when paid.
              </p>
              <button
                className="btn small ghost"
                onClick={async () => {
                  const r = await api<{ payUrl: string }>("/billing/pack", { body: {} });
                  location.href = r.payUrl;
                }}
              >
                Add {b.pack.previews} previews
              </button>
            </>
          )}
        </div>
        <div className="card">
          <h2>Plan</h2>
          <p className="small muted">Month to month. Cancel any time; it ends at the end of the paid month.</p>
          {b.cancelAtPeriodEnd ? (
            <button
              className="btn small"
              onClick={async () => {
                await api("/billing/resume", { body: {} });
                setMsg("Your plan will continue.");
                await load();
              }}
            >
              Keep my plan
            </button>
          ) : (
            (b.status === "active" || b.status === "past_due" || b.status === "pilot") && (
              <button
                className="btn small ghost"
                onClick={async () => {
                  if (!confirm("Cancel at the end of your paid period? Try-on switches off then.")) return;
                  const r = await api<{ until: string | null }>("/billing/cancel", { body: {} });
                  setMsg(r.until ? `Cancelled. Try-on stays on until ${r.until.slice(0, 10)}.` : "Cancelled.");
                  await load();
                }}
              >
                Cancel plan
              </button>
            )
          )}
        </div>
      </div>

      <div className="card">
        <h2>Invoices</h2>
        {b.invoices.length === 0 ? (
          <p className="muted">No invoices yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Invoice</th>
                <th>For</th>
                <th>Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {b.invoices.map((i) => (
                <tr key={i.number}>
                  <td>{i.number}</td>
                  <td className="small">{i.kind === "pack" ? "Extra previews" : (i.period ?? "First month")}</td>
                  <td>{egp(i.total)}</td>
                  <td>{i.status === "paid" ? <span className="chip mint">Paid</span> : <span className="chip peach">Due {i.dueDate}</span>}</td>
                  <td className="row">
                    {i.status === "open" && (
                      <a className="btn small" href={i.payUrl}>
                        Pay
                      </a>
                    )}
                    <a className="small" href={i.pdfUrl}>
                      PDF
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
