import "@garrab/shared/ui.css";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    `/admin-api${path}`,
    body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
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
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="card">
      <h2>Invite a brand</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            const r = await api<{ link: string }>("/invite", {
              brandName: f.brandName,
              email: f.email,
              plan: f.plan,
              website: f.website || undefined,
              setupFee: f.setupFee === "default" ? undefined : f.setupFee === "yes",
            });
            setLink(r.link);
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
              <option value="default">Default (founding pilots: none)</option>
              <option value="yes">Charge the one-off setup fee</option>
              <option value="no">No setup fee</option>
            </select>
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
      </form>
      {err && <p className="warn">{err}</p>}
      {link && (
        <div className="note" role="status">
          <p className="small">Hand this to the brand now (works once, 15 minutes). The welcome email goes out too.</p>
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
  return (
    <div className="card" aria-label="Account detail">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>{String(d.account.name)}</h2>
        <button className="btn small ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="small muted">
        {String(d.account.status)} · {String(d.account.onboarding_step)} · {String(d.account.email)} · {String(d.account.website ?? d.account.instagram ?? "")}
      </p>
      <h2>Steps</h2>
      <ul className="small">
        {d.steps.map((s) => (
          <li key={s.step}>
            {s.step}: {s.state} ({s.actor}) {s.note ? `— ${s.note}` : ""}
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
            <option key={s}>{s}</option>
          ))}
        </select>
        <input aria-label="Reason" placeholder="Reason (required)" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 260 }} />
        <button className="btn small" type="submit">
          Override step
        </button>
      </form>
      <h2 style={{ marginTop: 16 }}>Selected products</h2>
      <div className="grid">
        {d.products
          .filter((p) => p.selected)
          .map((p) => (
            <div key={p.id} className="card" style={{ margin: 0 }}>
              <strong>{p.title}</strong>
              <p className="small">
                Score {p.test_score ?? "–"} · {p.enabled ? "enabled" : p.needs_review ? "needs review" : p.test_score === null ? "testing" : "disabled"} · brand: {p.brand_decision ?? "–"}
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
      <Money id={id} status={String(d.account.status)} hold={Number(d.account.manual_hold) === 1} notes={String(d.account.notes ?? "")} onChange={async () => (await load(), onChange())} />
      <h2 style={{ marginTop: 16 }}>Timeline</h2>
      <ul className="small">
        {d.audit.map((a, i) => (
          <li key={i}>
            {a.created_at.slice(0, 16).replace("T", " ")} · {a.actor} · {a.action} {a.reason ? `— ${a.reason}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}


const egp = (p: number): string => `${(p / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP`;

function Access({ id }: { id: string }) {
  const [domains, setDomains] = useState<{ id: string; host: string; install_status: string }[]>([]);
  const [host, setHost] = useState("");
  const [snippet, setSnippet] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => setDomains((await api<{ domains: typeof domains }>(`/accounts/${id}/domains`)).domains), [id]);
  useEffect(() => void load(), [load]);
  return (
    <>
      <h2 style={{ marginTop: 16 }}>Portal, key and domains</h2>
      <div className="row">
        <button
          className="btn small ghost"
          onClick={async () => {
            const r = await api<{ link: string }>(`/accounts/${id}/view-portal`, {});
            window.open(r.link, "_blank", "noopener");
          }}
        >
          Open portal (read-only)
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
      <ul className="small">
        {domains.map((d) => (
          <li key={d.id}>
            {d.host} <span className="chip">{d.install_status}</span>{" "}
            <a href="#" onClick={async (e) => (e.preventDefault(), await api(`/accounts/${id}/domains/${d.id}/remove`, {}), load())}>remove</a>
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
    </>
  );
}

function Costs({ id }: { id: string }) {
  const [d, setD] = useState<{ egpPerUsd: number | null; days: { day: string; calls: number; usd: number; egp: number | null }[] } | null>(null);
  useEffect(() => void api<NonNullable<typeof d>>(`/accounts/${id}/costs`).then(setD), [id]);
  if (!d || d.days.length === 0) return null;
  return (
    <>
      <h2 style={{ marginTop: 16 }}>AI cost per day</h2>
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
      <h2 style={{ marginTop: 16 }}>Kill switch</h2>
      <p className="small muted">
        Status: <strong>{status}</strong>
        {hold ? " · held by you (billing won't change it)" : ""}
      </p>
      <div className="row">
        <input aria-label="Reason for kill, pause or restore" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 260 }} />
        <button className="btn small" disabled={reason.trim().length < 3} onClick={() => act(`/accounts/${id}/kill`, { reason }, "Killed: switched off now.")}>
          Kill
        </button>
        <button className="btn small ghost" disabled={reason.trim().length < 3} onClick={() => act(`/accounts/${id}/pause`, { reason }, "Paused.")}>
          Pause
        </button>
        <button className="btn small ghost" disabled={reason.trim().length < 3} onClick={() => act(`/accounts/${id}/restore`, { reason }, "Restored to what the ledger says.")}>
          Restore
        </button>
      </div>
      {msg && <p className="note small" role="status">{msg}</p>}

      <Access id={id} />
      <Costs id={id} />
      <h2 style={{ marginTop: 16 }}>Invoices</h2>
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
          {b.invoices.map((i) => (
            <tr key={i.id}>
              <td>{i.number}</td>
              <td>{i.kind}</td>
              <td>{egp(i.total)}</td>
              <td>{i.status === "open" ? `due ${i.due_date}` : i.status}</td>
              <td className="row">
                <a className="small" href={i.payUrl} target="_blank" rel="noopener">pay page</a>
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
          "I've paid" claim, ref {c.reference}
          <button className="btn small" onClick={() => act(`/claims/${c.id}/decide`, { confirm: true }, "Confirmed.")}>Confirm</button>
          <button className="btn small ghost" onClick={() => act(`/claims/${c.id}/decide`, { confirm: false }, "Marked not received.")}>Not received</button>
        </p>
      ))}
      <h2 style={{ marginTop: 16 }}>Payments</h2>
      <ul className="small">
        {b.payments.map((p, i) => (
          <li key={i}>
            {p.created_at.slice(0, 10)} · {egp(p.amount)} · {p.provider} ({p.method}) {p.reference ? `ref ${p.reference}` : ""} · {p.actor}
          </li>
        ))}
      </ul>
      <h2 style={{ marginTop: 16 }}>Notes</h2>
      <textarea aria-label="Notes" value={note} onChange={(e) => setNote(e.target.value)} />
      <p>
        <button className="btn small ghost" onClick={() => act(`/accounts/${id}/notes`, { notes: note }, "Notes saved.")}>Save notes</button>
      </p>
    </>
  );
}

interface Dash {
  statusCounts: Record<string, number>;
  mrr: number;
  egpPerUsd: number | null;
  globalKill: boolean;
  clients: { id: string; name: string; status: string; plan: string; paidThrough: string | null; previews: string; revenue30: number; costUsd30: number; margin30: number | null; manualHold: boolean }[];
  alerts: { id: string; kind: string; message: string; created_at: string }[];
  pendingClaims: { id: string; name: string; number: string; total: number; reference: string }[];
  dueSoon: number;
  crons: { job: string; last_run: string; ok: number }[];
}

function Dashboard({ open }: { open: (id: string) => void }) {
  const [d, setD] = useState<Dash | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; status: string }[]>([]);
  const load = useCallback(async () => setD(await api<Dash>("/dashboard")), []);
  useEffect(() => void load(), [load]);
  if (!d) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>
          Today <span className="soft">at a glance</span>
        </h1>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setHits((await api<{ results: typeof hits }>(`/search?q=${encodeURIComponent(q)}`)).results);
          }}
        >
          <input aria-label="Search brands" placeholder="Search brand, email, site" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
        </form>
      </div>
      {hits.length > 0 && (
        <div className="card">
          {hits.map((h) => (
            <p key={h.id}>
              <a href="#" onClick={(e) => (e.preventDefault(), open(h.id))}>{h.name}</a> <span className="chip">{h.status}</span>
            </p>
          ))}
        </div>
      )}
      <div className="grid" aria-label="Key numbers">
        <div className="card" style={{ margin: 0 }}>
          <p className="small muted">MRR</p>
          <p className="stat">{egp(d.mrr)}</p>
        </div>
        {["pilot", "active", "past_due", "suspended"].map((s) => (
          <div className="card" style={{ margin: 0 }} key={s}>
            <p className="small muted">{s.replace("_", " ")}</p>
            <p className="stat">{d.statusCounts[s] ?? 0}</p>
          </div>
        ))}
        <div className="card" style={{ margin: 0 }}>
          <p className="small muted">due in 3 days</p>
          <p className="stat">{d.dueSoon}</p>
        </div>
      </div>
      <div style={{ height: 16 }} />
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
        <h2>Clients</h2>
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
        <table>
          <thead>
            <tr>
              <th>Brand</th>
              <th>Status</th>
              <th>Plan</th>
              <th>Paid until</th>
              <th>Previews</th>
              <th>Revenue 30 d</th>
              <th>AI cost 30 d</th>
              <th>Margin 30 d</th>
            </tr>
          </thead>
          <tbody>
            {d.clients.map((c) => (
              <tr key={c.id}>
                <td>
                  <a href="#" onClick={(e) => (e.preventDefault(), open(c.id))}>{c.name}</a>
                </td>
                <td>
                  <span className={`chip ${c.status === "suspended" ? "bad" : c.status === "past_due" ? "peach" : ""}`}>{c.status}</span>
                  {c.manualHold ? " ⛔" : ""}
                </td>
                <td>{c.plan}</td>
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
      <div className="grid">
        <div className="card">
          <h2>Alerts</h2>
          {d.alerts.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            d.alerts.map((a) => (
              <p key={a.id} className="small">
                <span className="chip">{a.kind}</span> {a.message}{" "}
                <a href="#" onClick={async (e) => (e.preventDefault(), await api(`/alerts/${a.id}/resolve`, {}), load())}>dismiss</a>
              </p>
            ))
          )}
        </div>
        <div className="card">
          <h2>Jobs</h2>
          {d.crons.map((c) => (
            <p key={c.job} className="small">
              {c.ok ? "✓" : "✗"} {c.job}: {String(c.last_run).slice(0, 16).replace("T", " ")} UTC
            </p>
          ))}
          <button className="btn small ghost" onClick={async () => (await api("/jobs/billing_run/run", {}), load())}>Run billing now</button>
        </div>
        <div className={`card ${d.globalKill ? "dark" : ""}`}>
          <h2>Emergency switch</h2>
          <p className="small">{d.globalKill ? "ON: every preview is disabled." : "Off. Turning it on disables every preview everywhere within a minute."}</p>
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
      </div>
    </>
  );
}

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
    <div className="shell">
      <header className="top">
        <span className="logo">
          <span className="tile">G</span> Garrab admin
        </span>
      </header>
      <nav className="tabs" aria-label="Admin">
        <a href="#" aria-current={tab === "dashboard" ? "page" : undefined} onClick={(e) => (e.preventDefault(), setTab("dashboard"))}>Dashboard</a>
        <a href="#" aria-current={tab === "onboarding" ? "page" : undefined} onClick={(e) => (e.preventDefault(), setTab("onboarding"))}>Onboarding</a>
      </nav>
      {open && <Detail id={open} onClose={() => setOpen(null)} onChange={load} />}
      {tab === "dashboard" && <Dashboard open={setOpen} />}
      {tab === "onboarding" && (
      <>
      <h1>
        Onboarding <span className="soft">at a glance</span>
      </h1>
      <div className="grid" aria-label="Funnel">
        {funnel.map((s) => (
          <div className="card" key={s.stage} style={{ margin: 0 }}>
            <p className="small muted">{s.stage.replace("_", " ")}</p>
            <p className="stat">{s.count}</p>
            {s.conversion !== null && <p className="small muted">{s.conversion}% from previous</p>}
          </div>
        ))}
      </div>
      <div style={{ height: 16 }} />
      <Invite onDone={load} />
      {msg && <p className="note">{msg}</p>}
      <div className="card">
        <h2>Brands</h2>
        <table>
          <thead>
            <tr>
              <th>Brand</th>
              <th>Status</th>
              <th>Step</th>
              <th>Hours in step</th>
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
                  <span className="chip">{r.status}</span>
                </td>
                <td>{r.stepLabel}</td>
                <td>{r.hoursInStep !== null && r.hoursInStep > 48 && r.status === "onboarding" ? <span className="chip bad">{r.hoursInStep} h stuck</span> : r.hoursInStep}</td>
                <td>
                  <div className="row">
                    <button className="btn small ghost" onClick={async () => setMsg((await api<{ sent: boolean }>(`/accounts/${r.id}/remind`, {})).sent ? `Reminder sent to ${r.name}.` : "Already reminded today.")}>
                      Send reminder
                    </button>
                    <button className="btn small ghost" onClick={async () => (await api(`/accounts/${r.id}/advance`, {}), load())}>
                      Re-run
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
