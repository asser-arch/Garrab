/**
 * Structured logger that can only log an allow-list of fields.
 * There is deliberately no way to log free-form objects, request bodies, headers or IPs.
 * Unknown fields are dropped and reported as `dropped_fields` (names only).
 */
const ALLOWED = new Set([
  "route",
  "status",
  "ms",
  "account",
  "kind",
  "provider",
  "ok",
  "code",
  "job",
  "count",
  "env",
]);

type Primitive = string | number | boolean | null;

export function log(event: string, fields: Record<string, Primitive> = {}): void {
  const out: Record<string, Primitive> = { event };
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.has(k)) {
      dropped.push(k);
      continue;
    }
    // Strings are capped so nothing large (like base64 bytes) can ever slip through.
    out[k] = typeof v === "string" ? v.slice(0, 80) : v;
  }
  if (dropped.length) out.dropped_fields = dropped.join(",");
  console.log(JSON.stringify(out));
}
