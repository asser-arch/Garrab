#!/usr/bin/env node
/**
 * Find-or-create the Cloudflare resources for one environment (staging | prod) and write their IDs
 * into apps/api/wrangler.jsonc for this checkout only (CI workspace; nothing is committed).
 * Idempotent: resources are looked up by name, so re-running never creates duplicates.
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
 */
import { readFileSync, writeFileSync } from "node:fs";

const envName = process.argv[2];
if (envName !== "staging" && envName !== "prod") throw new Error("usage: cf-provision.mjs staging|prod");
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");

const LOCATION = "eeur"; // Eastern Europe: closest Cloudflare storage region to Egypt
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;

async function cf(method, path, body) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const msg = (j.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${r.status}`;
    const hint = (j.errors ?? []).some((e) => e.code === 10042)
      ? "\nR2 is not switched on for this account: Cloudflare dashboard → R2 Object Storage → Get started / Purchase R2 (free tier), then re-run."
      : "";
    const err = new Error(`${method} ${path} → ${msg}${hint}`);
    err.status = r.status;
    throw err;
  }
  return j.result;
}

const path = new URL("../apps/api/wrangler.jsonc", import.meta.url);
const cfg = JSON.parse(readFileSync(path, "utf8"));
const e = cfg.env[envName];

// D1
const dbName = e.d1_databases[0].database_name;
let db = (await cf("GET", `/d1/database?name=${encodeURIComponent(dbName)}`)).find((d) => d.name === dbName);
if (!db) db = await cf("POST", "/d1/database", { name: dbName, primary_location_hint: LOCATION });
e.d1_databases[0].database_id = db.uuid;
console.log(`D1 ${dbName}: ok`);

// KV
const kvTitle = `garrab-config-${envName}`;
const kvs = await cf("GET", "/storage/kv/namespaces?per_page=100");
let kv = kvs.find((n) => n.title === kvTitle);
if (!kv) kv = await cf("POST", "/storage/kv/namespaces", { title: kvTitle });
e.kv_namespaces[0].id = kv.id;
console.log(`KV ${kvTitle}: ok`);

// R2
const bucket = e.r2_buckets[0].bucket_name;
try {
  await cf("GET", `/r2/buckets/${bucket}`);
} catch (err) {
  if (err.status !== 404) throw err;
  await cf("POST", "/r2/buckets", { name: bucket, locationHint: LOCATION });
}
console.log(`R2 ${bucket}: ok`);

// Queue
const queue = e.queues.producers[0].queue;
const queues = await cf("GET", "/queues?per_page=100");
if (!queues.some((q) => q.queue_name === queue)) await cf("POST", "/queues", { queue_name: queue });
console.log(`Queue ${queue}: ok`);

writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
console.log(`wrangler.jsonc (${envName}) filled for this run`);
