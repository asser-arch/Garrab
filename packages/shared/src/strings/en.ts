/** Exact English UI strings from the brief (§4, §5). Do not paraphrase. */
export const en = {
  buttonTryOn: "Try it on",
  buttonRoom: "See it in your room",
  buttonSize: "Find my size",
  upload: "Upload a clear photo of yourself",
  uploadRoom: "Upload a photo of your room",
  consent: "By uploading a photo you agree we use it only to create your preview.",
  /** Before upload: sets expectations calmly. The after-result disclaimer is the Pitch Kit line below. */
  expectation: "Your preview is created by AI to help you picture the look. It's a close guide rather than an exact photo, so small differences from the real product are normal.",
  /** Gated: shown only when settings.privacy_claim_verified is true. */
  privacy:
    "Your photo is used only to create this preview. We don't save it. It's deleted when you close this page.",
  aiPreview: "AI preview",
  disclaimer:
    "This is an AI preview to help you imagine the look. Colours, size and small details may differ slightly from the real product.",
  progress: "Creating your preview…",
  download: "Download preview",
  closed: "Your photo has been deleted.",
  error: "We couldn't create a preview from this photo. Try a clearer one.",
  close: "Close",
  notNow: "Not now",
  unavailable: "Temporarily unavailable",
  buy: "Buy",
  // Size finder (English only)
  sizeConsent: "We use these details only to suggest a size. We don't save them.",
  sizeLabel: "Estimated size",
  sizeNote: "Based on the product photos and description. Check the size notes on this page.",
} as const;

export type StringKey = keyof typeof en;
export type Strings = Record<StringKey, string>;

/** Keys used in the try-on flow, which must exist in every language. */
export const TRY_ON_KEYS = [
  "buttonTryOn",
  "buttonRoom",
  "upload",
  "uploadRoom",
  "consent",
  "expectation",
  "privacy",
  "aiPreview",
  "disclaimer",
  "progress",
  "download",
  "closed",
  "error",
  "close",
  "notNow",
  "unavailable",
  "buy",
] as const satisfies readonly StringKey[];
