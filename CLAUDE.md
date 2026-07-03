# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

StageForge — a model-agnostic AI short-drama (短剧) production platform: script → storyboard →
keyframes → video → voiceover → lip-sync → 9:16 final cut. Every stage can independently use any
model (project-level default, per-shot override, or a one-off A/B run). The core architectural
principle: **adding a new model = one new adapter file + one line in a registry, zero pipeline
changes.**

## Commands

```bash
cp .env.example .env           # fill ANTHROPIC_API_KEY etc.; missing keys auto-degrade to mock adapters
docker compose up -d            # Postgres + Redis + MinIO (local infra)
npm install
npm run db:push && npm run db:seed
npm run dev                     # web (:3000) + worker, concurrently
```

- `npm run dev` — web + worker together; `npm run dev:web` / `npm run dev:worker` individually
- `npm run typecheck` — runs `db:generate` then `typecheck` across all workspaces (no test or lint
  scripts exist in this repo — don't invent `npm test`/`npm run lint` commands)
- `npm run build` — `prisma generate` + Next.js production build (web only)
- `npm run db:push` / `npm run db:seed` — sync Prisma schema / load demo data (`prisma/seed.ts`)
- `npm run infra:up` / `npm run infra:down` — docker compose for Postgres/Redis/MinIO
- Single-workspace commands: `npm run <script> -w @stageforge/web|worker|core|adapters|db`
- Demo login: `demo@stageforge.dev` / `stageforge`
- Local dev needs `ffmpeg` on PATH (or set `FFMPEG_PATH`); without it, mock video degrades to an
  SVG placeholder and compose fails with a clear error — the rest of the pipeline still works.

## Architecture

### Monorepo layout

```
apps/web      Next.js 14 app router — UI + API routes (submit job / query status only,
              never does long-running generation itself)
apps/worker   BullMQ consumers: generation queue + compose queue (ffmpeg)
packages/core        Capability/ModelAdapter/CostModel contracts, storage driver, queue, env
packages/adapters     One file per model under src/adapters/{text,image,character,video,audio,render}/
                       + registry.ts wiring them all together
packages/db           Prisma schema + client (PostgreSQL)
```

Data flow: web route creates a `GenerationJob` row and enqueues `{ jobId }` on BullMQ → worker
(`apps/worker/src/generation.ts`) loads the job, resolves the adapter, calls `submit()` then polls
until done, persists the resulting `Asset`/`Variant`, and writes a `CreditLedger` entry. The queue
message carries only the job id — all params live in `GenerationJob.input` in Postgres, so jobs are
auditable and replayable.

### Capability / adapter pattern (the core abstraction)

Every production stage is a stable **Capability** slot (`packages/core/src/types.ts`):
`text.script`, `text.storyboard`, `text.translate`, `image.t2i`, `image.character`, `video.t2v`,
`video.i2v`, `audio.tts`, `audio.voiceclone`, `audio.lipsync`, `audio.music`, `audio.sfx`,
`render.compose`. A model is a **ModelAdapter** plugged into a slot — models change, the
`submit()`/`poll()` interface never does.

To add a new model: copy `packages/adapters/src/adapters/video/_example-newmodel.ts`, fill in
`id/caps/cost/notes`, then add one line to `ALL_ADAPTERS` in `packages/adapters/src/registry.ts`.
Nothing else changes — Stage Rail dropdown, cost estimation, the generation pipeline, and the A/B
arena all pick it up automatically. Real API adapters (e.g. `adapters/text/claude.ts`,
`adapters/video/seedance.ts`) and mock adapters implement the exact same `ModelAdapter` interface;
the pipeline cannot tell them apart. Convention: every adapter checks for its API key at the top of
`submit()` and falls back to a deterministic mock when absent, so the whole app stays demoable
without any keys configured.

Which adapter actually runs for a given shot/capability is resolved with a 3-level override chain
(`apps/web/src/lib/pipeline.ts` `resolveAdapterId`): per-shot override (`ShotStage.adapterId`) →
project default (`ModelConfig.adapterId`) → first registered adapter for that capability. There is
no model-specific branching anywhere in this resolution path.

### Data model (`packages/db/prisma/schema.prisma`)

`Project → Episode → Scene → Shot → Variant`, plus `ShotStage` (per-shot per-capability adapter
override + params) and `ModelConfig` (project-level default adapter per capability). Each
generation call produces a new `Variant` (reroll = new row, cost always accumulates); the user picks
one as `selected`. `Character` holds cross-shot consistency data (reference image, consistency
prompt, cloned voice id) and is model-agnostic — only adapters declaring `supportsReferenceImage`
consume `characterRefs`. `CreditLedger` is the source of truth for cost (`GenerationJob` also tracks
`estimatedCostCents`/`actualCostCents` per job). `Episode.complianceStatus` gates compose/export
(see below).

### Cross-cutting infra (`packages/core`)

- `storage.ts` — `StorageDriver` abstraction: `local` (writes under `<monorepo root>/.data/`, for
  dev) vs `s3` (S3-compatible; required in production since Vercel/Railway filesystems are
  ephemeral). Selected via `STORAGE_DRIVER` env var.
- `queue.ts` — BullMQ queue names (`sf-generation`, `sf-compose`) and Redis connection config.
- `env.ts` — `findMonorepoRoot()` walks up from `process.cwd()` looking for the
  `stageforge-monorepo` package.json, since web/worker have different cwds but must share the same
  local data dir.
- Worker builds a `RunContext` per job (`apps/worker/src/context.ts`) that's the only bridge between
  an adapter and DB/storage/ffmpeg (`saveAsset`, `renderPlaceholderVideo`, `assetPublicUrl`, `log`).

### Compliance gate

`apps/web/src/lib/compliance.ts` runs before compose/export: blocks if content review (Claude, or
mock without a key) flags a `block`-severity finding, or if both `registrationNo` is empty *and* the
AI watermark is disabled. Passing only blocks on missing registration if the watermark is also off —
by design, one of the two safeguards must be present.

### Deployment

Cannot deploy to GitHub Pages (needs Postgres, Redis, a persistent worker process, and server-side
ffmpeg). Target topology: Next.js on Vercel (Root Directory `apps/web`, install/build commands `cd
../.. && npm install|run build`), worker as a persistent Railway service (`npm run start -w
@stageforge/worker`, needs `ffmpeg` in the image), Postgres/Redis on Railway, assets on Cloudflare
R2/S3. Full steps and troubleshooting in `DEPLOY.md`.
