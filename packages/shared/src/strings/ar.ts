import type { TRY_ON_KEYS } from "./en.js";

type TryOnKey = (typeof TRY_ON_KEYS)[number];

/**
 * Arabic strings for the try-on flow.
 *
 * Source: Pitch Kit section 05, "Widget wording" (docs/brand/Garrab_Pitch-Kit.docx), copied
 * exactly for the 11 keys it covers. The 5 keys the Pitch Kit does not cover (uploadRoom, close,
 * notNow, unavailable, buy) are written in the same Modern Standard Arabic register and are
 * listed in DECISIONS.md for the native-speaker review the Pitch Kit asks for before launch.
 *
 * The size finder is English only, so it has no Arabic strings.
 */
export const AR_IS_DRAFT = false;

export const ar: Record<TryOnKey, string> = {
  // Pitch Kit §05
  buttonTryOn: "جرّبه على نفسك",
  buttonRoom: "شاهده في غرفتك",
  upload: "ارفع صورة واضحة لك",
  consent: "برفع الصورة توافق على استخدامها فقط لإنشاء المعاينة.",
  privacy: "نستخدم صورتك فقط لإنشاء هذه المعاينة. لا نحتفظ بها، ويتم حذفها عند إغلاق الصفحة.",
  aiPreview: "معاينة بالذكاء الاصطناعي",
  disclaimer:
    "هذه معاينة توضيحية بالذكاء الاصطناعي لمساعدتك على تخيّل الشكل. قد تختلف الألوان والمقاس والتفاصيل قليلًا عن المنتج الحقيقي.",
  progress: "جارٍ إنشاء المعاينة…",
  download: "تحميل المعاينة",
  closed: "تم حذف صورتك.",
  error: "تعذّر إنشاء معاينة من هذه الصورة. جرّب صورة أوضح.",
  // Not in the Pitch Kit: same register, for native review
  uploadRoom: "ارفع صورة لغرفتك",
  close: "إغلاق",
  notNow: "ليس الآن",
  unavailable: "غير متاح مؤقتًا",
  buy: "اشترِ الآن",
};
