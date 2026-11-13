# Garrab

AI virtual try-on for small Egyptian brands, run as a done-for-you monthly service.
*See it on you. Before you buy.*

**Status: Phase 0 (foundation).** Waiting for approval of [`PLAN.md`](PLAN.md). Decisions and verified provider facts are in [`DECISIONS.md`](DECISIONS.md).

## Layout

```
apps/            (from Phase 1) api, widget, frame, portal, admin, site
packages/shared  plans.ts (all prices and limits), design tokens, strings (EN and AR), Zod schemas
fixtures/        consented stock test photos (to be provided)
docs/            Pitch Kit, Pilot Proposal, Brand Guidelines (to be added)
```

## Run it

```bash
corepack enable          # once; gives you pnpm 10
pnpm install
pnpm typecheck
pnpm test
```

## Rules

- Prices and limits live only in `packages/shared/src/plans.ts`. A test fails if they appear anywhere else.
- No shopper photo, measurement or size input is ever stored or logged.
- Secrets only in Worker secrets. `.env.example` lists them all.
- All schedules and emails use Africa/Cairo time; all money is EGP.
