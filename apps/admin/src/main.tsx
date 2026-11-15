import "@garrab/shared/ui.css";
import "./admin.css";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    `/admin-api${path}`,
    body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  if (!r.ok) throw new Error([j.error ?? `HTTP ${r.status}`, j.reason].filter(Boolean).join(": "));
  return j;
}

const STEPS = ["invited", "account_created", "products_imported", "products_tested", "products_approved", "installed", "pilot_live", "converted", "expired"] as const;

interface Row {
  id: string;
  name: string;
  status: string;
  stepLabel: string;
  onboarding_step: string;
  hoursInStep: number | null;
  target_plan_id: string | null;
  email: string | null;
}
interface Stage {
  stage: string;
  count: number;
  conversion: number | null;
}

function Invite({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ brandName: "", email: "", plan: "starter", website: "", setupFee: "default" });
  const [link, setLink] = useState<string | null>(null);
  const [again, setAgain] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [offer, setOffer] = useState<{ foundingOfferOn: boolean; setupFee: number } | null>(null);
  const loadOffer = useCallback(async () => setOffer(await api<{ foundingOfferOn: boolean; setupFee: number }>("/offer")), []);
  useEffect(() => void loadOffer().catch(() => undefined), [loadOffer]);
  const fee = offer ? egp(offer.setupFee) : "the setup fee";
  return (
    <div className="card">
      <h2>Invite a brand</h2>
      <p className="sub">Creates the brand's account, emails them a welcome with a sign-in link, and starts their free 14-day pilot.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            type Existing = { name: string | null; status: string | null; welcome: string; reason: string | null };
            const r = await api<{ link: string; created: boolean; existing?: Existing }>("/invite", {
              brandName: f.brandName,
              email: f.email,
              plan: f.plan,
              website: f.website || undefined,
              setupFee: f.setupFee === "default" ? undefined : f.setupFee === "yes",
            });
            setLink(r.link);
            const x = r.existing;
            setAgain(
              r.created || !x
                ? null
                : x.welcome === "sent_now"
                  ? `This email was already invited (${x.name}). The welcome email hadn't gone out, so it was sent now. No duplicate was created.`
                  : x.welcome === "already_sent"
                    ? `This email was already invited (${x.name}) and the welcome email was delivered to Resend before. Nothing was sent twice: send the fresh link below, or use "Resend sign-in link" on the brand.`
                    : x.welcome === "failed"
                      ? `This email was already invited (${x.name}). The welcome email failed again: ${x.reason ?? "unknown reason"}. Send the link below on WhatsApp for now.`
                      : `This email already belongs to ${x.name} (${nice(STATUS_NAME, x.status)}). No duplicate was created; here is a fresh sign-in link.`,
            );
            onDone();
          } catch (x) {
            setErr(x instanceof Error ? x.message : "error");
          }
        }}
      >
        <div className="grid">
          <div>
            <label htmlFor="bn">Brand name</label>
            <input id="bn" required value={f.brandName} onChange={(e) => setF({ ...f, brandName: e.target.value })} />
          </div>
          <div>
            <label htmlFor="em">Email</label>
            <input id="em" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </div>
          <div>
            <label htmlFor="pl">Plan after pilot</label>
            <select id="pl" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>
              <option value="starter">Starter</option>
              <option value="growth">Growth</option>
            </select>
          </div>
          <div>
            <label htmlFor="sf">Setup fee</label>
            <select id="sf" value={f.setupFee} onChange={(e) => setF({ ...f, setupFee: e.target.value })}>
              <option value="default">
                {offer === null ? "Current offer" : offer.foundingOfferOn ? "Current offer: no fee" : `Current offer: ${fee}`}
              </option>
              <option value="no">No fee for this brand</option>
              <option value="yes">Charge {fee} for this brand</option>
            </select>
            <p className="small muted" style={{ margin: "4px 0 0" }}>
              A one-off {fee} for setting the brand up. Never charged during the free pilot: it's added to their first invoice only if they continue on a paid plan.
            </p>
          </div>
          <div>
            <label htmlFor="ws">Website (optional)</label>
            <input id="ws" type="url" placeholder="https://" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
          </div>
        </div>
        <p>
          <button className="btn" type="submit">
            Create and get sign-in link
          </button>
        </p>
        {offer && (
          <p className="small muted" style={{ marginTop: -4 }}>
            <strong>Founding-brands offer: {offer.foundingOfferOn ? "on" : "off"}.</strong>{" "}
            {offer.foundingOfferOn ? `New brands pay no setup fee unless you choose to charge it.` : `New brands pay the ${fee} setup fee unless you waive it.`}{" "}
            <a
              href="#"
              onClick={async (e) => {
                e.preventDefault();
                const next = !offer.foundingOfferOn;
                if (!confirm(next ? "Turn the founding-brands offer on? New invites will have no setup fee by default." : `Turn the founding-brands offer off? New invites will pay the ${fee} setup fee by default. Brands already invited keep what they were offered.`)) return;
                await api("/founding-pilots", { open: next });
                await loadOffer();
              }}
            >
              {offer.foundingOfferOn ? "Turn it off" : "Turn it on"}
            </a>
          </p>
        )}
      </form>
      {err && <p className="warn">{err}</p>}
      {link && (
        <div className="note" role="status">
          <p className="small">
            {again ?? (
              <>
                <strong>Invite created.</strong> The welcome email is on its way. You can also send this sign-in link yourself (single use, valid for 15 minutes):
              </>
            )}
          </p>
          <p className="small" style={{ wordBreak: "break-all" }}>
            {link}
          </p>
          <div className="row">
            <button className="btn small ghost" onClick={() => navigator.clipboard.writeText(link)}>
              Copy link
            </button>
            <a className="btn small ghost" href={`https://wa.me/?text=${encodeURIComponent(`Your Garrab sign-in link: ${link}`)}`} target="_blank" rel="noopener">
              Send on WhatsApp
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  type D = {
    account: Record<string, unknown>;
    steps: { step: string; state: string; entered_at: string; actor: string; note: string | null }[];
    products: { id: string; title: string; selected: number; test_score: number | null; enabled: number; needs_review: number; disabled_reason: string | null; brand_decision: string | null }[];
    tests: { id: string; product_id: string; score: number | null; reason: string | null }[];
    audit: { actor: string; action: string; reason: string | null; created_at: string }[];
  };
  const [d, setD] = useState<D | null>(null);
  const [to, setTo] = useState<string>("products_imported");
  const [reason, setReason] = useState("");
  const load = useCallback(async () => setD(await api<D>(`/accounts/${id}`)), [id]);
  useEffect(() => void load(), [load]);
  if (!d) return <div className="card">Loading…</div>;
  const site = (d.account.website ?? (d.account.instagram ? `https://instagram.com/${String(d.account.instagram)}` : null)) as string | null;
  return (
    <div className="card detail" aria-label="Account detail">
      <div className="detail-head">
        <div>
          <h2>{String(d.account.name)}</h2>
          <p className="small muted" style={{ margin: "6px 0 0" }}>
            <StatusChip status={String(d.account.status)} /> <span className="chip">{nice(STEP_NAME, String(d.account.onboarding_step))}</span>{" "}
            {String(d.account.email ?? "")}
            {site && (
              <>
                {" · "}
                <a href={site} target="_blank" rel="noopener">{site.replace(/^https?:\/\//, "")}</a>
              </>
            )}
          </p>
        </div>
        <div className="row">
          {String(d.account.status) === "onboarding" && (
            <button
              className="btn small ghost"
              title="For a wrong email, a typo or a test brand. Only before any invoice or payment."
              onClick={async () => {
                const name = String(d.account.name);
                const typed = prompt(
                  `Delete the invitation for "${name}"?\n\nThis removes the account, its sign-in links, products and test results, so you can invite the right email again. It's only possible before any invoice or payment.\n\nType the brand name to confirm:`,
                );
                if (typed === null) return;
                const reason = prompt("Reason (for the history):", "Wrong email, inviting again");
                if (!reason || reason.trim().length < 3) return;
                try {
                  await api(`/accounts/${id}/delete`, { confirmName: typed, reason });
                  alert(`${name} was deleted. You can invite the right email from the Onboarding tab.`);
                  onChange();
                  onClose();
                } catch (e) {
                  alert(e instanceof Error ? e.message.replace(/^[a-z_]+: /, "") : "Couldn't delete.");
                }
              }}
            >
              Delete invitation
            </button>
          )}
          <button className="btn small ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="section">
      <h3>Onboarding steps</h3>
      <ul className="list">
        {d.steps.map((s) => (
          <li key={s.step}>
            <span>
              {nice(STEP_NAME, s.step)} {s.note ? <span className="muted">· {s.note}</span> : null}
            </span>
            <span className="small muted">
              {cap(s.state)} · {s.actor}
            </span>
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          await api(`/accounts/${id}/step`, { to, reason });
          setReason("");
          await load();
          onChange();
        }}
      >
        <select aria-label="Move to step" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "auto" }}>
          {STEPS.map((s) => (
            <option key={s} value={s}>{nice(STEP_NAME, s)}</option>
          ))}
        </select>
        <input aria-label="Reason" placeholder="Reason (required)" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 260 }} />
        <button className="btn small ghost" type="submit">
          Move to this step
        </button>
      </form>
      </div>
      <div className="section">
      <h3>Selected products</h3>
      {d.products.filter((p) => p.selected).length === 0 && <p className="small muted">No products selected yet.</p>}
      <div className="grid">
        {d.products
          .filter((p) => p.selected)
          .map((p) => (
            <div key={p.id} className="card" style={{ margin: 0 }}>
              <strong>{p.title}</strong>
              <p className="small">
                Score {p.test_score ?? "–"} · {p.enabled ? "Enabled" : p.needs_review ? "Needs your review" : p.test_score === null ? "Testing…" : "Disabled"} · Brand: {p.brand_decision ? cap(p.brand_decision) : "not decided"}
              </p>
              <div className="thumbs">
                {d.tests
                  .filter((t) => t.product_id === p.id)
                  .map((t) => (
                    <div className="preview" key={t.id} title={t.reason ?? ""}>
                      <span className="chip">{t.score ?? "?"}</span>
                      <img src={`/admin-api/test-image/${t.id}`} alt={`Test result, score ${t.score}`} />
                    </div>
                  ))}
              </div>
              {p.needs_review === 1 && (
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn small" onClick={async () => (await api(`/products/${p.id}/review`, { enable: true, reason: "Checked by hand: good enough" }), load())}>
                    Enable
                  </button>
                  <button className="btn small ghost" onClick={async () => (await api(`/products/${p.id}/review`, { enable: false, reason: "Checked by hand: not good enough" }), load())}>
                    Disable
                  </button>
                </div>
              )}
            </div>
          ))}
      </div>
      </div>
      <Money id={id} status={String(d.account.status)} hold={Number(d.account.manual_hold) === 1} notes={String(d.account.notes ?? "")} onChange={async () => (await load(), onChange())} />
      <div className="section">
      <h3>History</h3>
      <ul className="timeline">
        {d.audit.map((a, i) => (
          <li key={i}>
            <time>{cairo(a.created_at)}</time>
            <span>
              {cap(a.action.replace(/_/g, " "))} <span className="muted">by {a.actor.replace(/^admin:/, "")}</span>
              {a.reason ? <span className="muted"> · {a.reason}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      </div>
    </div>
  );
}


const egp = (p: number): string => `${(p / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP`;

const cap = (t: string): string => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const nice = (map: Record<string, string>, k: string | null | undefined): string => (k ? (map[k] ?? cap(k.replace(/_/g, " "))) : "–");
const STATUS_NAME: Record<string, string> = {
  onboarding: "Onboarding",
  pilot: "Pilot",
  active: "Active",
  past_due: "Payment due",
  suspended: "Switched off",
  paused: "Paused",
  killed: "Killed",
  cancelled: "Cancelled",
  archived: "Archived",
  expired: "Pilot ended",
};
const PLAN_NAME: Record<string, string> = { pilot: "Pilot", starter: "Starter", growth: "Growth" };
const STEP_NAME: Record<string, string> = {
  invited: "Invited",
  account_created: "Account created",
  products_imported: "Products added",
  products_tested: "Products tested",
  products_approved: "Products approved",
  installed: "Installed",
  pilot_live: "Pilot live",
  converted: "Converted to paid",
  expired: "Pilot ended",
};
const JOB_NAME: Record<string, string> = {
  billing_run: "Billing",
  digest: "Daily summary email",
  install_crawler: "Install check",
  onboarding_sweep: "Onboarding sweep",
  payment_claims: "Payment claims",
  product_resync: "Product sync",
  stuck_detector: "Stuck brands check",
  pilot_clock: "Pilot clock",
};
/** Times are shown in Cairo time, like everything else in Garrab. */
const cairo = (ts: string | null | undefined): string => {
  if (!ts) return "–";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
const statusClass = (st: string): string => (st === "suspended" || st === "killed" ? "bad" : st === "past_due" ? "peach" : st === "active" ? "mint" : st === "pilot" ? "lavender" : "");
function StatusChip({ status }: { status: string }) {
  return <span className={`chip ${statusClass(status)}`}>{nice(STATUS_NAME, status)}</span>;
}

function Access({ id }: { id: string }) {
  const [domains, setDomains] = useState<{ id: string; host: string; install_status: string }[]>([]);
  const [host, setHost] = useState("");
  const [snippet, setSnippet] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => setDomains((await api<{ domains: typeof domains }>(`/accounts/${id}/domains`)).domains), [id]);
  useEffect(() => void load(), [load]);
  return (
    <>
      <div className="section">
      <h3>Portal, widget key and domains</h3>
      <div className="row">
        <button
          className="btn small ghost"
          onClick={async () => {
            const r = await api<{ link: string }>(`/accounts/${id}/view-portal`, {});
            window.open(r.link, "_blank", "noopener");
          }}
        >
          Open their portal (read-only)
        </button>
        <button
          className="btn small ghost"
          onClick={async () => {
            const reason = prompt("Why rotate the widget key? The old key stops working immediately.");
            if (!reason || reason.trim().length < 3) return;
            setSnippet((await api<{ snippet: string }>(`/accounts/${id}/rotate-key`, { reason })).snippet);
          }}
        >
          Rotate widget key
        </button>
      </div>
      {snippet && <pre className="code">{snippet}</pre>}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="btn small ghost"
          onClick={async () => {
            const v = prompt("Product limit for this brand (empty = plan default: pilot 10, paid plans unlimited):");
            if (v === null) return;
            const limit = v.trim() === "" ? null : Number(v);
            if (limit !== null && !(limit >= 1)) return;
            await api(`/accounts/${id}/product-limit`, { limit });
            alert(limit === null ? "Using the plan default." : `Limit set to ${limit}.`);
          }}
        >
          Set product limit
        </button>
      </div>
      <ul className="list">
        {domains.map((d) => (
          <li key={d.id}>
            <span>
              {d.host} <span className="chip">{cap(d.install_status.replace(/_/g, " "))}</span>
            </span>
            <a href="#" onClick={async (e) => (e.preventDefault(), await api(`/accounts/${id}/domains/${d.id}/remove`, {}), load())}>Remove</a>
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api(`/accounts/${id}/domains`, { host });
            setHost("");
            setMsg(null);
            await load();
          } catch (x) {
            setMsg(x instanceof Error && x.message === "domain_taken" ? "That domain belongs to another brand." : "Not a valid domain.");
          }
        }}
      >
        <input aria-label="Add domain" placeholder="shop.example.com" value={host} onChange={(e) => setHost(e.target.value)} style={{ width: 240 }} />
        <button className="btn small ghost" type="submit">Add domain</button>
      </form>
      {msg && <p className="warn small">{msg}</p>}
      </div>
    </>
  );
}

function Costs({ id }: { id: string }) {
  const [d, setD] = useState<{ egpPerUsd: number | null; days: { day: string; calls: number; usd: number; egp: number | null }[] } | null>(null);
  useEffect(() => void api<NonNullable<typeof d>>(`/accounts/${id}/costs`).then(setD), [id]);
  if (!d || d.days.length === 0) return null;
  return (
    <>
      <div className="section">
      <h3>AI cost per day</h3>
      <table>
        <thead>
          <tr><th>Day</th><th>Calls</th><th>USD</th><th>EGP</th></tr>
        </thead>
        <tbody>
          {d.days.slice(0, 14).map((x) => (
            <tr key={x.day}><td>{x.day}</td><td>{x.calls}</td><td>{x.usd.toFixed(2)}</td><td>{x.egp === null ? "–" : x.egp.toFixed(2)}</td></tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}

function Money({ id, status, hold, notes, onChange }: { id: string; status: string; hold: boolean; notes: string; onChange: () => Promise<void> }) {
  type B = {
    invoices: { id: string; number: string; kind: string; total: number; status: string; due_date: string; payUrl: string; pdfUrl: string; whatsapp: string | null }[];
    payments: { provider: string; amount: number; method: string; reference: string | null; actor: string; created_at: string }[];
    claims: { id: string; reference: string; status: string; created_at: string }[];
  };
  const [b, setB] = useState<B | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState(notes);
  const load = useCallback(async () => setB(await api<B>(`/accounts/${id}/billing`)), [id]);
  useEffect(() => void load(), [load]);
  const act = async (path: string, body: unknown, done: string) => {
    try {
      await api(path, body);
      setMsg(done);
      await load();
      await onChange();
    } catch (e) {
      setMsg(e instanceof Error ? `Failed: ${e.message}` : "Failed");
    }
  };
  if (!b) return null;
  return (
    <>
      <div className="section">
      <h3>On / off</h3>
      <p className="small muted">
        Now: <StatusChip status={status} />
        {hold ? " · held by you (billing won't change it)" : ""}. Kill switches the try-on off at once; Restore puts it back to what billing says.
      </p>
      <div className="row">
        <input aria-label="Reason for kill, pause or restore" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 260 }} />
        <button className="btn small" disabled={reason.trim().length < 3} onClick={() => act(`/accounts/${id}/kill`, { reason }, "Killed: switched off now.")}>
          Kill now
        </button>
        <button className="btn small ghost" disabled={reason.trim().length < 3} onClick={() => act(`/accounts/${id}/pause`, { reason }, "Paused.")}>
          Pause
        </button>
        <button className="btn small ghost" disabled={reason.trim().length < 3} onClick={() => act(`/accounts/${id}/restore`, { reason }, "Restored to what the ledger says.")}>
          Restore
        </button>
      </div>
      {msg && <p className="note small" role="status">{msg}</p>}
      </div>

      <Access id={id} />
      <Costs id={id} />
      <div className="section">
      <h3>Invoices</h3>
      <div className="row">
        <button className="btn small ghost" onClick={() => act(`/accounts/${id}/invoice`, {}, "Invoice ready.")}>
          Create / get open invoice
        </button>
        <button className="btn small ghost" onClick={() => act(`/accounts/${id}/resend`, { template: "invoice" }, "Invoice email sent.")}>
          Resend invoice email
        </button>
        <button className="btn small ghost" onClick={() => act(`/accounts/${id}/resend`, { template: "login" }, "Sign-in link sent.")}>
          Resend sign-in link
        </button>
      </div>
      <table>
        <tbody>
          {b.invoices.length === 0 && (
            <tr>
              <td className="muted">No invoices yet.</td>
            </tr>
          )}
          {b.invoices.map((i) => (
            <tr key={i.id}>
              <td>{i.number}</td>
              <td>{cap(i.kind.replace(/_/g, " "))}</td>
              <td>{egp(i.total)}</td>
              <td>{i.status === "open" ? `Due ${i.due_date}` : cap(i.status)}</td>
              <td className="row">
                <a className="small" href={i.payUrl} target="_blank" rel="noopener">Pay page</a>
                <a className="small" href={i.pdfUrl} target="_blank" rel="noopener">PDF</a>
                {i.whatsapp && <a className="small" href={i.whatsapp} target="_blank" rel="noopener">WhatsApp</a>}
                {i.status === "open" && (
                  <button
                    className="btn small ghost"
                    onClick={() => {
                      const ref = prompt(`Mark ${i.number} paid. Reference (InstaPay / bank):`);
                      if (ref === null) return;
                      void act(`/invoices/${i.id}/mark-paid`, { method: "instapay", reference: ref || undefined, key: crypto.randomUUID() }, `${i.number} marked paid.`);
                    }}
                  >
                    Mark paid
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {b.claims.filter((c) => c.status === "pending").map((c) => (
        <p key={c.id} className="note row">
          Brand says "I've paid" · reference {c.reference}
          <button className="btn small" onClick={() => act(`/claims/${c.id}/decide`, { confirm: true }, "Confirmed.")}>Confirm</button>
          <button className="btn small ghost" onClick={() => act(`/claims/${c.id}/decide`, { confirm: false }, "Marked not received.")}>Not received</button>
        </p>
      ))}
      </div>
      <div className="section">
      <h3>Payments</h3>
      {b.payments.length === 0 && <p className="small muted">No payments yet.</p>}
      <ul className="list">
        {b.payments.map((p, i) => (
          <li key={i}>
            <span>
              <strong>{egp(p.amount)}</strong> · {p.method === "instapay" ? "InstaPay" : cap(p.method)} {p.reference ? <span className="muted">· ref {p.reference}</span> : null}
            </span>
            <span className="small muted">
              {cairo(p.created_at)} · {p.actor.replace(/^admin:/, "")}
            </span>
          </li>
        ))}
      </ul>
      </div>
      <div className="section">
      <h3>Private notes</h3>
      <textarea aria-label="Notes" value={note} onChange={(e) => setNote(e.target.value)} />
      <p>
        <button className="btn small ghost" onClick={() => act(`/accounts/${id}/notes`, { notes: note }, "Notes saved.")}>Save notes</button>
      </p>
      </div>
    </>
  );
}

interface Dash {
  statusCounts: Record<string, number>;
  mrr: number;
  egpPerUsd: number | null;
  globalKill: boolean;
  privacyClaim: boolean;
  clients: { id: string; name: string; status: string; plan: string; paidThrough: string | null; previews: string; revenue30: number; costUsd30: number; margin30: number | null; manualHold: boolean }[];
  alerts: { id: string; kind: string; message: string; created_at: string }[];
  pendingClaims: { id: string; name: string; number: string; total: number; reference: string }[];
  dueSoon: number;
  crons: { job: string; last_run: string; ok: number }[];
}

function Dashboard({ open }: { open: (id: string) => void }) {
  const [d, setD] = useState<Dash | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; status: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setD(await api<Dash>("/dashboard"));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  if (err && !d)
    return (
      <div className="card" role="alert">
        <h2>Couldn't load the dashboard</h2>
        <p className="small">{err}</p>
        <button className="btn small ghost" onClick={() => void load()}>Try again</button>
      </div>
    );
  if (!d) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Today <span className="soft">at a glance</span>
          </h1>
          <p className="small muted">{new Date().toLocaleDateString("en-GB", { timeZone: "Africa/Cairo", weekday: "long", day: "numeric", month: "long" })} · Cairo time</p>
        </div>
        <form
          className="search"
          role="search"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!q.trim()) return setHits(null);
            setHits((await api<{ results: NonNullable<typeof hits> }>(`/search?q=${encodeURIComponent(q)}`)).results);
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--grey)" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input aria-label="Search brands" placeholder="Search by brand, email or website" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
      </div>
      {hits && (
        <div className="card">
          <h2>Search results</h2>
          {hits.length === 0 ? (
            <p className="small muted">No brand matches "{q}".</p>
          ) : (
            <ul className="list">
              {hits.map((h) => (
                <li key={h.id}>
                  <a href="#" onClick={(e) => (e.preventDefault(), open(h.id))}>{h.name}</a> <StatusChip status={h.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="stats" aria-label="Key numbers">
        <div className="card">
          <p className="label">Monthly revenue</p>
          <p className="stat">{egp(d.mrr)}</p>
          <p className="hint">MRR from paying brands</p>
        </div>
        {(
          [
            ["pilot", "In free pilot"],
            ["active", "Paying"],
            ["past_due", "Payment due"],
            ["suspended", "Switched off"],
          ] as const
        ).map(([k, l]) => (
          <div className="card" key={k}>
            <p className="label">{l}</p>
            <p className="stat">{d.statusCounts[k] ?? 0}</p>
          </div>
        ))}
        <div className="card">
          <p className="label">Invoices due soon</p>
          <p className="stat">{d.dueSoon}</p>
          <p className="hint">In the next 3 days</p>
        </div>
      </div>
      {d.pendingClaims.length > 0 && (
        <div className="card dark">
          <h2>Payments to confirm</h2>
          {d.pendingClaims.map((c) => (
            <p key={c.id} className="row">
              {c.name}: {egp(c.total)} ({c.number}), ref {c.reference}
              <button className="btn small accent" onClick={async () => (await api(`/claims/${c.id}/decide`, { confirm: true }), load())}>Confirm</button>
              <button className="btn small ghost" onClick={async () => (await api(`/claims/${c.id}/decide`, { confirm: false }), load())}>Not received</button>
            </p>
          ))}
        </div>
      )}
      <div className="card">
        <h2>Brands</h2>
        <p className="sub">Brands in a pilot or on a paid plan. Click a name for details, billing and the on/off switch.</p>
        {d.egpPerUsd === null && (
          <p className="small warn">
            Set the EGP/USD rate to see margins.{" "}
            <button
              className="btn small ghost"
              onClick={async () => {
                const v = Number(prompt("EGP per 1 USD (today's rate):") ?? "");
                if (v > 0) {
                  await api("/settings", { egpPerUsd: v });
                  await load();
                }
              }}
            >
              Set rate
            </button>
          </p>
        )}
        {d.clients.length === 0 ? (
          <div className="empty">
            <strong>No brands yet</strong>
            Invite your first brand from the Onboarding tab. It shows up here once its pilot starts.
          </div>
        ) : (
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Brand</th>
              <th>Status</th>
              <th>Plan</th>
              <th>Paid until</th>
              <th>Previews</th>
              <th>Revenue (30 days)</th>
              <th>AI cost (30 days)</th>
              <th>Margin (30 days)</th>
            </tr>
          </thead>
          <tbody>
            {d.clients.map((c) => (
              <tr key={c.id}>
                <td>
                  <a href="#" onClick={(e) => (e.preventDefault(), open(c.id))}>{c.name}</a>
                </td>
                <td>
                  <StatusChip status={c.status} />
                  {c.manualHold ? <span title="Held by you"> ⛔</span> : ""}
                </td>
                <td>{nice(PLAN_NAME, c.plan)}</td>
                <td>{c.paidThrough ?? "–"}</td>
                <td>{c.previews}</td>
                <td>{egp(c.revenue30)}</td>
                <td>{c.costUsd30.toFixed(2)} USD</td>
                <td>{c.margin30 === null ? "–" : egp(c.margin30)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        )}
      </div>
      <div className="cols">
        <div className="card">
          <h2>Alerts</h2>
          {d.alerts.length === 0 ? (
            <p className="small muted">All clear. Anything that needs you shows up here and in Telegram.</p>
          ) : (
            <ul className="list">
              {d.alerts.map((a) => (
                <li key={a.id} style={{ display: "block" }}>
                  <span className="chip peach">{cap(a.kind.replace(/_/g, " "))}</span> <span className="small muted">{cairo(a.created_at)}</span>
                  <div className="small" style={{ margin: "4px 0" }}>{a.message}</div>
                  <a href="#" className="small" onClick={async (e) => (e.preventDefault(), await api(`/alerts/${a.id}/resolve`, {}), load())}>Dismiss</a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>Background jobs</h2>
          <p className="sub">Last run, Cairo time.</p>
          <ul className="list">
            {d.crons.map((c) => (
              <li key={c.job}>
                <span>
                  <span className={c.ok ? "ok" : "bad-text"}>{c.ok ? "✓" : "✗"}</span> {nice(JOB_NAME, c.job)}
                </span>
                <span className="small muted">{cairo(c.last_run)}</span>
              </li>
            ))}
          </ul>
          <p style={{ marginBottom: 0 }}>
            <button className="btn small ghost" onClick={async () => (await api("/jobs/billing_run/run", {}), load())}>Run billing now</button>
          </p>
        </div>
        <div className={`card ${d.globalKill ? "dark" : ""}`}>
          <h2>Emergency switch</h2>
          <p className="small">{d.globalKill ? "ON: try-on is switched off for every brand." : "Off. Turning it on switches try-on off for every brand within a minute."}</p>
          <button
            className={`btn small ${d.globalKill ? "accent" : ""}`}
            onClick={async () => {
              const reason = prompt(d.globalKill ? "Reason for turning previews back on:" : "Reason for disabling ALL previews:");
              if (!reason || reason.trim().length < 3) return;
              await api("/global-kill", { on: !d.globalKill, reason });
              await load();
            }}
          >
            {d.globalKill ? "Turn previews back on" : "Disable all previews"}
          </button>
        </div>
        <div className="card">
          <h2>Privacy line</h2>
          <p className="small">
            {d.privacyClaim
              ? "On. Shoppers see: \"We don't save it. It's deleted when you close this page.\""
              : "Off. Needs a PASS report from the Genlook delete check (docs/privacy/), less than 90 days old."}
          </p>
          <button
            className="btn small ghost"
            onClick={async () => {
              if (d.privacyClaim) {
                if (!confirm("Turn the privacy line off?")) return;
                await api("/privacy-claim", { on: false });
              } else {
                const raw = prompt("Paste the PASS report (JSON from docs/privacy/):");
                if (!raw) return;
                try {
                  await api("/privacy-claim", { on: true, report: JSON.parse(raw) });
                } catch {
                  alert("That report wasn't accepted. It must be a PASS less than 90 days old.");
                }
              }
              await load();
            }}
          >
            {d.privacyClaim ? "Turn off" : "Turn on with report"}
          </button>
        </div>
      </div>
    </>
  );
}

const ENV = /^admin\.garrabb\.com$/.test(location.hostname) ? "Live" : /staging/.test(location.hostname) ? "Staging" : "Local";

function App() {
  const [rows, setRows] = useState<Row[]>([]);
  const [funnel, setFunnel] = useState<Stage[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<"dashboard" | "onboarding">("dashboard");
  const load = useCallback(async () => {
    const [a, f] = await Promise.all([api<{ accounts: Row[] }>("/accounts"), api<{ stages: Stage[] }>("/funnel")]);
    setRows(a.accounts);
    setFunnel(f.stages);
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const m = /account=([A-Z0-9]+)/.exec(location.hash);
    if (m) setOpen(m[1]!);
  }, []);

  return (
    <>
    <header className="bar">
      <div className="bar-inner">
        <a className="brand" href="/" onClick={(e) => (e.preventDefault(), setTab("dashboard"), setOpen(null))}>
          <img src="/mark-dark.svg" alt="" width="34" height="34" />
          Garrab <small>Admin</small>
        </a>
        <span className={`env ${ENV === "Live" ? "live" : ""}`}>{ENV}</span>
        <nav aria-label="Admin">
          <a href="#" aria-current={tab === "dashboard" ? "page" : undefined} onClick={(e) => (e.preventDefault(), setTab("dashboard"))}>Dashboard</a>
          <a href="#" aria-current={tab === "onboarding" ? "page" : undefined} onClick={(e) => (e.preventDefault(), setTab("onboarding"))}>Onboarding</a>
        </nav>
      </div>
    </header>
    <main className="page">
      {open && <Detail id={open} onClose={() => setOpen(null)} onChange={load} />}
      {tab === "dashboard" && <Dashboard open={setOpen} />}
      {tab === "onboarding" && (
      <>
      <div className="page-head">
        <div>
          <h1>
            Onboarding <span className="soft">from invite to live</span>
          </h1>
          <p className="small muted">Every brand moves through these steps on its own; you only step in when something is stuck.</p>
        </div>
      </div>
      <div className="stats" aria-label="Funnel">
        {funnel.map((s) => (
          <div className="card" key={s.stage}>
            <p className="label">{nice(STEP_NAME, s.stage)}</p>
            <p className="stat">{s.count}</p>
            {s.conversion !== null && <p className="hint">{s.conversion}% of the step before</p>}
          </div>
        ))}
      </div>
      <Invite onDone={load} />
      {msg && <p className="note">{msg}</p>}
      <div className="card">
        <h2>Brands being onboarded</h2>
        {rows.length === 0 ? (
          <div className="empty">
            <strong>No brands yet</strong>
            Use the form above to invite your first brand.
          </div>
        ) : (
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Brand</th>
              <th>Status</th>
              <th>Current step</th>
              <th>Time in step</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <a href="#" onClick={(e) => (e.preventDefault(), setOpen(r.id))}>
                    {r.name}
                  </a>
                </td>
                <td>
                  <StatusChip status={r.status} />
                </td>
                <td>{r.stepLabel}</td>
                <td>
                  {r.hoursInStep === null ? (
                    "–"
                  ) : r.hoursInStep > 48 && r.status === "onboarding" ? (
                    <span className="chip bad">Stuck {Math.round(r.hoursInStep / 24)} days</span>
                  ) : r.hoursInStep >= 48 ? (
                    `${Math.round(r.hoursInStep / 24)} days`
                  ) : (
                    `${r.hoursInStep} h`
                  )}
                </td>
                <td>
                  <div className="row">
                    <button className="btn small ghost" onClick={async () => setMsg((await api<{ sent: boolean }>(`/accounts/${r.id}/remind`, {})).sent ? `Reminder sent to ${r.name}.` : "Already reminded today.")}>
                      Send reminder
                    </button>
                    <button className="btn small ghost" title="Check this brand's step again now" onClick={async () => (await api(`/accounts/${r.id}/advance`, {}), load())}>
                      Check again
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        )}
      </div>
      </>
      )}
    </main>
    <footer className="foot">Garrab admin · {ENV} · Signed in through Cloudflare Access</footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
