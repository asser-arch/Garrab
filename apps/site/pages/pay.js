// Pay page: /pay/<token>. Shows one invoice and how to pay it by InstaPay.
(function () {
  var app = document.getElementById("app");
  var m = /^\/pay\/([A-Za-z0-9]{32})\/?$/.exec(location.pathname);
  var token = m && m[1];
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (k) { if (k !== null && k !== undefined) e.append(k); });
    return e;
  }
  function egp(p) { return (p / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) + " EGP"; }
  function copyBtn(text, label) {
    var b = el("button", { type: "button", class: "btn small ghost" }, [label]);
    b.addEventListener("click", function () {
      navigator.clipboard.writeText(text).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = label; }, 2000); });
    });
    return b;
  }
  function render(d) {
    var head = el("h1", {}, ["Invoice ", el("span", { class: "soft" }, [d.number])]);
    var summary = el("div", { class: "card" }, [
      el("p", { class: "muted small" }, [d.brand]),
      el("ul", {}, d.lines.map(function (l) { return el("li", {}, [l.label + ": " + egp(l.amount)]); })),
      d.vatRateBp > 0 ? el("p", { class: "small" }, ["VAT " + d.vatRateBp / 100 + "%: " + egp(d.vat)]) : null,
      el("p", { class: "stat" }, [egp(d.total)]),
      el("p", { class: "small muted" }, [d.status === "paid" ? "Paid" : "Due " + d.dueDate]),
      el("p", {}, [el("a", { href: d.pdf, class: "small" }, ["Download PDF"])]),
    ]);
    var body = [head, summary];
    if (d.status === "paid") {
      body.push(el("div", { class: "card note", role: "status" }, [el("h2", {}, ["Paid ✓"]), el("p", {}, ["Thank you. Your receipt is the PDF above."])]));
    } else if (d.status === "void") {
      body.push(el("div", { class: "card warn" }, ["This invoice was cancelled."]));
    } else if (d.claim && d.claim.status === "pending") {
      body.push(el("div", { class: "card note", role: "status" }, [el("h2", {}, ["Thanks, we're checking your transfer"]), el("p", {}, ["We'll confirm it shortly, usually within a few hours, and email you. Try-on stays on while we check."])]));
    } else if (d.instapay && d.instapay.address) {
      var steps = el("ol", {}, [
        el("li", {}, ["Open your InstaPay app."]),
        el("li", {}, ["Send ", el("strong", {}, [egp(d.total)]), " to ", el("strong", {}, [d.instapay.address]), d.instapay.accountName ? " (" + d.instapay.accountName + ")" : "", "."]),
        el("li", {}, ["In the note, write ", el("strong", {}, [d.number]), "."]),
        el("li", {}, ["Come back here and tap ", el("strong", {}, ["I've paid"]), " with the reference from your InstaPay receipt."]),
      ]);
      var tools = el("div", { class: "row" }, [copyBtn(d.instapay.address, "Copy InstaPay address"), copyBtn(String(d.total / 100), "Copy amount"), copyBtn(d.number, "Copy invoice number"),
        d.instapay.link ? el("a", { class: "btn small accent", href: d.instapay.link, target: "_blank", rel: "noopener" }, ["Open InstaPay"]) : null]);
      var form = el("form", { class: "card", novalidate: "" }, [
        el("h2", {}, ["I've paid"]),
        el("label", { for: "ref" }, ["InstaPay reference (from your receipt)"]),
        el("input", { id: "ref", name: "reference", required: "", minlength: "4", maxlength: "64", autocomplete: "off" }),
        el("label", { for: "payer" }, ["Name on the sending account (optional)"]),
        el("input", { id: "payer", name: "payerName", maxlength: "80" }),
        el("p", { id: "msg", role: "alert", class: "small" }),
        el("button", { class: "btn", type: "submit" }, ["I've paid"]),
      ]);
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var ref = form.querySelector("#ref").value.trim();
        if (ref.length < 4) { form.querySelector("#msg").textContent = "Please enter the reference from your InstaPay receipt."; return; }
        fetch("/pay-api/" + token + "/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference: ref, payerName: form.querySelector("#payer").value.trim() || undefined }) })
          .then(function (r) { if (!r.ok) throw new Error(); return load(); })
          .catch(function () { form.querySelector("#msg").textContent = "Something went wrong. Please try again."; });
      });
      body.push(el("div", { class: "card" }, [el("h2", {}, ["Pay by InstaPay"]), steps, tools]), form);
    } else {
      body.push(el("div", { class: "card" }, ["Reply to your invoice email and we'll send payment details."]));
    }
    app.replaceChildren.apply(app, body);
  }
  function load() {
    return fetch("/pay-api/" + token).then(function (r) { if (!r.ok) throw new Error(); return r.json(); }).then(render)
      .catch(function () { app.replaceChildren(el("div", { class: "card" }, [el("h1", {}, ["Invoice not found"]), el("p", {}, ["Check the link in your email."])])); });
  }
  if (!token) app.replaceChildren(el("div", { class: "card" }, ["Invoice not found."])); else load();
})();
