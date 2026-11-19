/**
 * Support inbox: every brand's chat with Garrab support. Replying here stops the automatic replies for
 * that brand (for a while) and emails the brand that support answered.
 */
import { useCallback, useEffect, useRef, useState } from "react";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    `/admin-api${path}`,
    body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export interface Thread {
  accountId: string;
  name: string;
  lastAt: string;
  lastSender: "brand" | "bot" | "admin";
  lastBody: string;
  waiting: boolean;
}
interface Msg {
  id: string;
  sender: "brand" | "bot" | "admin";
  body: string;
  created_at: string;
}

const when = (iso: string): string => {
  const d = new Date(iso);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** Waiting conversations, for the tab badge (polled every 30 s anywhere in the admin). */
export function useSupportWaiting(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const tick = (): void => void api<{ waiting: number }>("/support").then((r) => setN(r.waiting), () => undefined);
    tick();
    const t = setInterval(tick, 30_000);
    addEventListener("garrab:support-changed", tick);
    return () => (clearInterval(t), removeEventListener("garrab:support-changed", tick));
  }, []);
  return n;
}

export function Support({ openBrand, initial }: { openBrand: (id: string) => void; initial: string | null }) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [sel, setSel] = useState<string | null>(initial);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => setThreads((await api<{ threads: Thread[] }>("/support")).threads), []);
  const loadChat = useCallback(async (id: string) => {
    const r = await api<{ account: { name: string }; messages: Msg[] }>(`/support/${id}`);
    setName(r.account.name);
    setMsgs(r.messages);
  }, []);

  useEffect(() => {
    void loadThreads().catch(() => undefined);
    const t = setInterval(() => void loadThreads().catch(() => undefined), 15_000);
    return () => clearInterval(t);
  }, [loadThreads]);

  useEffect(() => {
    if (!sel) return;
    void loadChat(sel).catch(() => setErr("Couldn't load this chat."));
    const t = setInterval(() => void loadChat(sel).catch(() => undefined), 8_000);
    return () => clearInterval(t);
  }, [sel, loadChat]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [msgs.length, sel]);

  const send = async (): Promise<void> => {
    if (!sel || !text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/support/${sel}`, { body: text.trim() });
      setText("");
      await Promise.all([loadChat(sel), loadThreads()]);
      dispatchEvent(new Event("garrab:support-changed"));
    } catch {
      setErr("Not sent. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Support <span className="soft">chats with brands</span>
          </h1>
          <p className="small muted">
            Brands write from their portal. Until you reply, the first 3 messages get an automatic answer. Once you reply, automatic answers stop for 12 hours and the
            brand gets an email. New messages also come to Telegram.
          </p>
        </div>
      </div>
      <div className="support">
        <div className="card support-threads">
          <h2>Conversations</h2>
          {threads === null && <p className="small muted">Loading…</p>}
          {threads?.length === 0 && <p className="small muted">No messages yet.</p>}
          <ul>
            {threads?.map((t) => (
              <li key={t.accountId}>
                <button type="button" aria-current={sel === t.accountId ? "true" : undefined} onClick={() => {
                    setSel(t.accountId);
                    // Phones: the chat is under the list; bring it into view.
                    if (innerWidth < 900) setTimeout(() => document.querySelector(".support-chat")?.scrollIntoView({ block: "start" }), 50);
                  }}>
                  <span className="st-top">
                    <strong>{t.name}</strong>
                    <span className="small muted">{when(t.lastAt)}</span>
                  </span>
                  <span className="small muted st-body" dir="auto">
                    {t.lastSender === "admin" ? "You: " : t.lastSender === "bot" ? "Auto: " : ""}
                    {t.lastBody}
                  </span>
                  {t.waiting && <span className="chip peach">Waiting for you</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="card support-chat">
          {!sel ? (
            <p className="small muted">Choose a conversation.</p>
          ) : (
            <>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}>{name}</h2>
                <button type="button" className="btn ghost small" onClick={() => openBrand(sel)}>
                  Open brand
                </button>
              </div>
              <div className="sc-list" ref={list}>
                {msgs.map((m) => (
                  <div key={m.id} className={`sc-msg from-${m.sender}`} dir="auto">
                    <span className="small muted">
                      {m.sender === "brand" ? name : m.sender === "bot" ? "Automatic reply" : "Garrab support (you)"} · {when(m.created_at)}
                    </span>
                    <span className="sc-text">{m.body}</span>
                  </div>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <label htmlFor="sc-reply">Reply as Garrab support</label>
                <textarea
                  id="sc-reply"
                  dir="auto"
                  maxLength={2000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                {err && (
                  <p className="warn" role="alert">
                    {err}
                  </p>
                )}
                <p className="row">
                  <button className="btn" type="submit" disabled={busy || !text.trim()}>
                    {busy ? "Sending…" : "Send reply"}
                  </button>
                  <span className="small muted">Ctrl+Enter sends. The brand sees it in their portal and gets an email.</span>
                </p>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  );
}
