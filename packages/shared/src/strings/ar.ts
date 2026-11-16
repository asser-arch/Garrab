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
  // Pitch Kit §05 (privacy: the Pitch Kit's own variant for a provider that keeps images for a period)
  buttonTryOn: "جرّبه على نفسك",
  buttonRoom: "شاهده في غرفتك",
  upload: "ارفع صورة واضحة لك",
  consent: "برفع الصورة توافق على استخدامها فقط لإنشاء المعاينة.",
  privacy: "نستخدم صورتك فقط لإنشاء هذه المعاينة. لا نحتفظ بها على أنظمتنا.",
  aiPreview: "معاينة بالذكاء الاصطناعي",
  disclaimer:
    "هذه معاينة توضيحية بالذكاء الاصطناعي لمساعدتك على تخيّل الشكل. قد تختلف الألوان والمقاس والتفاصيل قليلًا عن المنتج الحقيقي.",
  progress: "جارٍ إنشاء المعاينة…",
  download: "تحميل المعاينة",
  closed: "تم حذف صورتك.",
  error: "تعذّر إنشاء معاينة من هذه الصورة. جرّب صورة أوضح.",
  errorRetry: "تعذّر إنشاء المعاينة الآن. حاول مرة أخرى بعد قليل.",
  // Not in the Pitch Kit: same register, for native review
  expectation: "تُنشأ المعاينة بالذكاء الاصطناعي لمساعدتك على تخيّل الشكل. هي دليل قريب وليست صورة مطابقة تمامًا، لذا من الطبيعي وجود اختلافات بسيطة عن المنتج الحقيقي.",
  uploadRoom: "ارفع صورة لغرفتك",
  close: "إغلاق",
  notNow: "ليس الآن",
  unavailable: "غير متاح مؤقتًا",
  buy: "اشترِ الآن",
  pickProduct: "اختر قطعة لتجربتها",
  pickRoomProduct: "اختر قطعة لتراها في غرفتك",
  allProducts: "شاهد كل المنتجات",
  // Size finder (Growth plan). Same register as the rest, for native review.
  buttonSize: "اعرف مقاسك",
  sizeIntro: "أجب عن بعض الأسئلة السريعة وسنقترح عليك مقاسًا لهذه القطعة.",
  sizeHeight: "الطول (سم)",
  sizeWeight: "الوزن (كجم، اختياري)",
  sizeUsual: "مقاسك المعتاد",
  sizeBody: "شكل الجسم",
  bodySlim: "نحيف",
  bodyAverage: "متوسط",
  bodyAthletic: "رياضي",
  bodyCurvy: "قوام منحني",
  bodyBroad: "عريض",
  bodySkip: "أفضّل عدم الإجابة",
  sizePrefer: "كيف تفضّل القصّة؟",
  preferFitted: "محددة",
  preferRegular: "عادية",
  preferLoose: "واسعة",
  sizeSubmit: "اقترح مقاسي",
  sizeConsent: "نستخدم هذه البيانات فقط لاقتراح المقاس. لا نحتفظ بها.",
  sizeLabel: "المقاس التقديري",
  sizeAlt: "قد يناسبك أيضًا:",
  sizeNote: "بناءً على صور المنتج ووصفه. راجع ملاحظات المقاس في هذه الصفحة.",
  sizeLow: "نحن أقل تأكدًا هنا، لذا راجع ملاحظات المقاس أيضًا.",
  sizeBack: "رجوع",
  sizeError: "تعذّر اقتراح مقاس الآن. حاول مرة أخرى.",
};
