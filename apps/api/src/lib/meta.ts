/**
 * Meta Conversions API: the server half of the "Lead" event when a brand signs up for the free pilot on
 * app.garrabb.com/start (the browser half is fired by pixel.js with the same event ID; Meta counts it once).
 * Garrab's own marketing only: never anything about brands' shoppers.
 * Sent only in production, only with META_CAPI_TOKEN set. Email and phone are SHA-256 hashed first (Meta's rule);
 * nothing else about the brand is sent. Failures are logged and never affect the sign-up.
 */
import type { Env } from "../env.js";
import { workerFetch } from "./http.js";
import { log } from "./log.js";

export const META_DATASET_ID = "2607650933071134";
const GRAPH_VERSION = "v23.0";

async function sha256(v: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v.trim().toLowerCase()));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface LeadEvent {
  eventId: string;
  email: string;
  phone?: string | null;
  sourceUrl: string;
  ip?: string | null;
  userAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
}

export async function metaLeadBody(e: LeadEvent, now = Date.now()): Promise<Record<string, unknown>> {
  const digits = (e.phone ?? "").replace(/\D/g, "");
  // Egyptian mobile numbers written locally (01…) get the country code (Meta wants 20…).
  const phone = digits.startsWith("0") && digits.length === 11 ? `2${digits}` : digits;
  return {
    data: [
      {
        event_name: "Lead",
        event_time: Math.floor(now / 1000),
        event_id: e.eventId,
        action_source: "website",
        event_source_url: e.sourceUrl,
        user_data: {
          ...(e.ip ? { client_ip_address: e.ip } : {}),
          ...(e.userAgent ? { client_user_agent: e.userAgent } : {}),
          em: [await sha256(e.email)],
          ...(phone.length >= 8 ? { ph: [await sha256(phone)] } : {}),
          ...(e.fbp ? { fbp: e.fbp } : {}),
          ...(e.fbc ? { fbc: e.fbc } : {}),
        },
      },
    ],
  };
}

export async function sendMetaLead(env: Env, e: LeadEvent, fetcher: typeof fetch = workerFetch): Promise<boolean> {
  if (env.ENVIRONMENT !== "prod" || !env.META_CAPI_TOKEN) return false;
  try {
    const r = await fetcher(`https://graph.facebook.com/${GRAPH_VERSION}/${META_DATASET_ID}/events`, {
      method: "POST",
      // The token goes in the body (not the URL), so it never shows up in request logs.
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(await metaLeadBody(e)), access_token: env.META_CAPI_TOKEN }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) log("meta_capi", { code: `HTTP ${r.status}` });
    return r.ok;
  } catch {
    log("meta_capi", { code: "network" });
    return false;
  }
}
