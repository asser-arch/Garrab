/**
 * Install guide (admin reference): how to put a brand's Garrab line on its website, platform by platform.
 * Written for a screen-share: short numbered steps, the exact menu names, and a check at the end.
 */
interface Platform {
  id: string;
  name: string;
  note?: string;
  steps: string[];
  tip?: string;
}

const PLATFORMS: Platform[] = [
  {
    id: "shopify",
    name: "Shopify",
    steps: [
      "Sign in to the Shopify admin (yourshop.myshopify.com/admin).",
      "Go to Online Store → Themes.",
      "On the live theme (under \"Current theme\"), click the ⋯ button next to Customize → Edit code.",
      "In the file list on the left, open Layout → theme.liquid.",
      "Press Ctrl+F (Cmd+F on Mac) and search for </body>. It's near the bottom of the file.",
      "Click just before </body>, press Enter for a new line, and paste the brand's Garrab line there.",
      "Click Save (top right).",
    ],
    tip: "If the brand later changes or updates its theme, the line has to be pasted into the new theme too. Check after any theme change.",
  },
  {
    id: "woocommerce",
    name: "WooCommerce / WordPress",
    note: "The safe way is a small free plugin, so the line survives theme updates.",
    steps: [
      "Sign in to WordPress (yourshop.com/wp-admin).",
      "Go to Plugins → Add New Plugin, search for \"WPCode\", click Install Now, then Activate.",
      "Go to Code Snippets → Header & Footer (in the left menu).",
      "Paste the brand's Garrab line into the Footer box.",
      "Click Save Changes.",
      "If the shop uses a cache plugin (WP Rocket, LiteSpeed Cache, W3 Total Cache, Autoptimize…), clear its cache so the change shows.",
    ],
    tip: "If they already have a \"header and footer scripts\" plugin (for example for the Facebook Pixel), use that one instead and paste into its footer box.",
  },
  {
    id: "wix",
    name: "Wix",
    note: "Needs a paid Wix plan with a connected domain (custom code is off on free Wix sites).",
    steps: [
      "Open the site's Dashboard on wix.com.",
      "Go to Settings → scroll to Advanced → Custom Code.",
      "Click + Add Custom Code (top right).",
      "Paste the brand's Garrab line into the code box and name it \"Garrab\".",
      "Under \"Add Code to Pages\", choose All pages (Load code once).",
      "Under \"Place Code in\", choose Body - end.",
      "Click Apply.",
    ],
  },
  {
    id: "squarespace",
    name: "Squarespace",
    note: "Needs a Business or Commerce plan (code injection isn't on the Personal plan).",
    steps: [
      "Open the site in Squarespace.",
      "Go to Settings → Developer Tools → Code Injection (older menus: Settings → Advanced → Code Injection).",
      "Paste the brand's Garrab line into the Footer box.",
      "Click Save.",
    ],
  },
  {
    id: "webflow",
    name: "Webflow",
    note: "Needs a paid site plan for custom code.",
    steps: [
      "Open the project in Webflow and go to Site settings → Custom code.",
      "Paste the brand's Garrab line into Footer code (\"Before </body> tag\").",
      "Click Save changes.",
      "Click Publish so the change goes live.",
    ],
  },
  {
    id: "other",
    name: "Other shop platforms (Egyptian builders and the rest)",
    note: "Most shop builders have a box for extra scripts: it's the same place a Facebook Pixel or Google Analytics code goes.",
    steps: [
      "In the shop's dashboard, look for a menu called Custom code, Code injection, Tracking codes, Scripts, Header & footer, or Integrations → Custom scripts.",
      "Paste the brand's Garrab line in the footer / \"end of body\" box if there is one; otherwise the header box works too.",
      "Save, and publish if the platform asks.",
      "If you can't find any such box, ask the platform's support: \"Where can I add a custom script to every page?\" If there is none, the brand uses the try-on link in its bio instead.",
    ],
  },
  {
    id: "html",
    name: "Hand-built website (HTML)",
    note: "For a site made by a developer, or plain HTML files.",
    steps: [
      "Open the template that every product page shares (often called layout, base, footer or theme).",
      "Find the closing </body> tag.",
      "Paste the brand's Garrab line on the line just before </body>.",
      "Save and upload / redeploy the site.",
      "If the site has a Content Security Policy, the developer must allow cdn.garrabb.com (script-src), api.garrabb.com (connect-src) and app.garrabb.com (frame-src).",
    ],
  },
];

export function InstallGuide({ onBrands }: { onBrands: () => void }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Install guide <span className="soft">putting Garrab on a brand's website</span>
          </h1>
          <p className="small muted">For screen-sharing with a brand. Brands without a website skip this: they use their try-on link in their Instagram bio.</p>
        </div>
      </div>

      <div className="card">
        <h2>Before you start</h2>
        <ol className="steps">
          <li>
            Get the brand's <strong>Garrab line</strong>. Open the brand (from the{" "}
            <a href="#" onClick={(e) => (e.preventDefault(), onBrands())}>
              Dashboard
            </a>
            ) → <strong>Portal, widget key and domains</strong> → <strong>Copy the line</strong>. The brand also sees the same line in its portal under{" "}
            <strong>Install &amp; links</strong>.
          </li>
          <li>
            Check the brand's <strong>website address is listed under Domains</strong> on the same card. The button only appears on listed domains (www and
            non-www count as the same). Add it there if it's missing.
          </li>
          <li>
            The button only shows on pages of <strong>approved products</strong>, right under the product's Add to cart / Buy button.
          </li>
        </ol>
      </div>

      {PLATFORMS.map((p) => (
        <details className="card guide" key={p.id}>
          <summary>
            <h2>{p.name}</h2>
          </summary>
          {p.note && <p className="small muted">{p.note}</p>}
          <ol className="steps">
            {p.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {p.tip && <p className="small">Tip: {p.tip}</p>}
        </details>
      ))}

      <div className="card">
        <h2>Check it worked</h2>
        <ol className="steps">
          <li>
            In the brand's portal: <strong>Install &amp; links → Check installation</strong>. It should say <strong>Installed ✓</strong>. (Garrab also checks every
            site once a day; the result shows on the brand's domains in the admin.)
          </li>
          <li>
            Open one of the brand's <strong>approved products</strong> on their website, on a phone. A green <strong>Try it on</strong> button (or{" "}
            <strong>See it in your room</strong> for home décor) appears under the Buy button within a few seconds.
          </li>
          <li>Tap it, upload a photo, and check the preview appears.</li>
        </ol>
      </div>

      <div className="card">
        <h2>If the button doesn't show</h2>
        <ul className="steps">
          <li>
            <strong>Wrong page:</strong> it only shows on approved products. Check the product is approved in the brand's portal (Approve).
          </li>
          <li>
            <strong>Domain not listed:</strong> add the exact website address under Domains on the brand's admin card.
          </li>
          <li>
            <strong>Old page cached:</strong> clear the site's cache plugin (WordPress) or wait a few minutes, then reload.
          </li>
          <li>
            <strong>Line pasted in the wrong place</strong> (inside another script, or in a theme that isn't live): paste it again just before{" "}
            <code>&lt;/body&gt;</code> in the live theme.
          </li>
          <li>
            <strong>Brand switched off</strong> (unpaid, paused or killed): the button is hidden on purpose. Check the brand's status on the Dashboard.
          </li>
          <li>
            <strong>Button in an odd spot:</strong> it goes under the page's Buy / Add to cart button. On unusual themes, add{" "}
            <code>data-garrab-product</code> to the element it should sit in, or tell Claude the page address to set a custom position.
          </li>
        </ul>
      </div>
    </>
  );
}
