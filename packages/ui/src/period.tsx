/** Period filter for results (portal Results, admin Usage). */
// ---------------------------------------------------------------- period filter (Cairo days)

export type Preset = "7d" | "30d" | "month" | "lastMonth" | "pilot" | "custom";
export const cairoToday = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
export const plusDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The from/to (inclusive) of a preset; null = the server's default (pilot so far, or last 30 days). */
export function presetRange(p: Preset, pilotStart: string | null): { from: string; to: string } | null {
  const today = cairoToday();
  if (p === "7d") return { from: plusDays(today, -6), to: today };
  if (p === "30d") return { from: plusDays(today, -29), to: today };
  if (p === "month") return { from: `${today.slice(0, 8)}01`, to: today };
  if (p === "lastMonth") {
    const firstThis = `${today.slice(0, 8)}01`;
    const lastPrev = plusDays(firstThis, -1);
    return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev };
  }
  if (p === "pilot" && pilotStart) return { from: new Date(pilotStart).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" }), to: today };
  return null;
}

export function PeriodFilter({
  preset,
  setPreset,
  custom,
  setCustom,
  pilot,
}: {
  preset: Preset;
  setPreset: (p: Preset) => void;
  custom: { from: string; to: string };
  setCustom: (c: { from: string; to: string }) => void;
  pilot: boolean;
}) {
  const options: [Preset, string][] = [
    ["7d", "Last 7 days"],
    ["30d", "Last 30 days"],
    ["month", "This month"],
    ["lastMonth", "Last month"],
    ...(pilot ? ([["pilot", "Whole pilot"]] as [Preset, string][]) : []),
    ["custom", "Custom dates"],
  ];
  return (
    <div className="period no-print">
      <label htmlFor="period" className="sr-only">
        Period
      </label>
      <select id="period" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {preset === "custom" && (
        <span className="period-custom">
          <label htmlFor="p-from" className="sr-only">
            From
          </label>
          <input id="p-from" type="date" max={custom.to || cairoToday()} value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
          <span aria-hidden="true">–</span>
          <label htmlFor="p-to" className="sr-only">
            To
          </label>
          <input id="p-to" type="date" min={custom.from} max={cairoToday()} value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
        </span>
      )}
    </div>
  );
}

