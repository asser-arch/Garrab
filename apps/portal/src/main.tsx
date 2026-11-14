import "@garrab/shared/ui.css";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SignedOut, api, type Me } from "./api.js";
import { Approve } from "./pages/Approve.js";
import { Billing } from "./pages/Billing.js";
import { Home } from "./pages/Home.js";
import { Install } from "./pages/Install.js";
import { Login } from "./pages/Login.js";
import { Products } from "./pages/Products.js";

export type Route = "/portal" | "/portal/products" | "/portal/approve" | "/portal/install" | "/portal/billing" | "/portal/login";

function currentRoute(): Route {
  const p = location.pathname.replace(/\/+$/, "") || "/portal";
  return (["/portal/products", "/portal/approve", "/portal/install", "/portal/billing", "/portal/login"].includes(p) ? p : "/portal") as Route;
}

export function go(to: Route): void {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

function Link({ to, children }: { to: Route; children: React.ReactNode }) {
  const current = currentRoute() === to;
  return (
    <a
      href={to}
      aria-current={current ? "page" : undefined}
      onClick={(e) => {
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

function App() {
  const [route, setRoute] = useState<Route>(currentRoute());
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("/me"));
      setSignedOut(false);
    } catch (e) {
      if (e instanceof SignedOut) setSignedOut(true);
    }
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (route !== "/portal/login") void refresh();
  }, [route, refresh]);

  if (route === "/portal/login" || signedOut) return <Login onSignedIn={() => go("/portal")} />;
  if (!me) return <div className="shell muted">Loading…</div>;

  return (
    <div className="shell">
      <header className="top">
        <a className="logo" href="/portal" onClick={(e) => (e.preventDefault(), go("/portal"))}>
          <span className="tile">G</span> Garrab
        </a>
        <nav className="tabs" aria-label="Portal">
          <Link to="/portal">Home</Link>
          <Link to="/portal/products">Products</Link>
          <Link to="/portal/approve">Approve</Link>
          <Link to="/portal/install">Install & links</Link>
          <Link to="/portal/billing">Billing</Link>
        </nav>
      </header>
      <main className="fade" key={route}>
        {route === "/portal" && <Home me={me} refresh={refresh} />}
        {route === "/portal/products" && <Products me={me} refresh={refresh} />}
        {route === "/portal/approve" && <Approve me={me} refresh={refresh} />}
        {route === "/portal/install" && <Install me={me} refresh={refresh} />}
        {route === "/portal/billing" && <Billing />}
      </main>
      <p className="small muted">
        Need help? Reply to any Garrab email. ·{" "}
        <a
          href="#"
          onClick={async (e) => {
            e.preventDefault();
            await api("/auth/logout", { body: {} }).catch(() => undefined);
            setSignedOut(true);
          }}
        >
          Sign out
        </a>
      </p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
