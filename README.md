# Garrab

AI virtual try-on for small Egyptian brands, run as a done-for-you monthly service.
*See it on you. Before you buy.*

**Status: Phases 1–2 built and tested with mock AI.** Plan: [`PLAN.md`](PLAN.md). Demos: [`phase 1`](demo/phase-1.md), [`phase 2`](demo/phase-2.md), [`provider bake-off`](demo/bakeoff.md). Decisions and verified provider facts are in [`DECISIONS.md`](DECISIONS.md).

## Layout

```
apps/api         Cloudflare Worker: /v1/config, /v1/tryon, /v1/hosted, /v1/events, cron, D1 migrations
apps/widget      w.js (Shadow-DOM button, about 4 KB gzipped)
apps/frame       the try-on flow, used by the widget iframe and the hosted link
apps/site        Worker serving w.js, /frame, /t/<brand>/<product>, /start, /privacy, /terms and the portal
apps/portal      brand portal (React): magic-link login, products, approval gallery, install, links + QR
apps/admin       operator console (React, behind Cloudflare Access): invite, funnel, onboarding list
e2e/             Playwright tests against a fake shop
packages/shared  plans.ts (all prices and limits), design tokens, strings (EN and AR), Zod schemas
fixtures/        consented stock test photos (to be provided)
docs/            Pitch Kit, Pilot Proposal, Brand Guidelines (to be added)
```

## Run it

```bash
corepack enable          # once; gives you pnpm 10
pnpm install
pnpm build
pnpm typecheck
pnpm test     # unit, API and privacy tests in the Workers runtime
pnpm e2e      # browser tests (starts local API, site and a fake shop)
```

## Rules

- Prices and limits live only in `packages/shared/src/plans.ts`. A test fails if they appear anywhere else.
- No shopper photo, measurement or size input is ever stored or logged.
- Secrets only in Worker secrets. `.env.example` lists them all.
- All schedules and emails use Africa/Cairo time; all money is EGP.
