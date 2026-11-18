import { useEffect, useState } from "react";
import { api } from "../api.js";

type State = "email" | "sending" | "code" | "checking" | "link" | "bad_link";

function readToken(): string | null {
  return new URLSearchParams(location.hash.slice(1)).get("t");
}

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(readToken);
  const [state, setState] = useState<State>(() => (readToken() ? "link" : "email"));

  // Sign-in link: /portal/login#t=<token>. We never use it automatically: email scanners (Outlook Safe Links)
  // open links in a hidden browser, and would use it up. The owner taps "Sign in" instead.
  useEffect(() => {
    const onHash = (): void => {
      const t = readToken();
      if (t) {
        setToken(t);
        setState("link");
      }
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const useLink = async (): Promise<void> => {
    if (!token) return;
    setState("checking");
    try {
      await api("/auth/verify", { body: { token } });
      history.replaceState(null, "", "/portal/login");
      onSignedIn();
    } catch {
      history.replaceState(null, "", "/portal/login");
      setToken(null);
      setState("bad_link");
    }
  };

  const sendCode = async (): Promise<void> => {
    setError(null);
    setState("sending");
    await api("/auth/request", { body: { email } }).catch(() => undefined);
    setCode("");
    setState("code");
  };

  const checkCode = async (): Promise<void> => {
    setError(null);
    setState("checking");
    try {
      await api("/auth/code", { body: { email, code } });
      onSignedIn();
    } catch (e) {
      const busy = e instanceof Error && /rate|429/.test(e.message);
      setError(busy ? "Too many tries. Wait a minute, then try again." : "That code didn't work. Check it, or send a new one.");
      setState("code");
    }
  };

  return (
    <div className="auth">
      <aside className="auth-brand">
        <a className="logo" href="/portal">
          <span className="tile">G</span> Garrab
        </a>
        <p className="statement">
          Your shop&rsquo;s fitting room, <span>open all day.</span>
        </p>
        <ul className="facts">
          <li>Shoppers see your pieces on themselves before they buy.</li>
          <li>You approve every product before anything goes live.</li>
          <li>Set up and run for you. No password needed.</li>
        </ul>
      </aside>
      <main className="auth-form">
      <div className="card">
        <h1>
          Sign in <span className="soft">to your portal</span>
        </h1>

        {(state === "link" || (state === "checking" && token)) && (
          <>
            <p>Tap the button to finish signing in. You'll stay signed in on this device for 60 days.</p>
            <button className="btn" type="button" onClick={useLink} disabled={state === "checking"}>
              {state === "checking" ? "Signing you in…" : "Sign in"}
            </button>
          </>
        )}

        {state === "bad_link" && (
          <p className="warn" role="alert">
            That link has expired or was already used. Enter your email below and we'll send you a code.
          </p>
        )}

        {(state === "email" || state === "sending" || state === "bad_link") && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendCode();
            }}
          >
            <label htmlFor="email">Your email</label>
            <input id="email" name="email" type="email" autoComplete="email" spellCheck={false} autoCapitalize="none" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <p className="small muted">No password. We email you a 6-digit code.</p>
            <button className="btn" type="submit" disabled={state === "sending"}>
              {state === "sending" ? "Sending…" : "Email me a code"}
            </button>
          </form>
        )}

        {(state === "code" || (state === "checking" && !token)) && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void checkCode();
            }}
          >
            <p className="note" role="status">
              If <strong>{email}</strong> has a Garrab account, a code is on its way. It works for 15 minutes.
            </p>
            <label htmlFor="code">6-digit code</label>
            <input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ""))}
              style={{ fontSize: "1.4rem", letterSpacing: "0.3em", fontVariantNumeric: "tabular-nums" }}
            />
            {error && (
              <p className="warn" role="alert">
                {error}
              </p>
            )}
            <button className="btn" type="submit" disabled={state === "checking"}>
              {state === "checking" ? "Signing you in…" : "Sign in"}
            </button>
            <p className="small muted">
              No email? Check spam, or{" "}
              <button type="button" className="linkish" onClick={() => void sendCode()}>
                send a new code
              </button>{" "}
              ·{" "}
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  setError(null);
                  setState("email");
                }}
              >
                use another email
              </button>
              .
            </p>
          </form>
        )}
      </div>
      <p className="small muted powered">
        <a href="https://www.theinfinisync.com" target="_blank" rel="noopener">
          Powered by Infinisync by Arotech
        </a>
      </p>
      </main>
    </div>
  );
}
