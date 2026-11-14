/**
 * Ready-to-copy captions for hosted try-on links (brief §4, "Hosted link").
 * Arabic is DRAFT until the Pitch Kit wording arrives (same rule as ar.ts).
 */
export const captions = {
  en: (title: string, link: string): string => `See it on you before you buy ✨ Try "${title}" on yourself with our AI preview: ${link}`,
  ar: (title: string, link: string): string => `شوفيه عليكِ قبل ما تشتري ✨ جرّبي "${title}" بالمعاينة بالذكاء الاصطناعي: ${link}`,
  whatsappEn: (title: string, link: string): string => `Want to see "${title}" on you first? Upload a photo here and get a quick AI preview: ${link}`,
  whatsappAr: (title: string, link: string): string => `عايزة تشوفي "${title}" عليكِ الأول؟ ارفعي صورة هنا وهتشوفي معاينة سريعة: ${link}`,
};
