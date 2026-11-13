/**
 * Design tokens from docs/Garrab_Brand-Guidelines (v1.0, November 2026).
 * The widget, frame, portal, admin and site all read from this file.
 * Change order: guideline first, then this file, then the product.
 */

export const colors = {
  forest: "#143822",
  cream: "#F4F2EB",
  paper: "#FCFBF8",
  ink: "#0F1A13",
  peach: "#F3D6A8",
  mint: "#BFE8E0",
  lavender: "#D2C6F7",
  sage: "#9DB5A3",
  sand: "#DDD6C9",
  mist: "#E9E9E3",
  grey: "#8A8B84",
  orange: "#C9791A",
  teal: "#1F8A7C",
  purple: "#6B4BD6",
} as const;

export const radius = { card: "20px", pill: "999px" } as const;
export const font = "Cairo, system-ui, sans-serif" as const;
/** 8-point spacing grid. */
export const space = [8, 16, 24, 32, 48] as const;
/** Motion: fade only, 150 to 250 ms. */
export const motionMs = { min: 150, max: 250 } as const;
export const minTapTargetPx = 44;
/** Line icons. */
export const icon = { strokeWidth: 1.7, linecap: "round" } as const;

export type ColorName = keyof typeof colors;

const kebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

/** CSS custom properties, exactly as in the brand guideline. */
export function cssVariables(selector = ":root"): string {
  const lines = [
    ...Object.entries(colors).map(([k, v]) => `  --${kebab(k)}:${v};`),
    `  --radius-card:${radius.card};`,
    `  --radius-pill:${radius.pill};`,
    `  --font:${font};`,
  ];
  return `${selector} {\n${lines.join("\n")}\n}`;
}
