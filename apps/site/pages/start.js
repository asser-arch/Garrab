// /start lead form. Posts to the same origin; the site Worker forwards to the API.
(function () {
  var cfg = window.__GARRAB__;
  var form = document.getElementById("start");
  var msg = document.getElementById("msg");
  var tsToken = cfg.turnstileSiteKey === "mock" ? "mock" : null;
  function renderTs() {
    if (cfg.turnstileSiteKey === "mock" || !window.turnstile) return;
    window.turnstile.render("#ts", { sitekey: cfg.turnstileSiteKey, callback: function (t) { tsToken = t; } });
  }
  if (document.readyState === "complete") renderTs(); else window.addEventListener("load", renderTs);
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    msg.textContent = "";
    var data = Object.fromEntries(new FormData(form).entries());
    Object.keys(data).forEach(function (k) { if (data[k] === "") delete data[k]; });
    if (data.instagram && data.instagram[0] !== "@") data.instagram = "@" + data.instagram;
    if (!tsToken) { msg.textContent = "Please complete the check above."; return; }
    data.turnstileToken = tsToken;
    fetch("/api/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok) { form.hidden = true; var d = document.getElementById("done"); d.hidden = false; d.focus(); return; }
        var names = { brandName: "brand name", contactName: "your name", email: "email", whatsapp: "WhatsApp number", website: "website", instagram: "Instagram handle" };
        msg.textContent = res.j.fields ? "Please check: " + res.j.fields.map(function (f) { return names[f.path] || f.path; }).join(", ") + "." : "Something went wrong. Please try again.";
      })
      .catch(function () { msg.textContent = "Something went wrong. Please try again."; });
  });
})();
