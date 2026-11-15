/**
 * Product photo addresses and product test clean-up, in one place.
 * Uploaded photos: R2 `products/<account>/<file>`, served at `<APP_ORIGIN>/pi/<account>/<file>`.
 * Test results: R2 `tests/<account>/<product>/<test>.<ext>`.
 */
import type { Env } from "../env.js";

export const PHOTO_FILE_RE = /^[a-z0-9]{26}\.(?:jpg|png|webp)$/;
const PI_URL_RE = /\/pi\/([A-Z0-9]{26})\/([a-z0-9]{26}\.(?:jpg|png|webp))$/;

export function productPhotoUrl(env: Env, accountId: string, file: string): string {
  return `${env.APP_ORIGIN}/pi/${accountId}/${file}`;
}

/** The R2 key of a photo this account uploaded, or null for any other URL (shop images, other accounts). */
export function productPhotoKey(url: string, accountId: string): string | null {
  const m = PI_URL_RE.exec(url);
  return m && m[1] === accountId ? `products/${accountId}/${m[2]}` : null;
}

async function deletePrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const l = await env.FILES.list(cursor ? { prefix, cursor } : { prefix });
    if (l.objects.length) await env.FILES.delete(l.objects.map((o) => o.key));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
}

/**
 * Remove a product's test results. Rows go first, then the images: a failure leaves at worst an
 * orphaned image, never a row pointing at a deleted one. The whole tests/<account>/<product>/ prefix
 * is swept, so an image written by a test that was still running is removed too.
 */
export async function clearProductTests(env: Env, accountId: string, productId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM product_tests WHERE product_id = ?").bind(productId).run();
  await deletePrefix(env, `tests/${accountId}/${productId}/`);
}

/** Delete uploaded photos that no remaining product of the account still uses. */
export async function deleteUnusedPhotos(env: Env, accountId: string, urls: string[]): Promise<void> {
  const doomed: string[] = [];
  for (const u of urls) {
    const key = productPhotoKey(u, accountId);
    if (!key) continue;
    const file = key.slice(key.lastIndexOf("/") + 1);
    const still = await env.DB.prepare("SELECT 1 FROM products WHERE account_id = ? AND images_json LIKE ? LIMIT 1").bind(accountId, `%${file}%`).first();
    if (!still) doomed.push(key);
  }
  if (doomed.length) await env.FILES.delete(doomed);
}

export { deletePrefix };
