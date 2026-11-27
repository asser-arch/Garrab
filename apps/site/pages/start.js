// /start lead form. Posts to the same origin; the site Worker forwards to the API.
(function () {
  var cfg = window.__GARRAB__;
  var form = document.getElementById("start");
  var msg = document.getElementById("msg");
  var tsToken = cfg.turnstileSiteKey === "mock" ? "mock" : null;
  // Came from a brand's try-on page (?ref=brand-slug): remember it for the lead and the call-back.
  var ref = (new URLSearchParams(location.search).get("ref") || "").toLowerCase();
  if (!/^[a-z0-9-]{1,60}$/.test(ref)) ref = "";
  if (ref) document.getElementById("ref").value = ref;
  function renderTs() {
    if (cfg.turnstileSiteKey === "mock" || !window.turnstile) return;
    window.turnstile.render("#ts", { sitekey: cfg.turnstileSiteKey, callback: function (t) { tsToken = t; } });
  }
  if (document.readyState === "complete") renderTs(); else window.addEventListener("load", renderTs);

  // "Leave your number and we'll call you."
  var cb = document.getElementById("callback");
  var cbMsg = document.getElementById("cb-msg");
  cb.addEventListener("submit", function (e) {
    e.preventDefault();
    cbMsg.textContent = "";
    var d = Object.fromEntries(new FormData(cb).entries());
    if (!d.brand) delete d.brand;
    if (ref) d.ref = ref;
    if (!tsToken) { cbMsg.textContent = "Please complete the check in the form above first."; return; }
    d.turnstileToken = tsToken;
    fetch("/api/contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d) })
      .then(function (r) {
        // The bot-check token works once: get a fresh one for the sign-up form.
        if (cfg.turnstileSiteKey !== "mock") { tsToken = null; try { window.turnstile.reset("#ts"); } catch (x) { /* fine */ } }
        if (r.ok) { cb.hidden = true; cbMsg.textContent = ""; var t = document.createElement("p"); t.className = "note"; t.setAttribute("role", "status"); t.textContent = "Thanks. We'll call you on WhatsApp soon."; cb.after(t); return; }
        return r.json().then(function (j) { cbMsg.textContent = j.fields ? "Please check your name and WhatsApp number (01xxxxxxxxx)." : "Something went wrong. Please try again."; });
      })
      .catch(function () { cbMsg.textContent = "Something went wrong. Please try again."; });
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    msg.textContent = "";
    var data = Object.fromEntries(new FormData(form).entries());
    Object.keys(data).forEach(function (k) { if (data[k] === "") delete data[k]; });
    if (data.instagram && data.instagram[0] !== "@") data.instagram = "@" + data.instagram;
    if (!tsToken) { msg.textContent = "Please complete the check above."; return; }
    data.turnstileToken = tsToken;
    if (!data.heardFrom) { msg.textContent = "Please tell us how you heard about Garrab."; return; }
    // Where they came from (no personal data): campaign tags, the site that sent them, a Meta ad click.
    // garrabb.com passes its own visitor's source along in the link (see pixel.js).
    var q = new URLSearchParams(location.search);
    var tr = {};
    ["utm_source", "utm_medium", "utm_campaign"].forEach(function (k) { var v = q.get(k); if (v) tr[k.replace(/_(\w)/, function (_, c) { return c.toUpperCase(); })] = v.slice(0, 80); });
    var refSite = q.get("from") || "";
    if (!refSite && document.referrer) { try { var h = new URL(document.referrer).hostname; if (h !== location.hostname) refSite = h; } catch (x) { /* none */ } }
    if (refSite && refSite !== "garrabb.com" && refSite !== "www.garrabb.com") tr.referrer = refSite.slice(0, 120);
    if (q.get("fbclid") || q.get("meta") === "1") tr.metaAd = true;
    if (q.get("landing") === "1" || /(^|\.)garrabb\.com$/.test(refSite) || (document.referrer && /\/\/(www\.)?garrabb\.com/.test(document.referrer))) tr.viaLanding = true;
    if (Object.keys(tr).length) data.tracking = tr;
    // One ID for this sign-up, shared by the browser and server halves of the Meta "Lead" (counted once).
    var eventId = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
    data.eventId = eventId;
    document.cookie.split("; ").forEach(function (c) {
      var kv = c.split("=");
      if (kv[0] === "_fbp") data.fbp = kv.slice(1).join("=");
      if (kv[0] === "_fbc") data.fbc = kv.slice(1).join("=");
    });
    fetch("/api/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok) { form.hidden = true; var d = document.getElementById("done"); d.hidden = false; d.focus(); try { window.garrabLead(eventId); } catch (x) { /* tracking never breaks sign-up */ } return; }
        var names = { heardFrom: "how you heard about us", brandName: "brand name", contactName: "your name", email: "email", whatsapp: "WhatsApp number", website: "website", instagram: "Instagram handle" };
        msg.textContent = res.j.fields ? "Please check: " + res.j.fields.map(function (f) { return names[f.path] || f.path; }).join(", ") + "." : "Something went wrong. Please try again.";
      })
      .catch(function () { msg.textContent = "Something went wrong. Please try again."; });
  });
})();
