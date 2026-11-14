// Fake brand shop for the e2e tests (port 8790).
//  - static pages in ./shop (Phase 1 demo brand, reached as localhost:8790)
//  - a Shopify-like catalogue: /robots.txt, /products.json, /products/item-N
//    (Phase 2 test brand, reached as 127.0.0.1:8790 so it's a different domain)
//  - POST /__install {key} simulates the brand pasting the Garrab line into their theme
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("./shop/", import.meta.url).pathname;
const types = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".js": "text/javascript" };
let installedKey = null;

const CATALOGUE = [
  { id: 2001, title: "Olive linen dress", handle: "item-1" },
  { id: 2002, title: "Black abaya with pockets", handle: "item-2" },
  { id: 2003, title: "Cotton shirt [low]", handle: "item-3" },
];

function productPage(p) {
  const tag = installedKey ? `<script src="http://localhost:8788/w.js" data-key="${installedKey}" async></script>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${p.title}</title>
<script>window.ShopifyAnalytics = { meta: { product: { id: ${p.id} } } };</script></head>
<body style="font-family:sans-serif;max-width:420px;margin:24px auto"><h1>${p.title}</h1><img src="/red-dress.svg" width="300" alt="">
<form action="/cart/add" method="post"><button type="submit" name="add">Add to cart</button></form>${tag}</body></html>`;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/__install") {
      let body = "";
      for await (const chunk of req) body += chunk;
      installedKey = JSON.parse(body).key ?? null;
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("User-agent: *\nDisallow: /checkout\n");
    }
    if (url.pathname === "/products.json") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const origin = `http://${req.headers.host}`;
      const products =
        page === 1
          ? CATALOGUE.map((p) => ({
              id: p.id,
              title: p.title,
              handle: p.handle,
              body_html: "<p>Made in Egypt.</p>",
              product_type: "Clothing",
              images: [{ src: `${origin}/red-dress.svg` }, { src: `${origin}/red-dress.svg` }],
              options: [{ name: "Size", values: ["S", "M", "L"] }],
              variants: [{ price: "1250.00" }],
            }))
          : [];
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ products }));
    }
    const item = CATALOGUE.find((p) => url.pathname === `/products/${p.handle}`);
    if (item) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(productPage(item));
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(productPage(CATALOGUE[0]));
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (!extname(p)) p += ".html";
    const body = await readFile(join(root, p));
    res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(8790, () => console.log("shop on http://localhost:8790"));
