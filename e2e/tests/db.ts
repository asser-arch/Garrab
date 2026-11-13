import { execFileSync } from "node:child_process";

/** Run SQL against the local dev D1 used by `wrangler dev` (local only). */
export function sql(command: string): void {
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--command", command], {
    cwd: new URL("../../apps/api/", import.meta.url).pathname,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: "pipe",
  });
}

export function setDemoStatus(status: string): void {
  sql(`UPDATE accounts SET status = '${status}', status_version = status_version + 1 WHERE id = 'acc_demo'`);
}
