/**
 * Phones: wide tables (5+ columns, with a header row) become a stack of small cards, one per row, each
 * value labelled with its column name (CSS in ui.css, table.stack). Keeps every table readable at 390 px
 * without changing the table markup. Runs once at start-up and again whenever the page changes.
 */
export function stackTables(): void {
  const run = (): void => {
    document.querySelectorAll("table").forEach((t) => {
      if (t.classList.contains("data")) return; // the Results tables have their own phone layout
      const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "");
      if (heads.length < 5) return;
      t.classList.add("stack");
      t.querySelectorAll("tbody tr").forEach((tr) =>
        [...tr.children].forEach((td, i) => {
          const label = heads[i] ?? "";
          if (td.getAttribute("data-label") !== label) td.setAttribute("data-label", label);
        }),
      );
    });
  };
  run();
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
}
