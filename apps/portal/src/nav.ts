/**
 * Portal pages and moving between them (no router library). Pages import `go` from here, not from main.tsx,
 * so the app's entry point and its pages never depend on each other in a loop.
 */
export type Route = "/portal" | "/portal/products" | "/portal/approve" | "/portal/install" | "/portal/results" | "/portal/billing" | "/portal/login";

const ROUTES: readonly Route[] = ["/portal/products", "/portal/approve", "/portal/install", "/portal/results", "/portal/billing", "/portal/login"];

export function currentRoute(): Route {
  const p = location.pathname.replace(/\/+$/, "") || "/portal";
  return (ROUTES as readonly string[]).includes(p) ? (p as Route) : "/portal";
}

export function go(to: Route): void {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}
