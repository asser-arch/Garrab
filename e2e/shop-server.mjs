// Minimal static server for the fake brand shop used by the e2e tests (port 8790).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("./shop/", import.meta.url).pathname;
const types = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".js": "text/javascript" };
createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    if (!extname(p)) p += ".html";
    const body = await readFile(join(root, p));
    res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(8790, () => console.log("shop on http://localhost:8790"));
