import type { Env } from "./env.js";
import { log } from "./lib/log.js";
import { nowIso } from "./lib/time.js";
import { tryOnProvider } from "./providers/tryon.js";

type Job = (env: Env, now: Date) => Promise<void>;

/** Retry provider deletes that failed during a request. */
const retryPendingDeletes: Job = async (env) => {
  const rows = await env.DB.prepare("SELECT provider_ref, attempts FROM pending_deletes ORDER BY created_at LIMIT 50").all<{
    provider_ref: string;
    attempts: number;
  }>();
  const provider = tryOnProvider(env);
  for (const r of rows.results) {
    if (await provider.deleteUserData(r.provider_ref)) {
      await env.DB.prepare("DELETE FROM pending_deletes WHERE provider_ref = ?").bind(r.provider_ref).run();
    } else {
      await env.DB.prepare("UPDATE pending_deletes SET attempts = attempts + 1 WHERE provider_ref = ?").bind(r.provider_ref).run();
    }
  }
};

/** Jobs run on every 15-minute tick. Cairo-time jobs (digest, billing) arrive in later phases. */
const EVERY_TICK: Record<string, Job> = { retry_pending_deletes: retryPendingDeletes };

export async function runScheduled(env: Env, now: Date): Promise<void> {
  for (const [name, job] of Object.entries(EVERY_TICK)) {
    const started = nowIso();
    let ok = true;
    let error: string | null = null;
    try {
      await job(env, now);
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message.slice(0, 200) : "error";
    }
    await env.DB.prepare("INSERT INTO cron_runs (job, started_at, finished_at, ok, error) VALUES (?, ?, ?, ?, ?)")
      .bind(name, started, nowIso(), ok ? 1 : 0, error)
      .run();
    log("cron", { job: name, ok });
  }
}
