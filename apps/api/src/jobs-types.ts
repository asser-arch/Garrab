/** Messages on the JOBS queue. Every job is idempotent and safe to run twice. */
export type Job =
  | { t: "import"; a: string }
  | { t: "test"; a: string; p: string }
  | { t: "advance"; a: string };
