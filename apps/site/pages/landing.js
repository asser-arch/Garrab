/**
 * Garrab landing page: motion for the hero only (Hello Monday–style). The rest of the page is static.
 *  - the big word changes every few seconds, letter by letter (whole word in Arabic, so letters stay joined);
 *    the item it names fills with colour in the drawing
 *  - the drawing's lines "boil" (hand-drawn wobble) a few times a second
 *  - a forest shape drifts and morphs on the edge of the hero
 * No libraries. Adds html.motion; without it (script blocked, "reduce motion") the hero is plain and complete.
 * Everything pauses while the hero is off screen or the tab is hidden, and the word stops after a few rounds.
 */
(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const d = document.documentElement;
  const hero = document.querySelector(".hero");
  const word = hero && hero.querySelector(".word");
  const art = hero && hero.querySelector(".hero-art");
  if (!hero || !word || !art) return;
  d.classList.add("motion");

  const ar = d.lang === "ar";
  const words = word.dataset.words.split("|");
  const items = word.dataset.items.split("|");
  let i = 0;
  let onScreen = true;
  art.dataset.item = items[0];

  const letters = (text, cls) =>
    (ar ? [text] : Array.from(text)).map((c, k) => {
      const s = document.createElement("span");
      s.className = cls ? `ch ${cls}` : "ch";
      s.style.setProperty("--i", String(k));
      s.textContent = c;
      return s;
    });
  word.replaceChildren(...letters(words[0]));

  // Word swap: old letters drop out, new ones arrive from above. Stops after 3 rounds, back on the first word.
  const ROUNDS = 3;
  let swaps = 0;
  const timer = setInterval(() => {
    if (!onScreen || document.hidden) return;
    const old = Array.from(word.children);
    old.forEach((c) => c.classList.add("down"));
    setTimeout(() => {
      i = (i + 1) % words.length;
      const next = letters(words[i], "up");
      word.replaceChildren(...next);
      art.dataset.item = items[i];
      void word.offsetWidth; // apply the "up" position before animating in
      next.forEach((c) => c.classList.remove("up"));
    }, 380 + old.length * 28);
    if (++swaps >= words.length * ROUNDS) clearInterval(timer);
  }, 2600);

  // Hand-drawn wobble: a new noise seed ~8 times a second.
  const turb = art.querySelector("feTurbulence");
  let seed = 1;
  let lastBoil = 0;

  // Edge shape: a tall blob hugging the side of the hero, its inner edge rippling slowly.
  const edge = hero.querySelector(".edge path");
  const edgePath = (t) => {
    const n = 7;
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const bulge = Math.sin((k / n) * Math.PI); // fattest in the middle
      const reach = (90 + 200 * bulge + 34 * Math.sin(t * 0.0007 + k * 1.3) + 18 * Math.sin(t * 0.0013 + k * 2.1)) * (0.3 + 0.7 * bulge);
      pts.push([400 - reach, (k / n) * 800]);
    }
    let p = `M400 0 L${pts[0][0].toFixed(1)} 0`;
    for (let k = 0; k < n; k++) {
      const p0 = pts[Math.max(k - 1, 0)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(k + 2, n)];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      p += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return `${p} L400 800 Z`;
  };

  let running = false;
  const frame = (t) => {
    if (!onScreen) return void (running = false);
    if (edge) edge.setAttribute("d", edgePath(t));
    if (turb && t - lastBoil > 125) {
      lastBoil = t;
      seed = (seed % 6) + 1;
      turb.setAttribute("seed", String(seed));
    }
    requestAnimationFrame(frame);
  };
  const start = () => {
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
  };
  if (edge) edge.setAttribute("d", edgePath(0));
  new IntersectionObserver((e) => {
    onScreen = e[0].isIntersecting;
    if (onScreen) start();
  }).observe(hero);
  start();
})();
