/** Same-origin calls to /portal-api (the site Worker forwards them to the API Worker). */
export class SignedOut extends Error {}

export async function api<T>(path: string, init: { method?: string; body?: unknown; raw?: string; form?: FormData } = {}): Promise<T> {
  const body = init.form ?? init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : null);
  const r = await fetch(`/portal-api${path}`, {
    method: init.method ?? (body !== null ? "POST" : "GET"),
    // FormData sets its own multipart content type.
    headers: init.form ? {} : init.raw !== undefined ? { "content-type": "text/csv" } : init.body !== undefined ? { "content-type": "application/json" } : {},
    body,
    credentials: "same-origin",
  });
  if (r.status === 401) throw new SignedOut();
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export type Step =
  | "invited"
  | "account_created"
  | "products_imported"
  | "products_tested"
  | "products_approved"
  | "installed"
  | "pilot_live"
  | "converted"
  | "expired";

export interface Me {
  readonly?: boolean;
  account: { name: string; status: string; platform: string | null; website: string | null; plan: string; pilotStartedAt: string | null; pilotEndsAt: string | null; category: "fashion" | "home" };
  step: Step;
  steps: { step: Step; label: string; state: "done" | "active" | "overridden" | "pending" }[];
  snippet: string | null;
  install: { install_status: string; last_checked_at: string | null } | null;
  usage: { used: number; included: number; extra: number } | null;
  brandLink: { url: string; urlAr: string } | null;
  look: { color: string | null; textColor: string | null; logo: string | null };
  hostedLinks: { productId: string; title: string; image: string | null; url: string; urlAr: string }[];
}

export interface Product {
  id: string;
  title: string;
  image: string | null;
  kind: string;
  url: string | null;
  /** Added by hand in the portal (so it can be deleted); otherwise read from the brand's website. */
  manual: boolean;
  selected: boolean;
  tested: boolean;
  result: "pending" | "passed" | "review" | "failed";
  reason: string | null;
  decision: "approved" | "hidden" | null;
  /** How many more times the brand can ask for new test previews of this product. */
  retestsLeft: number;
  tests: string[];
}

export const STEP_ORDER: Step[] = ["invited", "account_created", "products_imported", "products_tested", "products_approved", "installed", "pilot_live"];
export const atOrAfter = (step: Step, target: Step): boolean => STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf(target) || step === "converted";
