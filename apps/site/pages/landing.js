/*
 * Garrab landing page motion (Hello Monday–style), no libraries.
 *  - loader, split headlines, scroll reveals, colour fields that follow the scroll
 *  - morphing shapes (procedural blobs), custom cursor, magnetic buttons, tilting cards
 *  - marquee driven by scroll speed and direction, pinned sideways "How it works", counting prices
 * Adds html.motion only when it runs, so a blocked script or "reduce motion" leaves the plain page.
 */
(() => {
  const d = document.documentElement;
  if (d.classList.contains("reduced") || !("IntersectionObserver" in window)) {
    d.classList.remove("loading");
    return;
  }
  d.classList.add("motion");
  const ar = d.lang === "ar";
  const rtl = d.dir === "rtl";
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ------------------------------------------------------------------ split headlines into words
  // Words only (never letters): Arabic letters must stay joined.
  for (const el of $$("[data-split]")) {
    let i = 0;
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) frag.append(part);
            else {
              const w = document.createElement("span");
              w.className = "w";
              const wi = document.createElement("span");
              wi.className = "wi";
              wi.style.setProperty("--i", String(i++));
              wi.textContent = part;
              w.append(wi);
              frag.append(w);
            }
          }
          child.replaceWith(frag);
        } else if (child.nodeType === 1) walk(child);
      }
    };
    walk(el);
  }

  // ------------------------------------------------------------------ reveals (staggered within a group)
  for (const el of $$("[data-reveal]")) {
    const sibs = Array.from(el.parentElement.children).filter((x) => x.hasAttribute("data-reveal"));
    el.style.setProperty("--i", String(Math.max(0, sibs.indexOf(el))));
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        if (e.target.dataset.count !== undefined) countUp(e.target);
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.1 },
  );
  const hero = document.querySelector(".hero");
  const observeAll = (inHero) => {
    for (const el of $$("[data-split], [data-reveal], [data-count]")) if (hero.contains(el) === inHero) io.observe(el);
  };
  observeAll(false);

  // ------------------------------------------------------------------ loader, then the hero plays
  const loader = document.querySelector(".loader");
  const t0 = performance.now();
  const ready = Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise((r) => setTimeout(r, 1400))]);
  ready.then(() => {
    setTimeout(() => {
      if (loader) loader.classList.add("leaving");
      d.classList.remove("loading");
      setTimeout(() => observeAll(true), 250);
      setTimeout(() => loader && loader.classList.remove("leaving"), 1000);
    }, Math.max(0, 950 - (performance.now() - t0)));
  });

  // ------------------------------------------------------------------ counting prices
  function countUp(el) {
    const end = Number(el.dataset.count);
    if (!end) return;
    const fmt = (n) => Math.round(n).toLocaleString(ar ? "ar-EG" : "en-US");
    const start = performance.now();
    const step = (now) => {
      const p = clamp((now - start) / 1300, 0, 1);
      el.textContent = fmt(end * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------ colour fields follow the scroll
  const fields = $$("[data-bg]");
  let field = "";
  const setField = () => {
    const mid = innerHeight * 0.45;
    for (const s of fields) {
      const r = s.getBoundingClientRect();
      if (r.top <= mid && r.bottom > mid) {
        if (s.dataset.bg !== field) document.body.dataset.field = field = s.dataset.bg;
        return;
      }
    }
  };

  // ------------------------------------------------------------------ morphing shapes
  // Each blob: 8 points around a centre whose radius breathes on its own rhythm; drawn as a smooth closed curve.
  const blobSets = $$("svg.blobs").map((svg) => ({
    svg,
    visible: true,
    blobs: [
      { el: svg.querySelector(".b1"), cx: 960, cy: 180, r: 300, depth: 30, speed: 0.35, seed: 1 },
      { el: svg.querySelector(".b2"), cx: 180, cy: 640, r: 240, depth: 50, speed: 0.45, seed: 2.3 },
      { el: svg.querySelector(".b3"), cx: 1080, cy: 640, r: 90, depth: 90, speed: 0.7, seed: 4.1 },
    ],
  }));
  for (const set of blobSets) {
    new IntersectionObserver(([e]) => (set.visible = e.isIntersecting)).observe(set.svg);
  }
  const blobPath = (b, t, mx, my) => {
    const n = 8;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const wob = 1 + 0.14 * Math.sin(t * b.speed + k * 1.7 + b.seed) + 0.07 * Math.sin(t * b.speed * 2.1 + k * 2.9 + b.seed * 2);
      pts.push([b.cx + mx * b.depth + Math.cos(a) * b.r * wob, b.cy + my * b.depth + Math.sin(a) * b.r * wob]);
    }
    // Closed Catmull–Rom spline as cubic Béziers.
    let dpath = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let k = 0; k < n; k++) {
      const p0 = pts[(k - 1 + n) % n], p1 = pts[k], p2 = pts[(k + 1) % n], p3 = pts[(k + 2) % n];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      dpath += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return `${dpath}Z`;
  };

  // ------------------------------------------------------------------ pointer: cursor, magnetic buttons, tilt
  const pointer = { x: innerWidth / 2, y: innerHeight / 2, nx: 0, ny: 0 };
  const cur = { x: pointer.x, y: pointer.y };
  const cursor = document.querySelector(".cursor");
  const label = cursor && cursor.querySelector(".cursor-label");
  addEventListener(
    "pointermove",
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.nx = e.clientX / innerWidth - 0.5;
      pointer.ny = e.clientY / innerHeight - 0.5;
    },
    { passive: true },
  );
  if (fine && cursor) {
    const words = ar ? { start: "ابدأ", chat: "كلّمنا", open: "افتح" } : { start: "Start", chat: "Chat", open: "Open" };
    document.addEventListener("pointerover", (e) => {
      const a = e.target.closest("a, button, summary");
      if (!a) return cursor.classList.remove("big");
      const href = a.getAttribute("href") || "";
      label.textContent = /\/start/.test(href) ? words.start : /wa\.me/.test(href) ? words.chat : a.matches(".btn") ? words.open : "";
      cursor.classList.toggle("big", label.textContent !== "");
    });
    document.addEventListener("pointerleave", () => cursor.classList.add("hide"));
    document.addEventListener("pointerenter", () => cursor.classList.remove("hide"));

    for (const b of $$(".btn")) {
      b.addEventListener("pointermove", (e) => {
        const r = b.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        b.style.transform = `translate(${dx * 0.22}px, ${dy * 0.35}px)`;
      });
      b.addEventListener("pointerleave", () => (b.style.transform = ""));
    }
    for (const c of $$("[data-tilt]")) {
      c.addEventListener("pointermove", (e) => {
        if (!c.classList.contains("in")) return;
        const r = c.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        c.style.transform = `perspective(900px) rotateX(${(-py * 5).toFixed(2)}deg) rotateY(${(px * 6).toFixed(2)}deg)`;
      });
      c.addEventListener("pointerleave", () => (c.style.transform = ""));
    }
  }

  // ------------------------------------------------------------------ pinned sideways "How it works"
  const pin = document.querySelector("[data-pin]");
  const track = pin && pin.querySelector("[data-track]");
  let pinDistance = 0;
  const setupPin = () => {
    if (!pin || !track) return;
    const wide = innerWidth > 900;
    pin.classList.toggle("pinned", wide);
    if (!wide) {
      pin.style.height = "";
      track.style.transform = "";
      pinDistance = 0;
      return;
    }
    const wrap = pin.firstElementChild;
    const pad = parseFloat(getComputedStyle(wrap).paddingInlineStart) || 20;
    pinDistance = Math.max(0, track.scrollWidth - (innerWidth - pad * 2));
    pin.style.height = `${innerHeight + pinDistance}px`;
  };
  setupPin();
  addEventListener("resize", () => {
    setupPin();
    setField();
  });

  // ------------------------------------------------------------------ marquee
  const mTrack = document.querySelector(".marquee-track");
  const mGroup = mTrack && mTrack.querySelector(".marquee-group");
  let mx = 0;
  let dir = rtl ? 1 : -1;

  // ------------------------------------------------------------------ one frame loop for everything
  const line = document.querySelector(".scroll-line");
  const heroVisual = document.querySelector("[data-parallax]");
  let lastY = scrollY;
  let vel = 0;
  const loop = (now) => {
    const y = scrollY;
    const dy = y - lastY;
    lastY = y;
    vel = lerp(vel, dy, 0.1);
    if (Math.abs(dy) > 0.5) dir = (dy > 0 ? -1 : 1) * (rtl ? -1 : 1);

    const max = document.documentElement.scrollHeight - innerHeight;
    if (line) line.style.transform = `scaleX(${max > 0 ? (y / max).toFixed(4) : 0})`;

    if (mTrack && mGroup) {
      const w = mGroup.offsetWidth;
      mx += dir * (0.6 + Math.min(Math.abs(vel) * 0.35, 14));
      // The copies sit after the first group: to the right in English, to the left in Arabic.
      if (rtl) {
        if (mx >= w) mx -= w;
        if (mx < 0) mx += w;
      } else {
        if (mx <= -w) mx += w;
        if (mx > 0) mx -= w;
      }
      mTrack.style.transform = `translate3d(${mx.toFixed(1)}px,0,0)`;
    }

    if (pin && track && pinDistance) {
      const top = pin.getBoundingClientRect().top;
      const p = clamp(-top / pinDistance, 0, 1);
      track.style.transform = `translate3d(${(rtl ? 1 : -1) * p * pinDistance}px,0,0)`;
    }

    cur.x = lerp(cur.x, pointer.x, 0.18);
    cur.y = lerp(cur.y, pointer.y, 0.18);
    if (cursor) cursor.style.transform = `translate3d(${cur.x}px,${cur.y}px,0)`;

    if (heroVisual && y < innerHeight * 1.2) {
      heroVisual.style.transform = `translate3d(${(pointer.nx * 18).toFixed(1)}px,${(pointer.ny * 14 + y * 0.12).toFixed(1)}px,0) rotate(${(pointer.nx * 2).toFixed(2)}deg)`;
    }

    const t = now / 1000;
    for (const set of blobSets) {
      if (!set.visible) continue;
      for (const b of set.blobs) if (b.el) b.el.setAttribute("d", blobPath(b, t, pointer.nx, pointer.ny));
    }

    setField();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();
