import { execFileSync } from "node:child_process";

const opts = () => ({
  cwd: new URL("../../apps/api/", import.meta.url).pathname,
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
});

/** Run SQL against the local dev D1 used by `wrangler dev` (local only). */
export function sql(command: string): void {
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--command", command], { ...opts(), stdio: "pipe" });
}

/** Query the local dev D1 and return rows. */
export function query<T = Record<string, unknown>>(command: string): T[] {
  const out = execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--json", "--command", command], { ...opts(), encoding: "utf8" });
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results: T[] }[];
  return parsed[0]?.results ?? [];
}

export function setDemoStatus(status: string): void {
  sql(`UPDATE accounts SET status = '${status}', status_version = status_version + 1 WHERE id = 'acc_demo'`);
}
