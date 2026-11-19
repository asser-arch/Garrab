/**
 * Onboarding state machine (brief §6):
 *   invited → account_created → products_imported → products_tested → products_approved → installed → pilot_live → converted | expired
 *
 * `advance()` looks at the account and moves it forward as far as the facts allow. It is
 * idempotent, race-safe (each move is a compare-and-set on `onboarding_step`), and safe to
 * call from anywhere: queue jobs, the 15-minute sweep, portal actions, admin buttons.
 * Every step can be overridden by the admin (audit-logged).
 */
import { OnboardingStep } from "@garrab/shared";
import { PILOT } from "@garrab/shared/plans";
import { emails } from "../emails.js";
import type { Env } from "../env.js";
import { widgetKey } from "../lib/accounts.js";
import { createSignIn } from "../lib/auth.js";
import { ulid } from "../lib/crypto.js";
import { invalidateStatus } from "../lib/db.js";
import { sendOnce } from "../lib/email.js";
import { log } from "../lib/log.js";
import { alert } from "../lib/ops.js";
import { cairoDay } from "../lib/time.js";
import { BOT_UA, importForAccount } from "./import.js";
import { listFixtures } from "./tests.js";

export type Step = OnboardingStep;
export const STEPS = OnboardingStep.options;

/** Plain-language names shown to brands and in the admin. */
export const STEP_LABEL: Record<Step, string> = {
  invited: "Invitation sent",
  account_created: "Reading your products",
  products_imported: "Testing your products",
  products_tested: "Approve your previews",
  products_approved: "Add Garrab to your shop",
  installed: "Starting your pilot",
  pilot_live: "Pilot live",
  converted: "Paying customer",
  expired: "Pilot ended",
};

interface Acc {
  id: string;
  name: string;
  email: string | null;
  slug: string;
  status: string;
  platform: string | null;
  website: string | null;
  target_plan_id: string | null;
  onboarding_step: Step;
  onboarding_step_at: string | null;
  approved_at: string | null;
  installed_at: string | null;
}

async function load(env: Env, id: string): Promise<Acc | null> {
  return env.DB.prepare(
    `SELECT id, name, email, slug, status, platform, website, target_plan_id, onboarding_step, onboarding_step_at, approved_at, installed_at
       FROM accounts WHERE id = ?`,
  )
    .bind(id)
    .first<Acc>();
}

export const portalUrl = (env: Env, path = ""): string => `${env.APP_ORIGIN}/portal${path}`;

/** Compare-and-set the step. Returns false if someone else moved it first. */
async function moveStep(env: Env, acc: Acc, to: Step, actor = "system", note: string | null = null, overridden = false): Promise<boolean> {
  const now = new Date().toISOString();
  const r = await env.DB.prepare("UPDATE accounts SET onboarding_step = ?, onboarding_step_at = ?, updated_at = ? WHERE id = ? AND onboarding_step = ?")
    .bind(to, now, now, acc.id, acc.onboarding_step)
    .run();
  if (r.meta.changes !== 1) return false;
  await env.DB.batch([
    env.DB.prepare("UPDATE onboarding_steps SET state = ?, done_at = ?, actor = ?, note = COALESCE(?, note) WHERE account_id = ? AND step = ?").bind(
      overridden ? "overridden" : "done",
      now,
      actor,
      note,
      acc.id,
      acc.onboarding_step,
    ),
    env.DB.prepare(
      `INSERT INTO onboarding_steps (account_id, step, state, entered_at) VALUES (?, ?, 'active', ?)
       ON CONFLICT(account_id, step) DO UPDATE SET state = 'active', entered_at = excluded.entered_at, done_at = NULL`,
    ).bind(acc.id, to, now),
    env.DB.prepare("INSERT INTO audit_log (id, account_id, actor, action, reason, meta_json) VALUES (?, ?, ?, 'onboarding_step', ?, ?)").bind(
      ulid(),
      acc.id,
      actor,
      note,
      JSON.stringify({ from: acc.onboarding_step, to }),
    ),
  ]);
  log("onboarding_step", { account: acc.id, kind: to });
  acc.onboarding_step = to;
  acc.onboarding_step_at = now;
  return true;
}

async function stepNote(env: Env, accountId: string, step: Step): Promise<string | null> {
  const r = await env.DB.prepare("SELECT note FROM onboarding_steps WHERE account_id = ? AND step = ?").bind(accountId, step).first<{ note: string | null }>();
  return r?.note ?? null;
}

async function setStepNote(env: Env, accountId: string, step: Step, note: string): Promise<void> {
  await env.DB.prepare("UPDATE onboarding_steps SET note = ? WHERE account_id = ? AND step = ?").bind(note, accountId, step).run();
}

async function userId(env: Env, accountId: string): Promise<{ id: string; email: string } | null> {
  return env.DB.prepare("SELECT id, email FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1").bind(accountId).first<{ id: string; email: string }>();
}

// ---------------------------------------------------------------------------
// Install check: is the Garrab line on the brand's pages?

export async function checkInstall(env: Env, accountId: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const acc = await env.DB.prepare("SELECT website FROM accounts WHERE id = ?").bind(accountId).first<{ website: string | null }>();
  const key = await widgetKey(env, accountId);
  if (!acc?.website || !key) return false;
  const origin = new URL(acc.website).origin;
  const products = await env.DB.prepare(
    "SELECT product_url, url_path FROM products WHERE account_id = ? AND brand_decision = 'approved' AND enabled = 1 ORDER BY updated_at DESC LIMIT 2",
  )
    .bind(accountId)
    .all<{ product_url: string | null; url_path: string | null }>();
  const urls = [...products.results.map((p) => p.product_url ?? (p.url_path ? `${origin}${p.url_path}` : null)), `${origin}/`].filter(
    (u): u is string => !!u && u.startsWith(origin),
  );
  let found = false;
  for (const u of urls) {
    try {
      const r = await fetcher(u, { headers: { "user-agent": BOT_UA, accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
      const html = r.ok ? await r.text() : "";
      if (html.includes(key) && /\/w\.js/.test(html)) {
        found = true;
        break;
      }
    } catch {
      /* try next */
    }
  }
  await env.DB.prepare("UPDATE domains SET install_status = ?, last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE account_id = ?")
    .bind(found ? "installed" : "not_found", accountId)
    .run();
  return found;
}

// ---------------------------------------------------------------------------

export interface AdvanceDeps {
  fetcher?: typeof fetch;
  /** Run product tests inline (tests/dev) instead of queueing them. */
  runTestsInline?: (accountId: string, productId: string) => Promise<unknown>;
}

const HOUR = 3_600_000;

/** Move the account forward as far as possible. Returns the step it ends on. */
export async function advance(env: Env, accountId: string, deps: AdvanceDeps = {}): Promise<Step | null> {
  const acc = await load(env, accountId);
  if (!acc) return null;
  const fetcher = deps.fetcher ?? fetch;

  for (let guard = 0; guard < STEPS.length * 2; guard++) {
    const before = acc.onboarding_step;
    switch (acc.onboarding_step) {
      case "invited": {
        const u = await userId(env, acc.id);
        if (!u) return acc.onboarding_step;
        const { link, code } = await createSignIn(env, u.id, u.email);
        await sendOnce(env, { accountId: acc.id, template: "welcome", dedupeKey: `welcome:${acc.id}`, msg: emails.welcome(u.email, acc.name, link, code) });
        await moveStep(env, acc, "account_created");
        break;
      }

      case "account_created": {
        let selected = await countSelected(env, acc.id);
        if (selected === 0 && acc.website && acc.platform !== "social_only") {
          const last = await stepNote(env, acc.id, "account_created");
          const lastAt = last?.startsWith("import:") ? Date.parse(last.slice(7)) : 0;
          if (Date.now() - lastAt > 6 * HOUR) {
            await setStepNote(env, acc.id, "account_created", `import:${new Date().toISOString()}`);
            await importForAccount(env, acc.id, fetcher);
            selected = await countSelected(env, acc.id);
          }
        }
        if (selected > 0) {
          await moveStep(env, acc, "products_imported", "system", `${selected} products selected`);
          break;
        }
        const u = await userId(env, acc.id);
        if (u) await sendOnce(env, { accountId: acc.id, template: "add_products", dedupeKey: `add_products:${acc.id}`, msg: emails.addProducts(u.email, acc.name, portalUrl(env, "/products")) });
        return acc.onboarding_step; // waits for the brand to add products
      }

      case "products_imported": {
        const pending = await env.DB.prepare("SELECT id FROM products WHERE account_id = ? AND selected = 1 AND test_score IS NULL AND (test_retry_at IS NULL OR test_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(acc.id).all<{ id: string }>();
        if (pending.results.length === 0) {
          // Products waiting to retry after a temporary AI error: not done yet (the retry job tests them).
          const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE account_id = ? AND selected = 1 AND test_score IS NULL").bind(acc.id).first<{ n: number }>();
          if ((waiting?.n ?? 0) > 0) return acc.onboarding_step;
          await moveStep(env, acc, "products_tested");
          break;
        }
        const home = (await env.DB.prepare("SELECT category FROM accounts WHERE id = ?").bind(acc.id).first<{ category: string }>())?.category === "home";
        if ((await listFixtures(env, home ? "room" : "person")).length === 0) {
          await alertOnce(env, `no_fixtures:${cairoDay()}`, "no_fixtures", acc.id, "No stock test photos in R2 (fixtures/). Upload them so product tests can run.");
          return acc.onboarding_step;
        }
        for (const p of pending.results) {
          if (deps.runTestsInline) await deps.runTestsInline(acc.id, p.id);
          else await env.JOBS.send({ t: "test", a: acc.id, p: p.id });
        }
        if (deps.runTestsInline) continue; // re-check this step now that the tests ran
        return acc.onboarding_step;
      }

      case "products_tested": {
        // The brand picked more products after testing: test those too.
        const untested = await env.DB.prepare("SELECT COUNT(*) AS c FROM products WHERE account_id = ? AND selected = 1 AND test_score IS NULL").bind(acc.id).first<{ c: number }>();
        if ((untested?.c ?? 0) > 0) {
          await moveStep(env, acc, "products_imported", "brand", "more products selected");
          break;
        }
        const counts = await env.DB.prepare(
          `SELECT SUM(enabled) AS enabled, SUM(CASE WHEN enabled = 1 AND brand_decision = 'approved' THEN 1 ELSE 0 END) AS approved
             FROM products WHERE account_id = ? AND selected = 1`,
        )
          .bind(acc.id)
          .first<{ enabled: number | null; approved: number | null }>();
        const enabled = counts?.enabled ?? 0;
        const u = await userId(env, acc.id);
        if (enabled === 0) {
          await alertOnce(env, `nothing_enabled:${acc.id}`, "needs_review", acc.id, `${acc.name}: no product passed the automatic test. Review the scores in admin.`);
          return acc.onboarding_step;
        }
        if (u) await sendOnce(env, { accountId: acc.id, template: "approve", dedupeKey: `approve:${acc.id}`, msg: emails.approve(u.email, enabled, portalUrl(env, "/approve")) });
        if (acc.approved_at && (counts?.approved ?? 0) > 0) {
          await moveStep(env, acc, "products_approved", "brand", `${counts?.approved} approved`);
          break;
        }
        return acc.onboarding_step;
      }

      case "products_approved": {
        // Approved products go live straight away on the brand's try-on links (Instagram bio, WhatsApp).
        // The website script is optional and can come later: the install email explains it, the daily
        // install crawler records it, and the widget works the moment it's pasted.
        const social = acc.platform === "social_only" || !acc.website;
        const u = await userId(env, acc.id);
        if (u) await sendOnce(env, { accountId: acc.id, template: "install", dedupeKey: `install:${acc.id}`, msg: emails.install(u.email, social, portalUrl(env, "/install")) });
        await moveStep(env, acc, "installed", acc.installed_at ? "brand" : "system", social ? "hosted links only" : acc.installed_at ? "install check passed" : "links live; website script optional");
        break;
      }

      case "installed": {
        await goLive(env, acc);
        break;
      }

      case "pilot_live":
      case "converted": {
        // Live brands keep adding products: test new ones; the brand approves them in the portal.
        const pending = await env.DB.prepare("SELECT id FROM products WHERE account_id = ? AND selected = 1 AND test_score IS NULL AND (test_retry_at IS NULL OR test_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(acc.id).all<{ id: string }>();
        for (const p of pending.results) {
          if (deps.runTestsInline) await deps.runTestsInline(acc.id, p.id);
          else await env.JOBS.send({ t: "test", a: acc.id, p: p.id });
        }
        return acc.onboarding_step;
      }

      default:
        return acc.onboarding_step; // expired: billing takes over
    }
    if (acc.onboarding_step === before) return acc.onboarding_step;
  }
  return acc.onboarding_step;
}

async function countSelected(env: Env, accountId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM products WHERE account_id = ? AND selected = 1").bind(accountId).first<{ c: number }>();
  return r?.c ?? 0;
}

async function alertOnce(env: Env, dedupe: string, kind: string, accountId: string | null, message: string): Promise<void> {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO notifications (id, account_id, template, channel, dedupe_key, status) VALUES (?, ?, ?, 'alert', ?, 'sent')")
    .bind(ulid(), accountId, kind, `alert:${dedupe}`)
    .run();
  if (r.meta.changes === 1) await alert(env, kind, accountId, message);
}

/** First approved product goes live: the 14-day pilot clock starts (brief §6.7). */
async function goLive(env: Env, acc: Acc): Promise<void> {
  const start = new Date();
  const ends = new Date(start.getTime() + PILOT.days * 86_400_000);
  const ok = await moveStep(env, acc, "pilot_live");
  if (!ok) return;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE accounts SET status = 'pilot', plan_id = 'pilot', status_version = status_version + 1,
              pilot_started_at = ?, pilot_ends_at = ?, cycle_start = ? WHERE id = ?`,
    ).bind(start.toISOString(), ends.toISOString(), cairoDay(start), acc.id),
    env.DB.prepare("INSERT INTO audit_log (id, account_id, actor, action, from_status, to_status, reason) VALUES (?, ?, 'system', 'status', ?, 'pilot', 'pilot started')").bind(
      ulid(),
      acc.id,
      acc.status,
    ),
  ]);
  invalidateStatus(acc.id);
  const u = await userId(env, acc.id);
  const first = await env.DB.prepare("SELECT id FROM products WHERE account_id = ? AND enabled = 1 AND approved = 1 ORDER BY updated_at LIMIT 1")
    .bind(acc.id)
    .first<{ id: string }>();
  if (u)
    await sendOnce(env, {
      accountId: acc.id,
      template: "pilot_day_1",
      dedupeKey: `pilot_day_1:${acc.id}`,
      msg: emails.pilotDay1(u.email, portalUrl(env), { hosted: `${env.APP_ORIGIN}/t/${acc.slug}/${first?.id ?? ""}` }),
    });
}

/** Admin override: force the account to a step (reason required, audit-logged). */
export async function overrideStep(env: Env, accountId: string, to: Step, reason: string, actor: string): Promise<boolean> {
  const acc = await load(env, accountId);
  if (!acc || !reason.trim()) return false;
  if (to === "pilot_live") {
    if (acc.onboarding_step !== "installed" && !(await moveStep(env, acc, "installed", `admin:${actor}`, reason, true))) return false;
    await goLive(env, acc);
    return true;
  }
  return moveStep(env, acc, to, `admin:${actor}`, reason, true);
}

/** Brand approval in the portal: approve or hide one product. */
export async function decideProduct(env: Env, accountId: string, productId: string, decision: "approved" | "hidden"): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE products SET brand_decision = ?, approved = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND account_id = ? AND selected = 1",
  )
    .bind(decision, decision === "approved" ? 1 : 0, productId, accountId)
    .run();
  return r.meta.changes === 1;
}

/** Brand taps "Done" in the approval gallery. */
export async function confirmApproval(env: Env, accountId: string): Promise<boolean> {
  const approved = await env.DB.prepare("SELECT COUNT(*) AS c FROM products WHERE account_id = ? AND approved = 1 AND enabled = 1").bind(accountId).first<{ c: number }>();
  if ((approved?.c ?? 0) === 0) return false;
  await env.DB.prepare("UPDATE accounts SET approved_at = COALESCE(approved_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?").bind(accountId).run();
  return true;
}
