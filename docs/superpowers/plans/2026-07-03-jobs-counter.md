# Jobs Counter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lifetime "jobs performed" counter on the landing page, persisted on a Railway volume so it survives redeploys.

**Architecture:** A `CounterStore` (JSON file, atomic temp+`os.replace` writes) on `app.state`, incremented when a job reaches `done`; the count rides the existing `GET /queue` board response; the homepage hero renders a count-up chip fetched client-side.

**Tech Stack:** stdlib json/os, FastAPI, pytest; React + motion (`animate`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-jobs-counter-design.md`
**Branch:** all work on `jobs-counter` (already created; `main` is protected).

## Global Constraints

- Counts **`done` only** — failed jobs never increment.
- Stats file: `<data_dir>/stats.json` shaped exactly `{"jobs_completed": <int>}`; `settings.data_dir` default `"./data"`, env `CHOWBEA_DATA_DIR`.
- Missing OR corrupt stats file → count 0 (corrupt logs a warning, never crashes startup); a failed persist write logs a warning and keeps the in-memory count (a full volume must not fail jobs).
- `QueueBoard` gains `jobs_completed: int`; no new route.
- The homepage chip renders **nothing** while loading, on fetch error, or when the count is 0 (a landing page never shows "0 jobs done").
- NO dev servers (except the controller's codegen uvicorn on :8055), NO browsers, NO Playwright. Gates: pytest, vitest, typecheck, build.
- Never `git add -A`.

---

### Task 1: CounterStore + setting

**Files:**
- Create: `api/app/jobs/stats.py`
- Modify: `api/app/core/config.py` (one field)
- Test: `api/tests/test_stats.py`

**Interfaces:**
- Produces: `CounterStore(path: Path)` with `.count -> int` property and `.increment() -> int`; `settings.data_dir: str` default `"./data"`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_stats.py`:
```python
"""The durable jobs counter: load, increment, persistence, corruption."""

from app.jobs.stats import CounterStore


def test_missing_file_starts_at_zero(tmp_path):
    store = CounterStore(tmp_path / "stats.json")
    assert store.count == 0


def test_increment_persists_across_reload(tmp_path):
    path = tmp_path / "stats.json"
    store = CounterStore(path)
    assert store.increment() == 1
    assert store.increment() == 2
    assert CounterStore(path).count == 2


def test_corrupt_file_starts_at_zero(tmp_path):
    path = tmp_path / "stats.json"
    path.write_text("{not json", encoding="utf-8")
    assert CounterStore(path).count == 0


def test_wrong_shape_starts_at_zero(tmp_path):
    path = tmp_path / "stats.json"
    path.write_text('{"jobs_completed": "many"}', encoding="utf-8")
    assert CounterStore(path).count == 0


def test_data_dir_setting_defaults():
    from app.core.config import Settings

    assert Settings(_env_file=None).data_dir == "./data"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_stats.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.jobs.stats'`.

- [ ] **Step 3: Implement**

Create `api/app/jobs/stats.py`:
```python
"""Durable lifetime stats: a tiny JSON counter that survives redeploys.

The file lives on the Railway volume (CHOWBEA_DATA_DIR=/data in production).
Writes are atomic (temp file + os.replace) so a crash mid-write can never
corrupt the count; all increments happen on the event loop, so no locking.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)


class CounterStore:
    """Loads and persists the lifetime jobs-completed counter."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._count = self._load()

    def _load(self) -> int:
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
            count = payload["jobs_completed"]
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise ValueError(f"bad count: {count!r}")
            return count
        except FileNotFoundError:
            return 0
        except (ValueError, KeyError, TypeError, OSError):
            logger.warning("Stats file %s unreadable; starting the counter at 0", self._path)
            return 0

    @property
    def count(self) -> int:
        return self._count

    def increment(self) -> int:
        """Bump the counter and persist; a failed write never fails the job."""
        self._count += 1
        try:
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"jobs_completed": self._count}), encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError:
            logger.warning("Could not persist stats to %s", self._path)
        return self._count
```

In `api/app/core/config.py`, after `commit_sha`:
```python
    # Directory for small durable state (the jobs counter); a Railway volume
    # is mounted here in production so the data survives redeploys.
    data_dir: str = "./data"
```

- [ ] **Step 4: Run to verify green**

Run: `cd api && uv run pytest tests/test_stats.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add api/app/jobs/stats.py api/app/core/config.py api/tests/test_stats.py
git commit -m "Add durable jobs counter store"
```

---

### Task 2: Wire the counter — lifespan, worker, board

**Files:**
- Modify: `api/app/main.py`, `api/app/jobs/worker.py`, `api/app/jobs/schemas.py`, `api/app/routers/jobs.py`
- Test: `api/tests/test_worker.py` (append), `api/tests/test_job_endpoints.py` (append)

**Interfaces:**
- Consumes: `CounterStore`, `settings.data_dir` from Task 1.
- Produces: `execute_job(registry, job_id, counter: CounterStore | None = None)`; `QueueBoard.jobs_completed: int`; `app.state.counter`.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_worker.py`:
```python
def test_done_job_increments_counter(tmp_path):
    from app.jobs.stats import CounterStore

    registry = JobRegistry()
    counter = CounterStore(tmp_path / "stats.json")
    workspace = tmp_path / "job"
    workspace.mkdir()
    write_blank_pdf(workspace / "input.pdf")
    record = registry.create(
        tool="lock",
        workspace=workspace,
        file_count=1,
        total_bytes=1,
        params={
            "password": "pw", "allow_printing": True, "allow_copying": False,
            "allow_editing": False, "encryption": "aes-256", "name": "a.pdf",
        },
    )
    asyncio.run(execute_job(registry, record.id, counter))
    assert record.status is JobStatus.done
    assert counter.count == 1


def test_failed_job_does_not_increment_counter(tmp_path):
    from app.jobs.stats import CounterStore

    registry = JobRegistry()
    counter = CounterStore(tmp_path / "stats.json")
    workspace = tmp_path / "job"
    workspace.mkdir()
    write_blank_pdf(workspace / "input.pdf")
    record = registry.create(
        tool="unlock",
        workspace=workspace,
        file_count=1,
        total_bytes=1,
        params={"password": "wrong", "name": "a.pdf"},
    )
    asyncio.run(execute_job(registry, record.id, counter))
    assert record.status is JobStatus.failed
    assert counter.count == 0
```

Append to `api/tests/test_job_endpoints.py`:
```python
def test_queue_board_reports_jobs_completed(client, tmp_path):
    from app.jobs.stats import CounterStore

    from app.main import app

    counter = CounterStore(tmp_path / "stats.json")
    counter.increment()
    counter.increment()
    app.state.counter = counter
    try:
        board = client.get("/queue").json()
        assert board["jobs_completed"] == 2
    finally:
        del app.state.counter
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_worker.py tests/test_job_endpoints.py -v`
Expected: the three new tests FAIL (unexpected `counter` argument / missing `jobs_completed` key); existing pass.

- [ ] **Step 3: Implement**

1. `api/app/jobs/worker.py` — signature and the done-branch:
```python
from app.jobs.stats import CounterStore
```
```python
async def execute_job(
    registry: JobRegistry, job_id: str, counter: CounterStore | None = None
) -> None:
```
and in the `else:` (done) branch, after `record.status = JobStatus.done`:
```python
        if counter is not None:
            counter.increment()
```
2. `api/app/jobs/schemas.py` — `QueueBoard` gains `jobs_completed: int`.
3. `api/app/routers/jobs.py` — in `queue_board`:
```python
    counter = getattr(request.app.state, "counter", None)
    return QueueBoard(
        concurrency=settings.job_concurrency,
        jobs_completed=counter.count if counter is not None else 0,
        processing=[_board_entry(r) for r in registry.processing()],
        waiting=[_board_entry(r) for r in registry.waiting()],
    )
```
4. `api/app/main.py` — in `lifespan`, after the registry/queue creation:
```python
    data_dir = Path(settings.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    counter = CounterStore(data_dir / "stats.json")
    app.state.counter = counter
```
with imports `from pathlib import Path` and `from app.jobs.stats import CounterStore`, and the consumer handler becomes:
```python
    async def handle(job_id: str) -> None:
        await execute_job(registry, job_id, counter)
```

- [ ] **Step 4: Full suite**

Run: `cd api && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run pytest`
Expected: all pass, including the 3 new tests (the 2 soffice-gated skips are fine).

- [ ] **Step 5: Commit**

```bash
git add api/app/jobs/worker.py api/app/jobs/schemas.py api/app/routers/jobs.py api/app/main.py api/tests/test_worker.py api/tests/test_job_endpoints.py
git commit -m "Count completed jobs and expose the total on the queue board"
```

---

### Task 3: Homepage counter chip

**Files:**
- Modify: `web/src/lib/jobs.ts` (`QueueBoard` type), `web/src/routes/index.tsx`

**Interfaces:**
- Consumes: `fetchQueueBoard()` (existing), `QueueBoard.jobs_completed` from Task 2's API shape.

- [ ] **Step 1: Extend the type**

In `web/src/lib/jobs.ts`, add to `QueueBoard`:
```ts
  jobs_completed: number
```

- [ ] **Step 2: Add the chip to `web/src/routes/index.tsx`**

Read the file first. Add imports: `animate` from `"motion/react"` (there may be existing motion imports to extend), `fetchQueueBoard` from `"@/lib/jobs"`, and `* as React` if not already imported. Add the component above the page component:
```tsx
/** Lifetime jobs-performed chip. Renders nothing until the count arrives and
never shows zero — a landing page shouldn't advertise "0 jobs done". */
function JobsCounter() {
  const [count, setCount] = React.useState<number | null>(null)
  const [display, setDisplay] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    fetchQueueBoard()
      .then((board) => {
        if (!cancelled) setCount(board.jobs_completed)
      })
      .catch(() => {
        // A landing page shows nothing rather than an error state.
      })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (count === null || count === 0) return
    const controls = animate(0, count, {
      duration: 0.8,
      ease: "easeOut",
      onUpdate: (value) => setDisplay(Math.round(value)),
    })
    return () => controls.stop()
  }, [count])

  if (count === null || count === 0) return null
  return (
    <span className="inline-flex items-center gap-2 rounded-full border-2 border-ink bg-amber px-4 py-2 text-[13px] font-extrabold uppercase tracking-wide text-ink shadow-block-sm">
      <span className="tabular-nums">{display.toLocaleString()}</span> jobs done
    </span>
  )
}
```
Placement: render `<JobsCounter />` inside the hero, in the same container as the "Upload PDF" link, immediately after that link (the container holds the tagline paragraph and the link; if it isn't already a flex row that can take a second chip gracefully, wrap the link and chip in `<div className="flex flex-wrap items-center gap-3">…</div>` — keep the existing classes on the link untouched).

- [ ] **Step 3: Gates**

Run: `cd web && bun run test && bun run typecheck && bun run build`
Expected: vitest 12 passed; typecheck clean; build green.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/jobs.ts web/src/routes/index.tsx
git commit -m "Show a lifetime jobs-done counter on the landing page"
```

---

### Task 4 (controller): Codegen, volume + env, final review, PR, prod verify

- [ ] Codegen: throwaway uvicorn on :8055, temp `api.config.toml` edit, `bun api:fetch --force && bun api:generate`, revert, typecheck, commit `web/src/services/api/`.
- [ ] Final review (single whole-branch pass — small diff, sonnet is proportionate) + fix wave if needed.
- [ ] Infra BEFORE merge so the env exists when the code deploys: create a 1 GB volume on the api service mounted at `/data` (Railway MCP `create_volume` or GraphQL `volumeCreate`), then `railway variable set 'CHOWBEA_DATA_DIR=/data' --service api`. Note: the volume attach restarts the api once.
- [ ] Push, PR, checks, merge, pull main.
- [ ] Prod verify (curl only): `/queue` shows `jobs_completed` (0 initially); run one lock job to completion; `/queue` shows 1; landing page HTML/JS serves the chip code; `/health` commit matches.
