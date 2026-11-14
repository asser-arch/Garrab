/**
 * Kashier webhook verification (developers.kashier.io/docs/webhooks, checked 13 Nov 2026):
 * sort data.signatureKeys alphabetically, take those keys' values from `data`, URL-encode the
 * VALUES only, join as k=v with &, HMAC-SHA256 with the Payment API Key, compare (hex, case-
 * insensitive) with the `x-kashier-signature` header. Branch on data.status, never on `event`.
 *
 * Kept ready for when Asser opens a Kashier account (automatic InstaPay QR / request-to-pay, cards).
 * Direct InstaPay is the active provider today.
 */

/** query-string's strict encoding (what Kashier's Node sample uses): encodeURIComponent plus !'()*. */
function strictEncode(v: string): string {
  return encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function kashierSignaturePayload(data: Record<string, unknown>): string {
  const keys = Array.isArray(data.signatureKeys) ? (data.signatureKeys as unknown[]).filter((k): k is string => typeof k === "string") : [];
  return [...keys]
    .sort()
    .map((k) => `${k}=${strictEncode(String(data[k] ?? ""))}`)
    .join("&");
}

export async function verifyKashierSignature(data: Record<string, unknown>, header: string | null | undefined, paymentApiKey: string): Promise<boolean> {
  if (!header || !paymentApiKey) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(paymentApiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(kashierSignaturePayload(data)));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const got = header.trim().toLowerCase();
  if (got.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
