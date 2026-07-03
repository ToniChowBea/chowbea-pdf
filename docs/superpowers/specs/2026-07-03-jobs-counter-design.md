# Landing-Page Jobs Counter — Design

**Date:** 2026-07-03
**Status:** Approved

## Context

Six tools run through the job queue; all job state is deliberately in-memory
and dies on redeploy. The owner wants a lifetime "jobs performed" counter on
the landing page, which therefore needs the project's first durable storage.
Chosen approach: a **Railway volume** on the api with a tiny JSON stats file
(a database for one integer would be overkill).

## Decisions

- Counts **successful completions only** (`done`), across all tools. Failed
  jobs are not "performed."
- Counting starts at 0 on deploy day — no history exists to backfill.
- Storage: `<data_dir>/stats.json` shaped `{"jobs_completed": <int>}`;
  `data_dir` from new setting `CHOWBEA_DATA_DIR` (default `./data` locally,
  `/data` on Railway where the volume mounts).

## API

- `api/app/jobs/stats.py` — `CounterStore(path)`:
  - `load()` at construction: missing/corrupt file → 0 (corrupt logs a
    warning; never crashes startup).
  - `increment() -> int`: bumps in memory, writes atomically
    (temp file + `os.replace`) so a mid-write crash can't corrupt the file.
    All calls happen on the event loop (worker completions), so no locking.
  - `count` property.
- Lifespan: create the store (ensuring `data_dir` exists) on
  `app.state.counter`; pass it to the worker via `execute_job` — on a job
  reaching `done`, increment.
- `GET /queue` (`QueueBoard` schema) gains `jobs_completed: int` — the
  landing page and queue board share the same public endpoint; no new route.
- Tests: CounterStore unit tests (missing file → 0, increment persists to a
  re-loaded store, corrupt file → 0); worker increments on done and NOT on
  failed; `/queue` returns the count.

## Web

- Homepage hero (`web/src/routes/index.tsx` — the hero block next to the
  tagline): a Bold-Blocks stat chip reading `<N> JOBS DONE` (formatted with
  thousands separators).
- Data: client-side fetch of the existing `fetchQueueBoard()` on mount; a
  count-up animation (motion, already a dependency) from 0 to N over ~0.8 s.
- Loading/error: the chip renders nothing until the fetch succeeds — no
  skeleton, no error state on a landing page.
- `QueueBoard` type in `web/src/lib/jobs.ts` gains `jobs_completed: number`;
  typed client regenerated.

## Infra (controller, before merge)

- Create a 1 GB Railway volume mounted at `/data` on the api service; set
  `CHOWBEA_DATA_DIR=/data` on the api. (Without the volume the code still
  works — it just falls back to ephemeral `./data`, losing the count on
  redeploy; the volume is what makes it lifetime.)
- Note: attaching the volume restarts the api once; volumes pin the service
  to a single replica (already the case by design).

## Out of scope (YAGNI)

Per-tool breakdowns, time series, dashboards, backfill, moving the counter
into a database.

## Delivery

Branch `jobs-counter` → subagent tasks with reviews → final review → PR →
checks → merge → volume + env applied → prod verification (run one job, watch
`/queue`'s `jobs_completed` tick up; landing page shows the chip). NO browser
testing (owner directive) — chip verified via served HTML/JS presence and the
API number, not Playwright.
