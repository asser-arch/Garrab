import { ar, AR_IS_DRAFT } from "./ar.js";
import { en, TRY_ON_KEYS } from "./en.js";

export { ar, AR_IS_DRAFT, en, TRY_ON_KEYS };
export type { StringKey, Strings } from "./en.js";

export type Lang = "en" | "ar";

/** Pick the try-on language from the host page's `lang` attribute. */
export function langFromPage(htmlLang: string | null | undefined): Lang {
  return (htmlLang ?? "").trim().toLowerCase().startsWith("ar") ? "ar" : "en";
}

export function dir(lang: Lang): "rtl" | "ltr" {
  return lang === "ar" ? "rtl" : "ltr";
}

/** Try-on flow strings for a language. The size finder always uses `en`. */
export function tryOnStrings(lang: Lang): Record<(typeof TRY_ON_KEYS)[number], string> {
  if (lang === "ar") return ar;
  const out = {} as Record<(typeof TRY_ON_KEYS)[number], string>;
  for (const k of TRY_ON_KEYS) out[k] = en[k];
  return out;
}

/** Throws if a production build would ship draft translations. */
export function assertStringsReadyForProduction(): void {
  if (AR_IS_DRAFT) {
    throw new Error(
      "Arabic strings are DRAFT. Replace them with the Pitch Kit wording (section 05) and set AR_IS_DRAFT = false.",
    );
  }
}
