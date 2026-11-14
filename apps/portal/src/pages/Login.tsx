import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "verifying" | "bad_link">("idle");
  const once = useRef(false);

  // Magic link: /portal/login#t=<token>. The token lives in the fragment, so link scanners can't use it.
  useEffect(() => {
    const t = new URLSearchParams(location.hash.slice(1)).get("t");
    if (!t || once.current) return;
    once.current = true;
    history.replaceState(null, "", "/portal/login");
    setState("verifying");
    api("/auth/verify", { body: { token: t } })
      .then(onSignedIn)
      .catch(() => setState("bad_link"));
  }, [onSignedIn]);

  return (
    <div className="shell" style={{ maxWidth: 480 }}>
      <header className="top">
        <span className="logo">
          <span className="tile">G</span> Garrab
        </span>
      </header>
      <div className="card">
        <h1>
          Sign in <span className="soft">to your portal</span>
        </h1>
        {state === "verifying" && <p>Signing you in…</p>}
        {state === "sent" && (
          <p className="note" role="status">
            If that email has a Garrab account, a sign-in link is on its way. It works once and expires in 15 minutes.
          </p>
        )}
        {state === "bad_link" && (
          <p className="warn" role="alert">
            That link has expired or was already used. Ask for a new one below.
          </p>
        )}
        {state !== "verifying" && state !== "sent" && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setState("sending");
              await api("/auth/request", { body: { email } }).catch(() => undefined);
              setState("sent");
            }}
          >
            <label htmlFor="email">Your email</label>
            <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <p className="small muted">No password. We email you a one-time link.</p>
            <button className="btn" type="submit" disabled={state === "sending"}>
              Email me a sign-in link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
