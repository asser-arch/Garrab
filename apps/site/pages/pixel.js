/**
 * Meta Pixel (dataset "Garrab", 2607650933071134) for Garrab's OWN marketing: garrabb.com and the
 * app.garrabb.com/start sign-up page only. It is never loaded on brand portals, pay pages or shoppers'
 * try-on pages (those pages don't include this file). Staging and local copies send nothing.
 * Events: PageView; Contact (WhatsApp tap); StartPilotClick (to the sign-up); Lead (sign-up done, with the same
 * event ID the server sends through the Conversions API so Meta counts it once).
 */
(function () {
  var live = location.hostname === "garrabb.com" || location.hostname === "app.garrabb.com";
  // On the landing page: pass this visitor's source (campaign tags, the site that sent them, a Meta ad click)
  // on to the sign-up page links, so a sign-up records where the brand found Garrab. No personal data.
  if (!/^app\./.test(location.hostname)) {
    var q = new URLSearchParams(location.search);
    var add = new URLSearchParams();
    ["utm_source", "utm_medium", "utm_campaign"].forEach(function (k) { if (q.get(k)) add.set(k, q.get(k)); });
    if (q.get("fbclid")) add.set("meta", "1");
    try { var rh = document.referrer ? new URL(document.referrer).hostname : ""; if (rh && rh !== location.hostname) add.set("from", rh); } catch (x) { /* none */ }
    add.set("landing", "1");
    var decorate = function () {
      document.querySelectorAll('a[href^="https://app.garrabb.com/start"], a[href^="/start"]').forEach(function (a) {
        var u = new URL(a.getAttribute("href"), location.href);
        add.forEach(function (v, k) { if (!u.searchParams.has(k)) u.searchParams.set(k, v); });
        a.setAttribute("href", u.href);
      });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", decorate); else decorate();
  }
  window.garrabLead = function () {};
  if (!live) return;
  /* eslint-disable */
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = []; t = b.createElement(e); t.async = !0;
    t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
  /* eslint-enable */
  window.fbq("init", "2607650933071134");
  window.fbq("track", "PageView");
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (href.indexOf("https://wa.me/") === 0) window.fbq("track", "Contact");
    else if (href.indexOf("https://app.garrabb.com/start") === 0 || href.indexOf("/start") !== -1) window.fbq("trackCustom", "StartPilotClick");
  });
  /** Sign-up saved: the browser half of the Lead (the server sends the other half with the same ID). */
  window.garrabLead = function (eventId) {
    window.fbq("track", "Lead", {}, { eventID: eventId });
  };
})();
