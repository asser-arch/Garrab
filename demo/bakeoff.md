# Try-on bake-off: which provider looks best?

Runs the same real products and the same consented stock photos through every provider you have keys for, then shows them side by side with a 1–5 score per result.

```bash
cd apps/api
# Any or all of these:
export GENLOOK_API_KEY=gk_...
export GEMINI_API_KEY=...                         # paid tier
export VERTEX_PROJECT=my-gcp-project              # Google's dedicated try-on model
# (Vertex uses `gcloud auth print-access-token`, or set VERTEX_ACCESS_TOKEN)

# 1. See the plan and the cost first (no calls made):
pnpm bakeoff -- --photos ../../fixtures --shop https://<target-brand>.com --count 10 --dry-run

# 2. Run it (stops at --max-usd, default 6):
pnpm bakeoff -- --photos ../../fixtures --shop https://<target-brand>.com --count 10
```

- `--shop` reads the store's public Shopify `products.json`. For other stores, pass `--products file.json` with `[{ "id", "title", "description", "images": ["https://…"] }]`.
- 10 products × 2 photos × 4 providers is about **4 USD**.
- Open `docs/bakeoff/<date>/index.html`, score each result, click **Download my scores (CSV)**, and send me the CSV. The folder is git-ignored because it contains the stock model's face.
- Use **consented stock photos only**, never a shopper's photo. Genlook data is deleted after each call; Gemini is called with `store: false`.

What to look for: the garment matches (colour, pattern, length), the person is unchanged (face, body, hijab), no artifacts, believable fit.
