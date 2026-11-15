/**
 * Ready-to-copy captions for hosted try-on links (brief §4, "Hosted link").
 * Arabic follows the Pitch Kit §05 register (Modern Standard Arabic, not gendered); not in the
 * Pitch Kit itself, so it is on the native-speaker review list in DECISIONS.md.
 */
export const captions = {
  en: (title: string, link: string): string => `See it on you before you buy ✨ Try "${title}" on yourself with our AI preview: ${link}`,
  ar: (title: string, link: string): string => `شاهده عليك قبل الشراء ✨ جرّب "${title}" على نفسك مع المعاينة بالذكاء الاصطناعي: ${link}`,
  whatsappEn: (title: string, link: string): string => `Want to see "${title}" on you first? Upload a photo here and get a quick AI preview: ${link}`,
  whatsappAr: (title: string, link: string): string => `تريد أن ترى "${title}" عليك أولًا؟ ارفع صورة هنا واحصل على معاينة سريعة: ${link}`,
};
