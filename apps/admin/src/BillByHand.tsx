/**
 * Billing by hand: record a payment the brand already made (InstaPay seen in the app, bank transfer, cash),
 * or make an invoice to send. Any plan, 1–12 months, any price (discounts, custom deals).
 * Brand still in its pilot: choose whether the paid months start counting now or after the pilot ends.
 */
import { PLANS, SETUP_FEE } from "@garrab/shared/plans";
import { useState } from "react";

type Plan = "starter" | "growth";
const priceEgp = (plan: Plan, months: number, setup: boolean): number => (PLANS[plan].monthlyPrice * months + (setup ? SETUP_FEE : 0)) / 100;
const day = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Cairo" });

export function BillByHand({
  id,
  inPilot,
  pilotEndsAt,
  targetPlan,
  setupFeeDue,
  send,
}: {
  id: string;
  inPilot: boolean;
  pilotEndsAt: string | null;
  targetPlan: Plan;
  setupFeeDue: boolean;
  send: (path: string, body: unknown, done: string) => Promise<void>;
}) {
  const [paid, setPaid] = useState(true);
  const [plan, setPlan] = useState<Plan>(targetPlan);
  const [months, setMonths] = useState(1);
  const [setup, setSetup] = useState(setupFeeDue);
  const [amount, setAmount] = useState(String(priceEgp(targetPlan, 1, setupFeeDue)));
  const [touched, setTouched] = useState(false);
  const [start, setStart] = useState<"now" | "after_pilot" | "">("");
  const [method, setMethod] = useState("instapay");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Price follows plan, months and setup fee until you type your own.
  const reprice = (p: Plan, m: number, s: boolean): void => {
    if (!touched) setAmount(String(priceEgp(p, m, s)));
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
