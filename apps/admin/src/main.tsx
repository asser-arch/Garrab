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
  const [f, setF] = useState({ brandName: "", email: "", plan: "starter", website: "" });
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
            const r = await api<{ link: string }>("/invite", { brandName: f.brandName, email: f.email, plan: f.plan, website: f.website || undefined });
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

function App() {
  const [rows, setRows] = useState<Row[]>([]);
  const [funnel, setFunnel] = useState<Stage[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [a, f] = await Promise.all([api<{ accounts: Row[] }>("/accounts"), api<{ stages: Stage[] }>("/funnel")]);
    setRows(a.accounts);
    setFunnel(f.stages);
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <div className="shell">
      <header className="top">
        <span className="logo">
          <span className="tile">G</span> Garrab admin
        </span>
      </header>
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
      {open && <Detail id={open} onClose={() => setOpen(null)} onChange={load} />}
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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
