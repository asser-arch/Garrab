/**
 * Billing by hand: record a payment the brand already made (InstaPay seen in the app, bank transfer, cash),
 * or make an invoice to send. Any plan, 1–12 months, any price (discounts, custom deals).
 * Brand still in its pilot: choose whether the paid months start counting now or after the pilot ends.
 */
import { PLANS, SETUP_FEE } from "@garrab/shared/plans";
import { useState } from "react";

type Plan = "starter" | "growth";
const priceEgp = (plan: Plan, months: number, setup: boolean, own: number | null = null): number => ((own ?? PLANS[plan].monthlyPrice) * months + (setup ? SETUP_FEE : 0)) / 100;
const day = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Cairo" });

export function BillByHand({
  id,
  inPilot,
  pilotEndsAt,
  targetPlan,
  setupFeeDue,
  ownPrice,
  send,
}: {
  id: string;
  inPilot: boolean;
  pilotEndsAt: string | null;
  targetPlan: Plan;
  setupFeeDue: boolean;
  /** The brand's own monthly price in piastres (early bird), or null for the list price. */
  ownPrice: number | null;
  send: (path: string, body: unknown, done: string) => Promise<void>;
}) {
  const [paid, setPaid] = useState(true);
  const [plan, setPlan] = useState<Plan>(targetPlan);
  const [months, setMonths] = useState(1);
  const [setup, setSetup] = useState(setupFeeDue);
  const [amount, setAmount] = useState(String(priceEgp(targetPlan, 1, setupFeeDue, ownPrice)));
  const [touched, setTouched] = useState(false);
  const [start, setStart] = useState<"now" | "after_pilot" | "">("");
  const [method, setMethod] = useState("instapay");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [keepPrice, setKeepPrice] = useState(true);

  // Price follows plan, months and setup fee until you type your own.
  const reprice = (p: Plan, m: number, s: boolean): void => {
    if (!touched) setAmount(String(priceEgp(p, m, s, ownPrice)));
  };
  const value = Number(amount);
  const ready = Number.isFinite(value) && value >= 0 && (!inPilot || start !== "");

  return (
    <details className="bill-hand">
      <summary>Record a payment or make an invoice by hand</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready) return;
          setBusy(true);
          await send(
            `/accounts/${id}/record`,
            {
              plan,
              months,
              amountEgp: value,
              setupFee: setup,
              paid,
              ...(inPilot ? { start } : {}),
              method,
              reference: reference || undefined,
              note: note || undefined,
              key: crypto.randomUUID(),
              keepPrice: touched && keepPrice,
            },
            paid ? "Payment recorded. The brand gets a receipt by email." : "Invoice made. Send the pay link from the list below (WhatsApp or Resend invoice email).",
          );
          setBusy(false);
        }}
      >
        <fieldset className="seg-field">
          <legend>What happened</legend>
          <label>
            <input type="radio" name="bh-kind" checked={paid} onChange={() => setPaid(true)} /> They already paid
          </label>
          <label>
            <input type="radio" name="bh-kind" checked={!paid} onChange={() => setPaid(false)} /> Make an invoice for them to pay
          </label>
        </fieldset>

        <div className="bh-grid">
          <label>
            Plan
            <select
              value={plan}
              onChange={(e) => {
                const p = e.target.value as Plan;
                setPlan(p);
                reprice(p, months, setup);
              }}
            >
              <option value="starter">Starter ({PLANS.starter.monthlyPrice / 100} EGP / month)</option>
              <option value="growth">Growth ({PLANS.growth.monthlyPrice / 100} EGP / month)</option>
            </select>
          </label>
          <label>
            Months
            <select
              value={months}
              onChange={(e) => {
                const m = Number(e.target.value);
                setMonths(m);
                reprice(plan, m, setup);
              }}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            Total (EGP)
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setTouched(true);
                setAmount(e.target.value.replace(/[^0-9.]/g, ""));
              }}
            />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={setup}
            onChange={(e) => {
              setSetup(e.target.checked);
              reprice(plan, months, e.target.checked);
            }}
          />{" "}
          Includes the one-off setup fee ({SETUP_FEE / 100} EGP)
        </label>
        {touched && (
          <label className="check">
            <input type="checkbox" checked={keepPrice} onChange={(e) => setKeepPrice(e.target.checked)} /> Keep this price for renewals (
            {((value - (setup ? SETUP_FEE / 100 : 0)) / months).toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP a month), and count it in MRR
          </label>
        )}
        {touched && (
          <p className="small muted">
            Your own price. List price would be {priceEgp(plan, months, setup).toLocaleString("en-US")} EGP.{" "}
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setTouched(false);
                setAmount(String(priceEgp(plan, months, setup)));
              }}
            >
              Use list price
            </button>
          </p>
        )}

        {inPilot && (
          <fieldset className="seg-field">
            <legend>The brand is in its pilot{pilotEndsAt ? ` (ends ${day(pilotEndsAt)})` : ""}. When do the paid months start?</legend>
            <label>
              <input type="radio" name="bh-start" checked={start === "now"} onChange={() => setStart("now")} /> Start counting now{paid ? "" : " (the day they pay)"}: the pilot ends there
            </label>
            <label>
              <input type="radio" name="bh-start" checked={start === "after_pilot"} onChange={() => setStart("after_pilot")} /> After the pilot ends: they keep the remaining pilot days
            </label>
          </fieldset>
        )}

        {paid && (
          <div className="bh-grid">
            <label>
              Paid by
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="instapay">InstaPay</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="cash">Cash</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Reference (optional)
              <input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} placeholder="InstaPay or bank reference" />
            </label>
          </div>
        )}
        <label>
          Private note (optional)
          <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 10% founding discount" />
        </label>
        <p>
          <button className="btn small" type="submit" disabled={!ready || busy}>
            {busy ? "Saving…" : paid ? `Record payment of ${value.toLocaleString("en-US")} EGP` : `Make invoice for ${value.toLocaleString("en-US")} EGP`}
          </button>
        </p>
        <p className="small muted">Any other open plan invoice for this brand is cancelled, so they only ever see one.</p>
      </form>
    </details>
  );
}

/** The brand's own monthly price (early bird, a deal): renewals, MRR, the portal and pilot emails use it. */
export function OwnPrice({ id, plan, ownPrice, send }: { id: string; plan: Plan; ownPrice: number | null; send: (path: string, body: unknown, done: string) => Promise<void> }) {
  const [v, setV] = useState(ownPrice === null ? "" : String(ownPrice / 100));
  const list = PLANS[plan].monthlyPrice / 100;
  return (
    <form
      className="row own-price"
      onSubmit={(e) => {
        e.preventDefault();
        const n = v.trim() === "" ? null : Number(v);
        if (n !== null && !Number.isFinite(n)) return;
        void send(`/accounts/${id}/price`, { priceEgp: n === list ? null : n }, n === null || n === list ? "Back to the list price." : `Monthly price set to ${n.toLocaleString("en-US")} EGP.`);
      }}
    >
      <label>
        Monthly price (EGP)
        <input inputMode="decimal" value={v} placeholder={`${list} (list price)`} onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ""))} />
      </label>
      <button className="btn small ghost" type="submit">
        Save price
      </button>
      <span className="small muted">
        {ownPrice === null ? `List price: ${list.toLocaleString("en-US")} EGP.` : `Own price (list is ${list.toLocaleString("en-US")} EGP).`} Used for renewal invoices and MRR. Empty = list price.
      </span>
    </form>
  );
}
