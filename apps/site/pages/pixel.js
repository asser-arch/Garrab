/**
 * Meta Pixel (dataset "Garrab", 2607650933071134) for Garrab's OWN marketing: garrabb.com and the
 * app.garrabb.com/start sign-up page only. It is never loaded on brand portals, pay pages or shoppers'
 * try-on pages (those pages don't include this file). Staging and local copies send nothing.
 * Events: PageView; Contact (WhatsApp tap); StartPilotClick (to the sign-up); Lead (sign-up done, with the same
 * event ID the server sends through the Conversions API so Meta counts it once).
 */
(function () {
  var live = location.hostname === "garrabb.com" || location.hostname === "app.garrabb.com";
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
    else if (href.indexOf("https://app.garrabb.com/start") === 0) window.fbq("trackCustom", "StartPilotClick");
  });
  /** Sign-up saved: the browser half of the Lead (the server sends the other half with the same ID). */
  window.garrabLead = function (eventId) {
    window.fbq("track", "Lead", {}, { eventID: eventId });
  };
})();
