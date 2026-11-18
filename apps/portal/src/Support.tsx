/**
 * Support chat: a "Help" button fixed at the bottom right of the portal, opening a chat panel with
 * Garrab support. The first replies can be automatic (labelled), until someone from the team answers.
 * Polls while open (every 5 s) and for the unread badge while closed (every 60 s).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

interface Msg {
  id: string;
  from: "you" | "auto" | "support";
  body: string;
  at: string;
}

const time = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString("en-GB", today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

export function Support({ readonly }: { readonly: boolean }) {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).has("chat"));
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const r = await api<{ messages: Msg[] }>("/support");
    setMsgs(r.messages);
    setUnread(0);
  }, []);

  // "Chat with Garrab support" links elsewhere in the portal open the panel.
  useEffect(() => {
    const show = (): void => setOpen(true);
    addEventListener("garrab:chat", show);
    return () => removeEventListener("garrab:chat", show);
  }, []);

  useEffect(() => {
    if (!open) {
      const tick = (): void => void api<{ unread: number }>("/support/unread").then((r) => setUnread(r.unread), () => undefined);
      tick();
      const t = setInterval(tick, 60_000);
      return () => clearInterval(t);
    }
    void load().catch(() => undefined);
    const t = setInterval(() => void load().catch(() => undefined), 5_000);
    setTimeout(() => input.current?.focus(), 50);
    const esc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    addEventListener("keydown", esc);
    return () => {
      clearInterval(t);
      removeEventListener("keydown", esc);
    };
  }, [open, load]);

  // Keep the newest message in view.
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [msgs?.length, sending]);

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    setMsgs((m) => [...(m ?? []), { id: "pending", from: "you", body, at: new Date().toISOString() }]);
    setText("");
    try {
      const r = await api<{ messages: Msg[] }>("/support", { body: { body } });
      setMsgs((m) => [...(m ?? []).filter((x) => x.id !== "pending"), ...r.messages.filter((x) => !(m ?? []).some((y) => y.id === x.id))]);
    } catch (e) {
      setMsgs((m) => (m ?? []).filter((x) => x.id !== "pending"));
      setText(body);
      setError(e instanceof Error && /rate/.test(e.message) ? "That's a lot of messages in one hour. Please wait a little, then send again." : "Your message didn't send. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {open && (
        <section className="chat" role="dialog" aria-label="Chat with Garrab support">
          <header className="chat-head">
            <div>
              <p className="chat-title">Garrab support</p>
              <p className="chat-sub">We usually reply within a few hours.</p>
            </div>
            <button
              type="button"
              className="chat-close"
              aria-label="Close chat"
              onClick={() => {
                setOpen(false);
                button.current?.focus();
              }}
            >
              ×
            </button>
          </header>
          <div className="chat-list" ref={list} aria-live="polite">
            {msgs === null && <p className="small muted">Loading…</p>}
            {msgs?.length === 0 && (
              <p className="chat-empty">
                Ask us anything: your pilot, products, approving, installing, links or billing. You can write in English or Arabic.
              </p>
            )}
            {msgs?.map((m) => (
              <div key={m.id} className={`bubble ${m.from === "you" ? "mine" : "theirs"}`} dir="auto">
                {m.from !== "you" && <span className="bubble-who">{m.from === "auto" ? "Automatic reply" : "Garrab support"}</span>}
                <span className="bubble-text">{m.body}</span>
                <span className="bubble-time">{m.id === "pending" ? "Sending…" : time(m.at)}</span>
              </div>
            ))}
            {sending && (
              <div className="bubble theirs typing" aria-label="Replying">
                <span>•</span>
                <span>•</span>
                <span>•</span>
              </div>
            )}
          </div>
          {error && (
            <p className="warn chat-error" role="alert">
              {error}
            </p>
          )}
          {readonly ? (
            <p className="small muted chat-foot">Read-only view: messages can't be sent from here.</p>
          ) : (
            <form
              className="chat-form"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label htmlFor="chat-input" className="sr-only">
                Your message
              </label>
              <textarea
                id="chat-input"
                ref={input}
                rows={2}
                maxLength={2000}
                dir="auto"
                placeholder="Write a message…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button className="btn" type="submit" disabled={sending || !text.trim()}>
                Send
              </button>
            </form>
          )}
        </section>
      )}
      <button
        ref={button}
        type="button"
        className="chat-fab"
        aria-expanded={open}
        aria-label={unread ? `Help: ${unread} new ${unread === 1 ? "reply" : "replies"}` : "Help"}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
        {open ? "Close" : "Help"}
        {unread > 0 && !open && <span className="chat-badge">{unread}</span>}
      </button>
    </>
  );
}
