import type { TRY_ON_KEYS } from "./en.js";

type TryOnKey = (typeof TRY_ON_KEYS)[number];

/**
 * DRAFT Arabic strings for the try-on flow.
 *
 * The brief requires the wording from the table in section 05 of
 * docs/Garrab_Pitch-Kit.docx, which has not been provided yet. These drafts
 * exist so the RTL layout can be built and tested. `AR_IS_DRAFT` must be set to
 * false when the Pitch Kit wording replaces them; a test blocks production
 * builds while it is true.
 *
 * The size finder is English only, so it has no Arabic strings.
 */
export const AR_IS_DRAFT = true;

export const ar: Record<TryOnKey, string> = {
  buttonTryOn: "جرّبيه عليكِ",
  buttonRoom: "شوفيه في أوضتك",
  upload: "ارفعي صورة واضحة ليكِ",
  uploadRoom: "ارفعي صورة للأوضة",
  consent: "برفع الصورة إنتِ موافقة إننا نستخدمها بس علشان نعمل المعاينة.",
  privacy: "صورتك بتُستخدم بس علشان نعمل المعاينة دي. مش بنحفظها، وبتتمسح لما تقفلي الصفحة.",
  aiPreview: "معاينة بالذكاء الاصطناعي",
  disclaimer:
    "دي معاينة بالذكاء الاصطناعي تساعدك تتخيلي الشكل. الألوان والمقاس والتفاصيل الصغيرة ممكن تختلف شوية عن المنتج الحقيقي.",
  progress: "بنجهّز المعاينة…",
  download: "حمّلي المعاينة",
  closed: "صورتك اتمسحت.",
  error: "ماقدرناش نعمل معاينة من الصورة دي. جرّبي صورة أوضح.",
  close: "إغلاق",
  notNow: "مش دلوقتي",
  unavailable: "غير متاح مؤقتًا",
  buy: "اشتري",
};
