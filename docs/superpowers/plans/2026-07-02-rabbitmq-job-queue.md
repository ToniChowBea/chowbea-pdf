# RabbitMQ Job Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all PDF jobs (compress/lock/unlock) through RabbitMQ with 3 concurrent workers, expose queue position + a public queue board, and remove the Sign in button.

**Architecture:** The FastAPI process publishes job ids to a durable RabbitMQ queue and consumes them itself with `prefetch=3` (aio-pika), executing the existing service functions in worker threads. An in-process insertion-ordered registry is the source of truth for status/position; files and passwords never transit the broker. The browser submits (202 + job id), polls `GET /jobs/{id}`, downloads on done.

**Tech Stack:** FastAPI, aio-pika, pytest, pikepdf (tests), TanStack Start/React, axios, vitest.

**Spec:** `docs/superpowers/specs/2026-07-02-rabbitmq-queue-design.md`

## Global Constraints

- Concurrency is exactly **3** (`prefetch_count=3`), config-driven via `CHOWBEA_JOB_CONCURRENCY` default 3.
- Result retention is **30 minutes** after `finished_at` (`CHOWBEA_RESULT_TTL_MINUTES` default 30), swept every 60 s.
- RabbitMQ queue name: `pdf-jobs`, durable; message body is exactly `{"job_id": "<hex>"}`, persistent delivery.
- Passwords and file bytes must never be published to RabbitMQ or logged.
- Public board entries expose only: `id_prefix` (first 6 chars), `tool`, `file_count`, `total_bytes`, `created_at`. Never filenames.
- Existing upload validation (PDF magic bytes, `CHOWBEA_MAX_UPLOAD_MB` cap, empty-file, password-required-for-lock) must stay at submit time with today's status codes (400/413).
- All api commands run from `api/` with `uv run …`; all web commands from `web/` with `bun …`.
- Env prefix for new settings: `CHOWBEA_` (matches `SettingsConfigDict(env_prefix="CHOWBEA_")`).

---

### Task 1: API dependencies and settings

**Files:**
- Modify: `api/pyproject.toml`
- Modify: `api/app/core/config.py`
- Test: `api/tests/test_config.py` (new; also create empty `api/tests/__init__.py`)

**Interfaces:**
- Produces: `settings.rabbitmq_url: str`, `settings.result_ttl_minutes: int` (30), `settings.job_concurrency: int` (3). Later tasks read these names exactly.

- [ ] **Step 1: Add runtime and dev dependencies**

Run:
```bash
cd api && uv add aio-pika && uv add --dev pytest==8.3.4
```
Expected: `uv.lock` and `pyproject.toml` updated, exit 0. Then edit the `aio-pika` entry in `pyproject.toml` to pin the exact version uv resolved (e.g. `"aio-pika==9.5.x"`), matching the repo's exact-pin style, and run `uv sync` once more.

- [ ] **Step 2: Configure pytest in `api/pyproject.toml`**

Append to `api/pyproject.toml`:
```toml
[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]
```

- [ ] **Step 3: Write the failing test**

Create `api/tests/__init__.py` (empty) and `api/tests/test_config.py`:
```python
"""Settings additions for the job queue."""

from app.core.config import Settings


def test_queue_settings_defaults():
    settings = Settings(_env_file=None)
    assert settings.rabbitmq_url == "amqp://guest:guest@localhost:5672/"
    assert settings.result_ttl_minutes == 30
    assert settings.job_concurrency == 3
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_config.py -v`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'rabbitmq_url'` (pydantic raises on unknown attrs at access time).

- [ ] **Step 5: Add the settings fields**

In `api/app/core/config.py`, after the `max_upload_mb` field (line 21), insert:
```python
    # AMQP URL of the RabbitMQ broker that carries the job queue.
    rabbitmq_url: str = "amqp://guest:guest@localhost:5672/"

    # Finished job results are kept this long before being swept from disk.
    result_ttl_minutes: int = 30

    # How many jobs may be processed at the same time (RabbitMQ prefetch count).
    job_concurrency: int = 3
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_config.py -v`
Expected: PASS (1 passed).

- [ ] **Step 7: Commit**

```bash
git add api/pyproject.toml api/uv.lock api/app/core/config.py api/tests/
git commit -m "Add aio-pika, pytest, and queue settings to the API"
```

---

### Task 2: Job registry

**Files:**
- Create: `api/app/jobs/__init__.py` (empty)
- Create: `api/app/jobs/registry.py`
- Test: `api/tests/test_registry.py`

**Interfaces:**
- Produces (used by every later api task):
  - `JobStatus` str-enum: `queued|processing|done|failed`
  - `JobRecord` dataclass — fields exactly as coded below
  - `JobRegistry(result_ttl_seconds: float = 1800)` with methods `create(*, tool, workspace, file_count, total_bytes, params) -> JobRecord`, `get(job_id) -> JobRecord | None`, `discard(job_id) -> None`, `position(job_id) -> int | None`, `queue_size() -> int`, `processing() -> list[JobRecord]`, `waiting() -> list[JobRecord]`, `sweep(now: float | None = None) -> int`

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_registry.py`:
```python
"""Behavior of the in-process job registry: ordering, position, TTL sweep."""

import time

from app.jobs.registry import JobRegistry, JobStatus


def make_job(registry, tmp_path, name):
    workspace = tmp_path / name
    workspace.mkdir()
    return registry.create(
        tool="compress", workspace=workspace, file_count=1, total_bytes=100, params={}
    )


def test_position_is_one_based_and_ordered(tmp_path):
    registry = JobRegistry()
    first = make_job(registry, tmp_path, "a")
    second = make_job(registry, tmp_path, "b")
    assert registry.position(first.id) == 1
    assert registry.position(second.id) == 2
    assert registry.queue_size() == 2


def test_position_skips_non_queued_jobs(tmp_path):
    registry = JobRegistry()
    first = make_job(registry, tmp_path, "a")
    second = make_job(registry, tmp_path, "b")
    first.status = JobStatus.processing
    assert registry.position(first.id) is None
    assert registry.position(second.id) == 1
    assert registry.queue_size() == 1
    assert [r.id for r in registry.processing()] == [first.id]
    assert [r.id for r in registry.waiting()] == [second.id]


def test_position_unknown_job_is_none(tmp_path):
    registry = JobRegistry()
    assert registry.position("nope") is None
    assert registry.get("nope") is None


def test_discard_removes_job_and_workspace(tmp_path):
    registry = JobRegistry()
    record = make_job(registry, tmp_path, "a")
    assert record.workspace.exists()
    registry.discard(record.id)
    assert registry.get(record.id) is None
    assert not record.workspace.exists()


def test_sweep_removes_only_expired_finished_jobs(tmp_path):
    registry = JobRegistry(result_ttl_seconds=1800)
    old = make_job(registry, tmp_path, "old")
    fresh = make_job(registry, tmp_path, "fresh")
    queued = make_job(registry, tmp_path, "queued")
    now = time.time()
    old.status = JobStatus.done
    old.finished_at = now - 3600
    fresh.status = JobStatus.failed
    fresh.finished_at = now - 60
    removed = registry.sweep(now=now)
    assert removed == 1
    assert registry.get(old.id) is None
    assert not old.workspace.exists()
    assert registry.get(fresh.id) is not None
    assert registry.get(queued.id) is not None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.jobs'`.

- [ ] **Step 3: Implement the registry**

Create empty `api/app/jobs/__init__.py`, then `api/app/jobs/registry.py`:
```python
"""In-process job registry: the single source of truth for job state and order.

RabbitMQ carries the work, but it cannot answer "where am I in line?", so the
registry keeps an insertion-ordered record of every job in this process. The
app runs a single uvicorn process with one replica, so no cross-process
coherence is needed.
"""

from __future__ import annotations

import shutil
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class JobStatus(str, Enum):
    queued = "queued"
    processing = "processing"
    done = "done"
    failed = "failed"


@dataclass
class JobRecord:
    """Everything the API needs to report on and finish one job.

    `params` may hold passwords, so records must never be logged or serialized
    wholesale; only the fields exposed by the schemas leave the process.
    """

    id: str
    tool: str
    workspace: Path
    file_count: int
    total_bytes: int
    params: dict[str, Any] = field(default_factory=dict)
    status: JobStatus = JobStatus.queued
    error: str | None = None
    result_path: Path | None = None
    download_name: str | None = None
    media_type: str | None = None
    result_headers: dict[str, str] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None


class JobRegistry:
    """Insertion-ordered job store with TTL-based cleanup of finished jobs."""

    def __init__(self, result_ttl_seconds: float = 30 * 60) -> None:
        self._jobs: dict[str, JobRecord] = {}
        self._ttl = result_ttl_seconds

    def create(
        self,
        *,
        tool: str,
        workspace: Path,
        file_count: int,
        total_bytes: int,
        params: dict[str, Any],
    ) -> JobRecord:
        record = JobRecord(
            id=uuid.uuid4().hex,
            tool=tool,
            workspace=workspace,
            file_count=file_count,
            total_bytes=total_bytes,
            params=params,
        )
        self._jobs[record.id] = record
        return record

    def get(self, job_id: str) -> JobRecord | None:
        return self._jobs.get(job_id)

    def discard(self, job_id: str) -> None:
        """Remove a job and its workspace (e.g. when enqueueing failed)."""
        record = self._jobs.pop(job_id, None)
        if record is not None:
            shutil.rmtree(record.workspace, ignore_errors=True)

    def position(self, job_id: str) -> int | None:
        """1-based place among queued jobs; None once started or unknown."""
        record = self._jobs.get(job_id)
        if record is None or record.status is not JobStatus.queued:
            return None
        place = 1
        for other in self._jobs.values():
            if other.id == job_id:
                return place
            if other.status is JobStatus.queued:
                place += 1
        return None

    def queue_size(self) -> int:
        return sum(1 for r in self._jobs.values() if r.status is JobStatus.queued)

    def processing(self) -> list[JobRecord]:
        return [r for r in self._jobs.values() if r.status is JobStatus.processing]

    def waiting(self) -> list[JobRecord]:
        return [r for r in self._jobs.values() if r.status is JobStatus.queued]

    def sweep(self, now: float | None = None) -> int:
        """Delete finished jobs past the TTL, workspace included."""
        now = time.time() if now is None else now
        expired = [
            r
            for r in self._jobs.values()
            if r.finished_at is not None and now - r.finished_at >= self._ttl
        ]
        for record in expired:
            shutil.rmtree(record.workspace, ignore_errors=True)
            del self._jobs[record.id]
        return len(expired)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_registry.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add api/app/jobs/ api/tests/test_registry.py
git commit -m "Add in-process job registry with position tracking and TTL sweep"
```

---

### Task 3: RabbitMQ queue module

**Files:**
- Create: `api/app/jobs/queue.py`
- Test: `api/tests/test_queue.py`

**Interfaces:**
- Produces:
  - `QUEUE_NAME = "pdf-jobs"`
  - `QueueUnavailableError(RuntimeError)`
  - `encode_job(job_id: str) -> bytes`, `decode_job(body: bytes) -> str | None`
  - `JobQueue(url: str, prefetch: int = 3)` with `async connect()`, `ready: bool` property, `async publish(job_id)` (raises `QueueUnavailableError` when not connected), `async start_consumer(handler)` where `handler: Callable[[str], Awaitable[None]]`, `async close()`

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_queue.py`:
```python
"""Message framing and unavailable-broker behavior for the job queue."""

import asyncio

import pytest

from app.jobs.queue import JobQueue, QueueUnavailableError, decode_job, encode_job


def test_encode_decode_roundtrip():
    job_id = "abc123"
    assert decode_job(encode_job(job_id)) == "abc123"


def test_decode_rejects_garbage():
    assert decode_job(b"not json") is None
    assert decode_job(b"{}") is None
    assert decode_job(b'{"job_id": ""}') is None


def test_publish_before_connect_raises():
    queue = JobQueue("amqp://guest:guest@localhost:5672/")
    assert queue.ready is False
    with pytest.raises(QueueUnavailableError):
        asyncio.run(queue.publish("abc123"))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_queue.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.jobs.queue'`.

- [ ] **Step 3: Implement the queue module**

Create `api/app/jobs/queue.py`:
```python
"""RabbitMQ plumbing: one durable queue carries job ids to the consumer.

Only the job id crosses the broker — files stay on local disk and passwords
stay in the in-process registry, so a 200 MB upload or a secret never has to
survive a trip through AMQP.
"""

from __future__ import annotations

import json
import logging
from typing import Awaitable, Callable

import aio_pika

logger = logging.getLogger(__name__)

QUEUE_NAME = "pdf-jobs"


class QueueUnavailableError(RuntimeError):
    """Raised when publishing is attempted while the broker is unreachable."""


def encode_job(job_id: str) -> bytes:
    return json.dumps({"job_id": job_id}).encode()


def decode_job(body: bytes) -> str | None:
    """Extract the job id from a message body, or None if malformed."""
    try:
        payload = json.loads(body.decode())
    except (ValueError, UnicodeDecodeError):
        return None
    job_id = payload.get("job_id") if isinstance(payload, dict) else None
    return job_id or None


class JobQueue:
    """Thin lifecycle wrapper around one robust connection + one durable queue."""

    def __init__(self, url: str, prefetch: int = 3) -> None:
        self._url = url
        self._prefetch = prefetch
        self._connection: aio_pika.abc.AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractChannel | None = None
        self._queue: aio_pika.abc.AbstractQueue | None = None

    @property
    def ready(self) -> bool:
        return self._queue is not None

    async def connect(self) -> None:
        self._connection = await aio_pika.connect_robust(self._url)
        self._channel = await self._connection.channel()
        # prefetch_count bounds unacked deliveries, which bounds concurrency:
        # aio-pika runs each delivery's callback as its own task.
        await self._channel.set_qos(prefetch_count=self._prefetch)
        self._queue = await self._channel.declare_queue(QUEUE_NAME, durable=True)

    async def publish(self, job_id: str) -> None:
        if self._channel is None or self._queue is None:
            raise QueueUnavailableError("The job queue is not connected.")
        await self._channel.default_exchange.publish(
            aio_pika.Message(
                body=encode_job(job_id),
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            ),
            routing_key=QUEUE_NAME,
        )

    async def start_consumer(self, handler: Callable[[str], Awaitable[None]]) -> None:
        if self._queue is None:
            raise QueueUnavailableError("The job queue is not connected.")

        async def on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
            # process() acks on normal exit and rejects (without requeue) if the
            # handler raises — job failures are recorded on the registry by the
            # worker, so any exception here is terminal by design (no loops).
            async with message.process():
                job_id = decode_job(message.body)
                if job_id is None:
                    logger.warning("Dropping malformed queue message")
                    return
                await handler(job_id)

        await self._queue.consume(on_message)

    async def close(self) -> None:
        if self._connection is not None:
            await self._connection.close()
        self._connection = None
        self._channel = None
        self._queue = None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_queue.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add api/app/jobs/queue.py api/tests/test_queue.py
git commit -m "Add RabbitMQ job queue wrapper with durable pdf-jobs queue"
```

---

### Task 4: Worker execution

**Files:**
- Create: `api/app/jobs/worker.py`
- Test: `api/tests/test_worker.py`

**Interfaces:**
- Consumes: `JobRegistry`, `JobRecord`, `JobStatus` from Task 2; existing service functions.
- Produces: `async execute_job(registry: JobRegistry, job_id: str) -> None` (the consumer handler body) and `run_job(record: JobRecord) -> None` (sync dispatch; raises service errors).
- Params contract (set by Task 5's endpoints, consumed here — exact keys):
  - compress: `{"quality": "<CompressionQuality value>", "names": ["a.pdf", ...]}`; inputs at `workspace/input-{i}.pdf`
  - lock: `{"password": str, "allow_printing": bool, "allow_copying": bool, "allow_editing": bool, "encryption": "<EncryptionLevel value>", "name": "a.pdf"}`; input at `workspace/input.pdf`
  - unlock: `{"password": str, "name": "a.pdf"}`; input at `workspace/input.pdf`

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_worker.py`:
```python
"""Worker execution against the real (pikepdf-backed) lock/unlock services."""

import asyncio

import pikepdf

from app.jobs.registry import JobRegistry, JobStatus
from app.jobs.worker import execute_job


def write_blank_pdf(path):
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(path)
    pdf.close()


def test_lock_job_succeeds(tmp_path):
    registry = JobRegistry()
    workspace = tmp_path / "job"
    workspace.mkdir()
    write_blank_pdf(workspace / "input.pdf")
    record = registry.create(
        tool="lock",
        workspace=workspace,
        file_count=1,
        total_bytes=(workspace / "input.pdf").stat().st_size,
        params={
            "password": "secret",
            "allow_printing": True,
            "allow_copying": False,
            "allow_editing": False,
            "encryption": "aes-256",
            "name": "report.pdf",
        },
    )
    asyncio.run(execute_job(registry, record.id))
    assert record.status is JobStatus.done
    assert record.error is None
    assert record.result_path is not None and record.result_path.exists()
    assert record.download_name == "locked-report.pdf"
    assert record.media_type == "application/pdf"
    assert record.finished_at is not None


def test_unlock_job_with_wrong_password_fails_gracefully(tmp_path):
    registry = JobRegistry()
    workspace = tmp_path / "job"
    workspace.mkdir()
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(
        workspace / "input.pdf",
        encryption=pikepdf.Encryption(owner="right", user="right", R=6),
    )
    pdf.close()
    record = registry.create(
        tool="unlock",
        workspace=workspace,
        file_count=1,
        total_bytes=(workspace / "input.pdf").stat().st_size,
        params={"password": "wrong", "name": "report.pdf"},
    )
    asyncio.run(execute_job(registry, record.id))
    assert record.status is JobStatus.failed
    assert record.error is not None
    assert record.finished_at is not None


def test_unknown_job_id_is_ignored():
    registry = JobRegistry()
    asyncio.run(execute_job(registry, "missing"))  # must not raise
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_worker.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.jobs.worker'`.

- [ ] **Step 3: Implement the worker**

Create `api/app/jobs/worker.py`:
```python
"""Executes queued jobs by dispatching to the existing service functions.

The services are synchronous (Ghostscript subprocesses / pikepdf CPU work), so
`execute_job` pushes them onto a worker thread to keep the event loop — and the
HTTP endpoints — responsive while up to three jobs run.
"""

from __future__ import annotations

import asyncio
import logging
import time
import zipfile

from app.jobs.registry import JobRecord, JobRegistry, JobStatus
from app.services.compress import (
    CompressionError,
    CompressionQuality,
    GhostscriptNotInstalledError,
    compress_pdf_file,
)
from app.services.lock import (
    AlreadyProtectedError,
    EncryptionLevel,
    LockError,
    lock_pdf_file,
)
from app.services.unlock import (
    IncorrectPasswordError,
    NotEncryptedError,
    UnlockError,
    unlock_pdf_file,
)

logger = logging.getLogger(__name__)

# Failures with a message we can show the user verbatim, mirroring the old
# synchronous endpoints' 422/503 details.
_KNOWN_ERRORS = (
    CompressionError,
    GhostscriptNotInstalledError,
    AlreadyProtectedError,
    LockError,
    IncorrectPasswordError,
    NotEncryptedError,
    UnlockError,
)


def _run_compress(record: JobRecord) -> None:
    names: list[str] = record.params["names"]
    quality = CompressionQuality(record.params["quality"])
    total_original = 0
    total_compressed = 0
    outputs: list[tuple] = []
    for index, name in enumerate(names):
        input_path = record.workspace / f"input-{index}.pdf"
        output_path = record.workspace / f"output-{index}.pdf"
        stats = compress_pdf_file(input_path, output_path, quality)
        total_original += stats.original_size
        total_compressed += stats.compressed_size
        outputs.append((output_path, name))

    record.result_headers = {
        "X-Original-Size": str(total_original),
        "X-Compressed-Size": str(total_compressed),
    }
    if len(outputs) == 1:
        record.result_path, record.download_name = outputs[0]
        record.media_type = "application/pdf"
        return

    archive_path = record.workspace / "compressed-pdfs.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for output_path, name in outputs:
            archive.write(output_path, arcname=name)
    record.result_path = archive_path
    record.download_name = "compressed-pdfs.zip"
    record.media_type = "application/zip"


def _run_lock(record: JobRecord) -> None:
    name: str = record.params["name"]
    input_path = record.workspace / "input.pdf"
    output_path = record.workspace / "output.pdf"
    lock_pdf_file(
        input_path,
        output_path,
        record.params["password"],
        allow_printing=record.params["allow_printing"],
        allow_copying=record.params["allow_copying"],
        allow_editing=record.params["allow_editing"],
        encryption=EncryptionLevel(record.params["encryption"]),
    )
    record.result_path = output_path
    record.download_name = name if name.startswith("locked-") else f"locked-{name}"
    record.media_type = "application/pdf"


def _run_unlock(record: JobRecord) -> None:
    name: str = record.params["name"]
    input_path = record.workspace / "input.pdf"
    output_path = record.workspace / "output.pdf"
    unlock_pdf_file(input_path, output_path, record.params["password"])
    record.result_path = output_path
    record.download_name = name if name.startswith("unlocked-") else f"unlocked-{name}"
    record.media_type = "application/pdf"


_RUNNERS = {"compress": _run_compress, "lock": _run_lock, "unlock": _run_unlock}


def run_job(record: JobRecord) -> None:
    """Synchronously execute one job; raises service errors on failure."""
    runner = _RUNNERS.get(record.tool)
    if runner is None:
        raise ValueError(f"Unknown tool '{record.tool}'")
    runner(record)


async def execute_job(registry: JobRegistry, job_id: str) -> None:
    """Consumer handler: run one job and record the outcome on the registry."""
    record = registry.get(job_id)
    if record is None:
        # Message survived a redeploy but the registry/workspace did not.
        logger.warning("Dropping job %s with no registry entry", job_id)
        return

    record.status = JobStatus.processing
    record.started_at = time.time()
    try:
        await asyncio.to_thread(run_job, record)
    except _KNOWN_ERRORS as exc:
        record.status = JobStatus.failed
        record.error = str(exc)
    except Exception:
        logger.exception("Job %s crashed", job_id)
        record.status = JobStatus.failed
        record.error = "Something went wrong while processing this file."
    else:
        record.status = JobStatus.done
    finally:
        record.finished_at = time.time()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_worker.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add api/app/jobs/worker.py api/tests/test_worker.py
git commit -m "Add job worker executing service functions on worker threads"
```

---

### Task 5: Response schemas and submit endpoints

**Files:**
- Create: `api/app/jobs/schemas.py`
- Modify: `api/app/routers/pdf.py` (replace the three handler bodies; keep `_stream_upload_to_disk` and `_safe_name` as they are)
- Test: `api/tests/test_submit_endpoints.py`, plus shared fixtures in `api/tests/conftest.py`

**Interfaces:**
- Consumes: `JobRegistry` (Task 2), `QueueUnavailableError` (Task 3).
- Produces:
  - Pydantic models `JobAccepted {job_id, position, queue_size}`, `JobStatusResponse {id, tool, status, position, queue_size, error, file_count, total_bytes, created_at}`, `BoardEntry {id_prefix, tool, file_count, total_bytes, created_at}`, `QueueBoard {concurrency, processing, waiting}` in `app/jobs/schemas.py`.
  - `POST /pdf/compress|lock|unlock` → 202 `JobAccepted`; 503 when the queue is down.
  - Test fixtures `client` (TestClient with fresh registry + `FakeQueue` on `app.state`) and `pdf_bytes` used by Task 6's tests too.

- [ ] **Step 1: Write the schemas**

Create `api/app/jobs/schemas.py`:
```python
"""Response models for job submission, status polling, and the queue board."""

from __future__ import annotations

from pydantic import BaseModel

from app.jobs.registry import JobStatus


class JobAccepted(BaseModel):
    job_id: str
    position: int | None
    queue_size: int


class JobStatusResponse(BaseModel):
    id: str
    tool: str
    status: JobStatus
    position: int | None
    queue_size: int
    error: str | None
    file_count: int
    total_bytes: int
    created_at: float


class BoardEntry(BaseModel):
    """Anonymized public view of one job. Never includes filenames."""

    id_prefix: str
    tool: str
    file_count: int
    total_bytes: int
    created_at: float


class QueueBoard(BaseModel):
    concurrency: int
    processing: list[BoardEntry]
    waiting: list[BoardEntry]
```

- [ ] **Step 2: Write the shared test fixtures**

Create `api/tests/conftest.py`:
```python
"""Shared fixtures: a TestClient with a fresh registry and a fake queue.

The TestClient is used without its context manager so the app lifespan (which
connects to RabbitMQ) never runs; app.state is populated by hand instead.
"""

import pikepdf
import pytest
from fastapi.testclient import TestClient

from app.jobs.queue import QueueUnavailableError
from app.jobs.registry import JobRegistry
from app.main import app


class FakeQueue:
    def __init__(self) -> None:
        self.published: list[str] = []
        self.ready = True

    async def publish(self, job_id: str) -> None:
        if not self.ready:
            raise QueueUnavailableError("queue down")
        self.published.append(job_id)


@pytest.fixture
def fake_queue() -> FakeQueue:
    return FakeQueue()


@pytest.fixture
def registry() -> JobRegistry:
    return JobRegistry()


@pytest.fixture
def client(registry, fake_queue) -> TestClient:
    app.state.registry = registry
    app.state.job_queue = fake_queue
    return TestClient(app)


@pytest.fixture
def pdf_bytes(tmp_path) -> bytes:
    path = tmp_path / "sample.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(path)
    pdf.close()
    return path.read_bytes()
```

- [ ] **Step 3: Write the failing endpoint tests**

Create `api/tests/test_submit_endpoints.py`:
```python
"""Submit endpoints return 202 + a queued job instead of processing inline."""

from app.jobs.registry import JobStatus


def test_compress_returns_202_with_position(client, registry, fake_queue, pdf_bytes):
    response = client.post(
        "/pdf/compress",
        files=[("files", ("a.pdf", pdf_bytes, "application/pdf"))],
        data={"quality": "ebook"},
    )
    assert response.status_code == 202
    body = response.json()
    record = registry.get(body["job_id"])
    assert record is not None
    assert record.tool == "compress"
    assert record.status is JobStatus.queued
    assert record.params["quality"] == "ebook"
    assert record.params["names"] == ["a.pdf"]
    assert (record.workspace / "input-0.pdf").exists()
    assert body["position"] == 1
    assert body["queue_size"] == 1
    assert fake_queue.published == [body["job_id"]]


def test_lock_stores_params_and_input(client, registry, pdf_bytes):
    response = client.post(
        "/pdf/lock",
        files={"file": ("b.pdf", pdf_bytes, "application/pdf")},
        data={"password": "pw", "encryption": "aes-256"},
    )
    assert response.status_code == 202
    record = registry.get(response.json()["job_id"])
    assert record.tool == "lock"
    assert record.params["password"] == "pw"
    assert record.params["name"] == "b.pdf"
    assert (record.workspace / "input.pdf").exists()


def test_unlock_requires_valid_pdf(client):
    response = client.post(
        "/pdf/unlock",
        files={"file": ("evil.pdf", b"not a pdf", "application/pdf")},
        data={"password": "pw"},
    )
    assert response.status_code == 400


def test_queue_down_returns_503_and_cleans_up(client, registry, fake_queue, pdf_bytes):
    fake_queue.ready = False
    response = client.post(
        "/pdf/unlock",
        files={"file": ("a.pdf", pdf_bytes, "application/pdf")},
        data={"password": "pw"},
    )
    assert response.status_code == 503
    assert registry.queue_size() == 0
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_submit_endpoints.py -v`
Expected: FAIL — compress returns 200 (or 503 Ghostscript) instead of 202, etc. Any failure mode is fine; the endpoints are still synchronous.

- [ ] **Step 5: Rewrite the endpoint bodies in `api/app/routers/pdf.py`**

Replace the imports block and the three handlers (keep `_stream_upload_to_disk`, `_safe_name`, `router`, `_MAX_UPLOAD_BYTES`, `_CHUNK_SIZE`). The full new file:
```python
"""Routes for PDF actions. Submissions are queued, not processed inline."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any, List

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from app.core.config import settings
from app.jobs.queue import QueueUnavailableError
from app.jobs.schemas import JobAccepted
from app.services.compress import CompressionQuality
from app.services.lock import EncryptionLevel

router = APIRouter(prefix="/pdf", tags=["pdf"])

# Guard rail so a single request can't exhaust the server.
_MAX_UPLOAD_BYTES = settings.max_upload_mb * 1024 * 1024

# Uploads are streamed to disk in chunks of this size to keep memory bounded.
_CHUNK_SIZE = 1024 * 1024


async def _stream_upload_to_disk(file: UploadFile, dest: Path) -> None:
    """Write an uploaded file to `dest` in chunks, validating it as a PDF.

    Enforces the PDF magic bytes and the size limit while streaming, so we never
    hold the whole file in memory and reject oversized uploads early.
    """
    size = 0
    is_first_chunk = True
    with dest.open("wb") as out:
        while True:
            chunk = await file.read(_CHUNK_SIZE)
            if not chunk:
                break
            if is_first_chunk:
                # PDFs always start with the '%PDF' magic bytes.
                if not chunk.startswith(b"%PDF"):
                    raise HTTPException(
                        status_code=400, detail=f"'{file.filename}' is not a valid PDF."
                    )
                is_first_chunk = False
            size += len(chunk)
            if size > _MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"'{file.filename}' exceeds the {settings.max_upload_mb} MB limit.",
                )
            out.write(chunk)

    if size == 0:
        raise HTTPException(status_code=400, detail=f"'{file.filename}' is empty.")


def _safe_name(filename: str | None, fallback: str) -> str:
    """Reduce an uploaded filename to a safe basename for use on disk and in ZIPs."""
    name = Path(filename or fallback).name
    return name or fallback


async def _accept_job(
    request: Request,
    *,
    tool: str,
    workspace: Path,
    file_count: int,
    total_bytes: int,
    params: dict[str, Any],
) -> JobAccepted:
    """Register the job and publish it; 503 (with cleanup) if the broker is down."""
    registry = request.app.state.registry
    job_queue = request.app.state.job_queue
    record = registry.create(
        tool=tool,
        workspace=workspace,
        file_count=file_count,
        total_bytes=total_bytes,
        params=params,
    )
    try:
        await job_queue.publish(record.id)
    except QueueUnavailableError as exc:
        registry.discard(record.id)
        raise HTTPException(
            status_code=503,
            detail="The processing queue is unavailable right now. Please try again shortly.",
        ) from exc
    return JobAccepted(
        job_id=record.id,
        position=registry.position(record.id),
        queue_size=registry.queue_size(),
    )


@router.post(
    "/compress",
    status_code=202,
    summary="Queue one or more PDF files for compression",
    response_model=JobAccepted,
)
async def compress(
    request: Request,
    files: List[UploadFile] = File(..., description="One or more PDF files to compress."),
    quality: CompressionQuality = Form(
        CompressionQuality.ebook,
        description="Compression preset; 'screen' is smallest, 'prepress' is highest quality.",
    ),
) -> JobAccepted:
    """Validate and store the uploads, then queue a compression job."""
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded.")

    work_dir = Path(tempfile.mkdtemp(prefix="chowbea-compress-"))
    try:
        names: list[str] = []
        total_bytes = 0
        for index, file in enumerate(files):
            input_path = work_dir / f"input-{index}.pdf"
            await _stream_upload_to_disk(file, input_path)
            names.append(_safe_name(file.filename, f"document-{index + 1}.pdf"))
            total_bytes += input_path.stat().st_size
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    return await _accept_job(
        request,
        tool="compress",
        workspace=work_dir,
        file_count=len(names),
        total_bytes=total_bytes,
        params={"quality": quality.value, "names": names},
    )


@router.post(
    "/unlock",
    status_code=202,
    summary="Queue a password removal job for a PDF file",
    response_model=JobAccepted,
)
async def unlock(
    request: Request,
    file: UploadFile = File(..., description="A password-protected PDF to unlock."),
    password: str = Form(..., description="The password that opens the PDF."),
) -> JobAccepted:
    """Validate and store the upload, then queue an unlock job."""
    work_dir = Path(tempfile.mkdtemp(prefix="chowbea-unlock-"))
    try:
        input_path = work_dir / "input.pdf"
        await _stream_upload_to_disk(file, input_path)
        total_bytes = input_path.stat().st_size
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    return await _accept_job(
        request,
        tool="unlock",
        workspace=work_dir,
        file_count=1,
        total_bytes=total_bytes,
        params={"password": password, "name": _safe_name(file.filename, "document.pdf")},
    )


@router.post(
    "/lock",
    status_code=202,
    summary="Queue a password protection job for a PDF file",
    response_model=JobAccepted,
)
async def lock(
    request: Request,
    file: UploadFile = File(..., description="A PDF to password-protect."),
    password: str = Form(..., description="The password that will be required to open the PDF."),
    allow_printing: bool = Form(True, description="Permit printing the locked PDF."),
    allow_copying: bool = Form(False, description="Permit copying/extracting text from the PDF."),
    allow_editing: bool = Form(False, description="Permit editing and annotating the PDF."),
    encryption: EncryptionLevel = Form(
        EncryptionLevel.aes256,
        description="Encryption strength; 'aes-256' is strongest.",
    ),
) -> JobAccepted:
    """Validate and store the upload, then queue a lock job."""
    if not password:
        raise HTTPException(status_code=400, detail="A password is required to lock the PDF.")

    work_dir = Path(tempfile.mkdtemp(prefix="chowbea-lock-"))
    try:
        input_path = work_dir / "input.pdf"
        await _stream_upload_to_disk(file, input_path)
        total_bytes = input_path.stat().st_size
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    return await _accept_job(
        request,
        tool="lock",
        workspace=work_dir,
        file_count=1,
        total_bytes=total_bytes,
        params={
            "password": password,
            "allow_printing": allow_printing,
            "allow_copying": allow_copying,
            "allow_editing": allow_editing,
            "encryption": encryption.value,
            "name": _safe_name(file.filename, "document.pdf"),
        },
    )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_submit_endpoints.py -v`
Expected: PASS (4 passed). Also run the full suite: `uv run pytest -v` — all green.

- [ ] **Step 7: Commit**

```bash
git add api/app/jobs/schemas.py api/app/routers/pdf.py api/tests/conftest.py api/tests/test_submit_endpoints.py
git commit -m "Queue PDF submissions instead of processing them inline"
```

---

### Task 6: Job status, download, and queue board endpoints

**Files:**
- Create: `api/app/routers/jobs.py`
- Modify: `api/app/main.py` (include the new router — lifespan comes in Task 7)
- Test: `api/tests/test_job_endpoints.py`

**Interfaces:**
- Consumes: registry/schemas from Tasks 2 & 5; `settings.job_concurrency`.
- Produces: `GET /jobs/{job_id}` → `JobStatusResponse` | 404; `GET /jobs/{job_id}/download` → file | 404 | 409; `GET /queue` → `QueueBoard`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_job_endpoints.py`:
```python
"""Status polling, result download, and the public queue board."""

from app.jobs.registry import JobStatus


def submit_lock(client, pdf_bytes, name="a.pdf"):
    response = client.post(
        "/pdf/lock",
        files={"file": (name, pdf_bytes, "application/pdf")},
        data={"password": "pw"},
    )
    assert response.status_code == 202
    return response.json()["job_id"]


def test_status_reports_position_and_queue_size(client, registry, pdf_bytes):
    first = submit_lock(client, pdf_bytes)
    second = submit_lock(client, pdf_bytes)
    response = client.get(f"/jobs/{second}")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "queued"
    assert body["position"] == 2
    assert body["queue_size"] == 2
    assert body["error"] is None
    assert body["tool"] == "lock"
    assert first != second


def test_status_unknown_job_is_404(client):
    assert client.get("/jobs/deadbeef").status_code == 404


def test_download_before_done_is_409(client, registry, pdf_bytes):
    job_id = submit_lock(client, pdf_bytes)
    assert client.get(f"/jobs/{job_id}/download").status_code == 409


def test_download_after_done_streams_result(client, registry, pdf_bytes):
    job_id = submit_lock(client, pdf_bytes)
    record = registry.get(job_id)
    result = record.workspace / "output.pdf"
    result.write_bytes(b"%PDF-fake")
    record.status = JobStatus.done
    record.result_path = result
    record.download_name = "locked-a.pdf"
    record.media_type = "application/pdf"
    record.result_headers = {"X-Original-Size": "9"}
    response = client.get(f"/jobs/{job_id}/download")
    assert response.status_code == 200
    assert response.content == b"%PDF-fake"
    assert response.headers["x-original-size"] == "9"
    assert "locked-a.pdf" in response.headers["content-disposition"]


def test_queue_board_is_anonymized(client, registry, pdf_bytes):
    job_id = submit_lock(client, pdf_bytes, name="secret-salary-data.pdf")
    registry.get(job_id).status = JobStatus.processing
    waiting_id = submit_lock(client, pdf_bytes)
    board = client.get("/queue").json()
    assert board["concurrency"] == 3
    assert [e["id_prefix"] for e in board["processing"]] == [job_id[:6]]
    assert [e["id_prefix"] for e in board["waiting"]] == [waiting_id[:6]]
    assert "secret" not in board["processing"][0].get("name", "")
    assert "name" not in board["processing"][0]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_job_endpoints.py -v`
Expected: FAIL — 404 on `/jobs/...` and `/queue` (routes don't exist).

- [ ] **Step 3: Implement the router**

Create `api/app/routers/jobs.py`:
```python
"""Job status polling, result downloads, and the public queue board."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from app.core.config import settings
from app.jobs.registry import JobRecord, JobStatus
from app.jobs.schemas import BoardEntry, JobStatusResponse, QueueBoard

router = APIRouter(tags=["jobs"])


def _get_record(request: Request, job_id: str) -> JobRecord:
    record = request.app.state.registry.get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Job not found or expired.")
    return record


@router.get("/jobs/{job_id}", summary="Poll a job's status", response_model=JobStatusResponse)
def job_status(request: Request, job_id: str) -> JobStatusResponse:
    registry = request.app.state.registry
    record = _get_record(request, job_id)
    return JobStatusResponse(
        id=record.id,
        tool=record.tool,
        status=record.status,
        position=registry.position(record.id),
        queue_size=registry.queue_size(),
        error=record.error,
        file_count=record.file_count,
        total_bytes=record.total_bytes,
        created_at=record.created_at,
    )


@router.get("/jobs/{job_id}/download", summary="Download a finished job's result")
def job_download(request: Request, job_id: str) -> FileResponse:
    record = _get_record(request, job_id)
    if record.status is not JobStatus.done or record.result_path is None:
        raise HTTPException(
            status_code=409,
            detail=record.error or "This job has not finished yet.",
        )
    return FileResponse(
        record.result_path,
        media_type=record.media_type or "application/octet-stream",
        filename=record.download_name or "result",
        headers=record.result_headers,
    )


def _board_entry(record: JobRecord) -> BoardEntry:
    return BoardEntry(
        id_prefix=record.id[:6],
        tool=record.tool,
        file_count=record.file_count,
        total_bytes=record.total_bytes,
        created_at=record.created_at,
    )


@router.get("/queue", summary="Public queue board", response_model=QueueBoard)
def queue_board(request: Request) -> QueueBoard:
    registry = request.app.state.registry
    return QueueBoard(
        concurrency=settings.job_concurrency,
        processing=[_board_entry(r) for r in registry.processing()],
        waiting=[_board_entry(r) for r in registry.waiting()],
    )
```

In `api/app/main.py`, change the router import and registration:
```python
from app.routers import jobs, pdf
```
and after `app.include_router(pdf.router)` add:
```python
app.include_router(jobs.router)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest -v`
Expected: PASS — full suite green.

- [ ] **Step 5: Commit**

```bash
git add api/app/routers/jobs.py api/app/main.py api/tests/test_job_endpoints.py
git commit -m "Add job status, download, and queue board endpoints"
```

---

### Task 7: App lifespan — consumer, sweeper, graceful degradation

**Files:**
- Modify: `api/app/main.py`
- Test: `api/tests/test_lifespan.py`

**Interfaces:**
- Consumes: `JobRegistry`, `JobQueue`, `execute_job`, `settings.*` from earlier tasks.
- Produces: `app.state.registry` and `app.state.job_queue` are set by the lifespan; the API starts (and `/health` works) even when RabbitMQ is down.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_lifespan.py`:
```python
"""The app must start and serve /health even when RabbitMQ is unreachable."""

from fastapi.testclient import TestClient

from app.main import app


def test_app_starts_and_degrades_without_broker(pdf_bytes):
    # Enter the lifespan for real; localhost:5672 may or may not be running,
    # so only broker-independent behavior is asserted here.
    with TestClient(app) as client:
        assert client.get("/health").json() == {"status": "ok"}
        assert client.get("/queue").status_code == 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_lifespan.py -v`
Expected: FAIL — `AttributeError: 'State' object has no attribute 'registry'` on `/queue` (no lifespan sets state yet).

- [ ] **Step 3: Implement the lifespan in `api/app/main.py`**

Full new file:
```python
"""FastAPI application entrypoint for the Chowbea PDF API."""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.jobs.queue import JobQueue
from app.jobs.registry import JobRegistry
from app.jobs.worker import execute_job
from app.routers import jobs, pdf

logger = logging.getLogger(__name__)


async def _run_queue(job_queue: JobQueue, registry: JobRegistry) -> None:
    """Connect and start consuming, retrying forever so the API can come up
    (and serve 503s on submit) while the broker is unreachable."""

    async def handle(job_id: str) -> None:
        await execute_job(registry, job_id)

    while True:
        try:
            await job_queue.connect()
            await job_queue.start_consumer(handle)
            logger.info("Consuming pdf-jobs with prefetch=%d", settings.job_concurrency)
            return
        except Exception:
            logger.exception("RabbitMQ unavailable; retrying in 5s")
            await asyncio.sleep(5)


async def _sweep_forever(registry: JobRegistry) -> None:
    while True:
        await asyncio.sleep(60)
        removed = registry.sweep()
        if removed:
            logger.info("Swept %d expired job(s)", removed)


@asynccontextmanager
async def lifespan(app: FastAPI):
    registry = JobRegistry(result_ttl_seconds=settings.result_ttl_minutes * 60)
    job_queue = JobQueue(settings.rabbitmq_url, prefetch=settings.job_concurrency)
    app.state.registry = registry
    app.state.job_queue = job_queue
    queue_task = asyncio.create_task(_run_queue(job_queue, registry))
    sweep_task = asyncio.create_task(_sweep_forever(registry))
    try:
        yield
    finally:
        queue_task.cancel()
        sweep_task.cancel()
        await job_queue.close()


# The OpenAPI document produced here is consumed by the web app's `chowbea-axios`
# codegen to generate a fully typed client.
app = FastAPI(title=settings.app_name, version=settings.app_version, lifespan=lifespan)

# Allow the browser-based frontend to call the API during development and in prod.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Original-Size", "X-Compressed-Size", "Content-Disposition"],
)

app.include_router(pdf.router)
app.include_router(jobs.router)


@app.get("/health", tags=["meta"], summary="Liveness check")
def health() -> dict[str, str]:
    """Return a simple status payload used by load balancers and uptime checks."""
    return {"status": "ok"}
```

- [ ] **Step 4: Run the full suite**

Run: `cd api && uv run pytest -v`
Expected: PASS — all tests green. (`test_lifespan` logs a RabbitMQ retry warning if no local broker is running; that's the graceful-degradation path working.)

- [ ] **Step 5: Commit**

```bash
git add api/app/main.py api/tests/test_lifespan.py
git commit -m "Wire queue consumer and TTL sweeper into the app lifespan"
```

---

### Task 8: Makefile rabbit target and local end-to-end verification

**Files:**
- Modify: `Makefile`

**Interfaces:**
- Produces: `make rabbit` — idempotently starts a local RabbitMQ container for `make dev`.

- [ ] **Step 1: Add the target**

In `Makefile`: add `rabbit` to `.PHONY`, add a help line `@echo "  make rabbit    Start a local RabbitMQ container (needed by make dev)"`, and append:
```make
# Local broker for the job queue; management UI at http://localhost:15672 (guest/guest).
rabbit:
	@docker start chowbea-rabbit 2>/dev/null || docker run -d --name chowbea-rabbit \
		-p 5672:5672 -p 15672:15672 rabbitmq:4-management
```

- [ ] **Step 2: Verify end to end locally**

Run each command and check its expected output:
```bash
make rabbit                     # container id or name printed
make dev &                      # api on :8000, vite on :3000 (or run in another terminal)
sleep 6
cd api && uv run python -c "
import pikepdf
pdf = pikepdf.new(); pdf.add_blank_page(); pdf.save('/tmp/sample.pdf'); pdf.close()
print('sample written')" && cd ..
JOB=$(curl -s -F "file=@/tmp/sample.pdf" -F "password=test123" http://localhost:8000/pdf/lock | python3 -c "import json,sys; print(json.load(sys.stdin)['job_id'])")
echo "job=$JOB"
sleep 3
curl -s http://localhost:8000/jobs/$JOB          # expect "status":"done"
curl -s http://localhost:8000/queue              # expect concurrency 3, empty or short lists
curl -s -o /tmp/locked.pdf http://localhost:8000/jobs/$JOB/download && head -c 4 /tmp/locked.pdf
```
Expected final output: `%PDF`.

- [ ] **Step 3: Commit**

```bash
git add Makefile
git commit -m "Add make rabbit target for the local job queue broker"
```

---

### Task 9: Web job-flow machinery (`lib/jobs.ts`) and slimmed `lib/api.ts`

**Files:**
- Create: `web/src/lib/jobs.ts`
- Create: `web/src/lib/jobs.test.ts`
- Modify: `web/src/lib/api.ts` (full rewrite below — per-tool wrappers over the shared flow; public signatures unchanged)

**Interfaces:**
- Consumes: api endpoints from Tasks 5–6.
- Produces (consumed by Task 10's pages):
  - `lib/jobs.ts`: types `JobStatusResponse`, `QueueBoard`, `QueueBoardEntry`, `JobProgress {phase: "uploading"|"queued"|"processing"|"downloading", percent: number|null, position?: number|null, queueSize?: number}`; functions `waitForJob(jobId, opts)`, `fetchJobStatus(jobId)`, `downloadJobResult(jobId, onProgress)`, `runJobFlow({submit, onProgress})`, `fetchQueueBoard()`, `rememberJob(jobId, tool)`, `recallJobIds()`, `API_BASE_URL`
  - `lib/api.ts` keeps its existing exported names and signatures: `compressPdfs`, `unlockPdf`, `lockPdf`, `downloadBlob`, `formatBytes`, `COMPRESSION_QUALITIES`, `ENCRYPTION_LEVELS`, and `CompressionProgress` (now aliasing `JobProgress`, so the phase union gains `"queued"`).

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/jobs.test.ts`:
```ts
import { describe, expect, it } from "vitest"

import type { JobStatusResponse } from "./jobs"
import { waitForJob } from "./jobs"

function status(partial: Partial<JobStatusResponse>): JobStatusResponse {
  return {
    id: "job1",
    tool: "lock",
    status: "queued",
    position: null,
    queue_size: 0,
    error: null,
    file_count: 1,
    total_bytes: 10,
    created_at: 0,
    ...partial,
  }
}

describe("waitForJob", () => {
  it("polls until done and reports queue position", async () => {
    const sequence = [
      status({ status: "queued", position: 2, queue_size: 3 }),
      status({ status: "processing" }),
      status({ status: "done" }),
    ]
    const seen: Array<{ phase: string; position?: number | null }> = []
    const result = await waitForJob("job1", {
      getStatus: async () => sequence.shift()!,
      delayMs: 0,
      onProgress: (p) => seen.push({ phase: p.phase, position: p.position }),
    })
    expect(result.status).toBe("done")
    expect(seen).toEqual([
      { phase: "queued", position: 2 },
      { phase: "processing", position: undefined },
    ])
  })

  it("throws the job's error message when it fails", async () => {
    await expect(
      waitForJob("job1", {
        getStatus: async () => status({ status: "failed", error: "Wrong password." }),
        delayMs: 0,
      }),
    ).rejects.toThrow("Wrong password.")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && bun run test`
Expected: FAIL — cannot resolve `./jobs`.

- [ ] **Step 3: Implement `web/src/lib/jobs.ts`**

```ts
/**
 * Job-queue machinery shared by every tool: submit → poll → download.
 *
 * The API returns 202 + a job id; the browser polls `GET /jobs/{id}` (which
 * carries the queue position) and downloads the result when the job is done.
 */

import axios from "axios"

// Base URL of the API, injected at build time by Vite.
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000"

export type JobState = "queued" | "processing" | "done" | "failed"

export interface JobAccepted {
  job_id: string
  position: number | null
  queue_size: number
}

export interface JobStatusResponse {
  id: string
  tool: string
  status: JobState
  position: number | null
  queue_size: number
  error: string | null
  file_count: number
  total_bytes: number
  created_at: number
}

export interface QueueBoardEntry {
  id_prefix: string
  tool: string
  file_count: number
  total_bytes: number
  created_at: number
}

export interface QueueBoard {
  concurrency: number
  processing: QueueBoardEntry[]
  waiting: QueueBoardEntry[]
}

/** Progress update for the UI; `percent` is null when the phase is indeterminate. */
export interface JobProgress {
  phase: "uploading" | "queued" | "processing" | "downloading"
  percent: number | null
  position?: number | null
  queueSize?: number
}

/** Normalize any axios/API failure into an Error carrying the API's detail. */
export async function toApiError(err: unknown): Promise<Error> {
  if (axios.isAxiosError(err) && err.response) {
    let detail = `Request failed with status ${err.response.status}`
    try {
      const data = err.response.data
      const text = data instanceof Blob ? await data.text() : JSON.stringify(data)
      const parsed = JSON.parse(text)
      if (typeof parsed?.detail === "string") detail = parsed.detail
    } catch {
      // Non-JSON error body; keep the default message.
    }
    return new Error(detail)
  }
  return err instanceof Error ? err : new Error("Something went wrong.")
}

export async function fetchJobStatus(jobId: string): Promise<JobStatusResponse> {
  const response = await axios.get<JobStatusResponse>(`${API_BASE_URL}/jobs/${jobId}`)
  return response.data
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Poll a job until it finishes. Resolves with the final "done" status and
 * rejects with the job's error message when it fails or expires.
 */
export async function waitForJob(
  jobId: string,
  opts: {
    getStatus?: (jobId: string) => Promise<JobStatusResponse>
    delayMs?: number
    onProgress?: (progress: JobProgress) => void
  } = {},
): Promise<JobStatusResponse> {
  const { getStatus = fetchJobStatus, delayMs = 2000, onProgress } = opts
  for (;;) {
    const current = await getStatus(jobId)
    if (current.status === "done") return current
    if (current.status === "failed") {
      throw new Error(current.error ?? "The job failed.")
    }
    if (current.status === "queued") {
      onProgress?.({
        phase: "queued",
        percent: null,
        position: current.position,
        queueSize: current.queue_size,
      })
    } else {
      onProgress?.({ phase: "processing", percent: null })
    }
    await sleep(delayMs)
  }
}

export interface JobDownload {
  blob: Blob
  filename: string | undefined
  headers: Record<string, string | undefined>
}

export async function downloadJobResult(
  jobId: string,
  onProgress?: (progress: JobProgress) => void,
): Promise<JobDownload> {
  const response = await axios.get<Blob>(`${API_BASE_URL}/jobs/${jobId}/download`, {
    responseType: "blob",
    onDownloadProgress: (event) => {
      onProgress?.({
        phase: "downloading",
        percent: event.total ? (event.loaded / event.total) * 100 : null,
      })
    },
  })
  const disposition = response.headers["content-disposition"] as string | undefined
  const match = disposition ? /filename="?([^"]+)"?/.exec(disposition) : null
  return {
    blob: response.data,
    filename: match?.[1],
    headers: {
      "x-original-size": response.headers["x-original-size"],
      "x-compressed-size": response.headers["x-compressed-size"],
    },
  }
}

/** Submit, wait, download — the whole queued-job round trip for one tool. */
export async function runJobFlow(options: {
  submit: () => Promise<JobAccepted>
  tool: string
  onProgress?: (progress: JobProgress) => void
}): Promise<JobDownload> {
  try {
    const accepted = await options.submit()
    rememberJob(accepted.job_id, options.tool)
    options.onProgress?.({
      phase: "queued",
      percent: null,
      position: accepted.position,
      queueSize: accepted.queue_size,
    })
    await waitForJob(accepted.job_id, { onProgress: options.onProgress })
    return await downloadJobResult(accepted.job_id, options.onProgress)
  } catch (err) {
    throw await toApiError(err)
  }
}

export async function fetchQueueBoard(): Promise<QueueBoard> {
  const response = await axios.get<QueueBoard>(`${API_BASE_URL}/queue`)
  return response.data
}

// ── Local memory of "my" jobs, so the queue board can highlight them. ──

const JOBS_STORAGE_KEY = "chowbea:jobs"

interface RememberedJob {
  id: string
  tool: string
  at: number
}

function readRemembered(): RememberedJob[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(JOBS_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as RememberedJob[]) : []
  } catch {
    return []
  }
}

export function rememberJob(jobId: string, tool: string): void {
  if (typeof window === "undefined") return
  // Keep only the most recent handful; results expire server-side in 30 min.
  const kept = readRemembered().slice(-19)
  kept.push({ id: jobId, tool, at: Date.now() })
  window.localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(kept))
}

export function recallJobIds(): string[] {
  return readRemembered().map((job) => job.id)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && bun run test`
Expected: PASS (2 passed).

- [ ] **Step 5: Rewrite `web/src/lib/api.ts` on top of the machinery**

Full new file (public names/signatures preserved; the three copy-pasted catch blocks collapse into the shared flow):
```ts
/**
 * Client helpers for the Chowbea PDF API.
 *
 * Every tool submits a job to the queue and receives the result through the
 * shared submit → poll → download flow in `lib/jobs.ts`. These wrappers keep
 * the per-tool signatures the pages consume.
 */

import axios from "axios"

import type { JobAccepted, JobProgress } from "./jobs"
import { API_BASE_URL, runJobFlow } from "./jobs"

/** Compression presets exposed by the API; ordered smallest to highest quality. */
export const COMPRESSION_QUALITIES = ["screen", "ebook", "printer", "prepress"] as const

export type CompressionQuality = (typeof COMPRESSION_QUALITIES)[number]

/** Progress update for the UI — now includes the queued phase and position. */
export type CompressionProgress = JobProgress

export type CompressionPhase = CompressionProgress["phase"]

/** Result of a successful compression request. */
export interface CompressionResult {
  /** The compressed payload: a PDF for one input, or a ZIP for several. */
  blob: Blob
  /** Suggested download filename parsed from the response. */
  filename: string
  /** Combined size of the uploaded files, in bytes. */
  originalSize: number
  /** Combined size of the compressed output, in bytes. */
  compressedSize: number
}

/** POST a multipart form and report upload progress until the job is accepted. */
async function submitForm(
  path: string,
  form: FormData,
  onProgress?: (progress: JobProgress) => void,
): Promise<JobAccepted> {
  const response = await axios.post<JobAccepted>(`${API_BASE_URL}${path}`, form, {
    onUploadProgress: (event) => {
      if (!onProgress) return
      const percent = event.total ? (event.loaded / event.total) * 100 : null
      if (percent === null || percent < 100) {
        onProgress({ phase: "uploading", percent })
      }
    },
  })
  return response.data
}

/**
 * Compress one or more PDFs and return the resulting file plus size stats.
 *
 * @throws Error with the API's error detail when the request or job fails.
 */
export async function compressPdfs(
  files: File[],
  quality: CompressionQuality,
  onProgress?: (progress: CompressionProgress) => void,
): Promise<CompressionResult> {
  const form = new FormData()
  for (const file of files) {
    form.append("files", file)
  }
  form.append("quality", quality)

  const download = await runJobFlow({
    tool: "compress",
    submit: () => submitForm("/pdf/compress", form, onProgress),
    onProgress,
  })
  const fallback = files.length === 1 ? files[0].name : "compressed-pdfs.zip"
  return {
    blob: download.blob,
    filename: download.filename ?? fallback,
    originalSize: Number(download.headers["x-original-size"] ?? 0),
    compressedSize: Number(download.headers["x-compressed-size"] ?? download.blob.size),
  }
}

/** Result of a successful unlock request. */
export interface UnlockResult {
  /** The unlocked PDF. */
  blob: Blob
  /** Suggested download filename parsed from the response. */
  filename: string
}

/**
 * Remove the password from a single PDF and return the unlocked file.
 *
 * @throws Error with the API's error detail (e.g. wrong password) on failure.
 */
export async function unlockPdf(
  file: File,
  password: string,
  onProgress?: (progress: CompressionProgress) => void,
): Promise<UnlockResult> {
  const form = new FormData()
  form.append("file", file)
  form.append("password", password)

  const download = await runJobFlow({
    tool: "unlock",
    submit: () => submitForm("/pdf/unlock", form, onProgress),
    onProgress,
  })
  return {
    blob: download.blob,
    filename: download.filename ?? `unlocked-${file.name}`,
  }
}

/** Encryption strengths exposed by the lock endpoint. */
export const ENCRYPTION_LEVELS = ["aes-256", "aes-128"] as const

export type EncryptionLevel = (typeof ENCRYPTION_LEVELS)[number]

/** Options for locking a PDF; permissions default to a sensible "view only". */
export interface LockOptions {
  password: string
  allowPrinting: boolean
  allowCopying: boolean
  allowEditing: boolean
  encryption: EncryptionLevel
}

/** Result of a successful lock request. */
export interface LockResult {
  /** The password-protected PDF. */
  blob: Blob
  /** Suggested download filename parsed from the response. */
  filename: string
}

/**
 * Add a password to a single PDF and return the protected file.
 *
 * @throws Error with the API's error detail (e.g. already protected) on failure.
 */
export async function lockPdf(
  file: File,
  options: LockOptions,
  onProgress?: (progress: CompressionProgress) => void,
): Promise<LockResult> {
  const form = new FormData()
  form.append("file", file)
  form.append("password", options.password)
  form.append("allow_printing", String(options.allowPrinting))
  form.append("allow_copying", String(options.allowCopying))
  form.append("allow_editing", String(options.allowEditing))
  form.append("encryption", options.encryption)

  const download = await runJobFlow({
    tool: "lock",
    submit: () => submitForm("/pdf/lock", form, onProgress),
    onProgress,
  })
  return {
    blob: download.blob,
    filename: download.filename ?? `locked-${file.name}`,
  }
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** Format a byte count as a human-readable string (e.g. "1.2 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exponent)
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}
```

- [ ] **Step 6: Typecheck (pages will fail — expected)**

Run: `cd web && bun run typecheck`
Expected: errors ONLY in `routes/compress.tsx`, `routes/lock.tsx`, `routes/unlock.tsx` — `PHASE_LABELS` misses the `"queued"` key. That's Task 10's job. If other files error, fix them here.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/jobs.ts web/src/lib/jobs.test.ts web/src/lib/api.ts
git commit -m "Route web tools through the job queue submit/poll/download flow"
```

---

### Task 10: Pages — queued phase, queue board route, remove Sign in

**Files:**
- Modify: `web/src/routes/compress.tsx`, `web/src/routes/lock.tsx`, `web/src/routes/unlock.tsx`
- Modify: `web/src/routes/__root.tsx`
- Create: `web/src/routes/queue.tsx`

**Interfaces:**
- Consumes: `CompressionProgress` (phase union now includes `"queued"`), `fetchQueueBoard`, `recallJobIds`, `formatBytes`.

- [ ] **Step 1: Add the queued phase to all three tool pages**

In each of `compress.tsx`, `lock.tsx`, `unlock.tsx`, extend `PHASE_LABELS` with a `queued` entry (keep each page's existing verbs for the other phases — compress says "Compressing", lock "Locking", unlock "Unlocking"):
```tsx
const PHASE_LABELS: Record<CompressionProgress["phase"], string> = {
  uploading: "Uploading",
  queued: "In line",
  processing: "Compressing", // ← keep this page's existing verb
  downloading: "Downloading",
}
```
And where each page renders `<span>{PHASE_LABELS[progress.phase]}…</span>` (compress.tsx:249, lock.tsx:321, unlock.tsx:179), replace that line with:
```tsx
<span>
  {progress.phase === "queued" && progress.position != null
    ? `In line — #${progress.position}`
    : PHASE_LABELS[progress.phase]}
  …
</span>
```

- [ ] **Step 2: Replace the Sign in button with a Queue link**

In `web/src/routes/__root.tsx`:
1. Change the icon import (line 10) to drop `Login03Icon`:
```tsx
import { File01Icon } from "@hugeicons/core-free-icons"
```
2. Replace the header `<button>…Sign in…</button>` (lines 87–97) with:
```tsx
<Link
  to="/queue"
  className="press inline-flex items-center gap-2 rounded-full border-2 border-ink bg-card px-5 py-2.5 text-sm font-extrabold tracking-wide text-ink uppercase shadow-block-sm"
>
  Queue
</Link>
```
3. Update the header comment to `{/* Top bar: wordmark left, queue link right. */}`.

- [ ] **Step 3: Create the queue board route**

Create `web/src/routes/queue.tsx`:
```tsx
import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { File01Icon, Loading03Icon } from "@hugeicons/core-free-icons"

import { ToolHeader } from "@/components/tool-header"
import { formatBytes } from "@/lib/api"
import { type QueueBoard, type QueueBoardEntry, fetchQueueBoard, recallJobIds } from "@/lib/jobs"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/queue")({ component: QueuePage })

const TOOL_LABELS: Record<string, string> = {
  compress: "Compress",
  lock: "Lock",
  unlock: "Unlock",
}

function BoardRow({
  entry,
  mine,
  position,
}: {
  entry: QueueBoardEntry
  mine: boolean
  position?: number
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[14px] border-2 border-ink px-4 py-3",
        mine ? "bg-soft-amber" : "bg-surface",
      )}
    >
      {position !== undefined && (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink bg-card font-heading text-[15px] font-extrabold text-ink">
          {position}
        </span>
      )}
      <span className="font-mono text-[13px] font-bold text-muted-ink">#{entry.id_prefix}</span>
      <span className="font-heading text-[15px] font-extrabold text-ink">
        {TOOL_LABELS[entry.tool] ?? entry.tool}
      </span>
      <span className="text-[13px] font-semibold text-muted-ink">
        {entry.file_count} file{entry.file_count > 1 ? "s" : ""} · {formatBytes(entry.total_bytes)}
      </span>
      {mine && (
        <span className="ml-auto rounded-full bg-ink px-3 py-1 text-[12px] font-extrabold uppercase tracking-wide text-cream">
          Yours
        </span>
      )}
    </div>
  )
}

function QueuePage() {
  const [board, setBoard] = React.useState<QueueBoard | null>(null)
  const [error, setError] = React.useState(false)
  const myIds = React.useMemo(() => recallJobIds(), [])

  React.useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await fetchQueueBoard()
        if (!cancelled) {
          setBoard(next)
          setError(false)
        }
      } catch {
        if (!cancelled) setError(true)
      }
    }
    load()
    const timer = setInterval(load, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const isMine = (entry: QueueBoardEntry) => myIds.some((id) => id.startsWith(entry.id_prefix))

  return (
    <div className="pb-4">
      <ToolHeader
        icon={File01Icon}
        title="Queue"
        subtitle="Live view of every job in line. Jobs run three at a time."
      />

      <div className="mt-8 flex flex-col gap-7">
        {error && (
          <p className="rounded-[12px] border-2 border-destructive bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">
            Couldn't reach the queue. Retrying…
          </p>
        )}

        {!board && !error && (
          <div className="flex items-center gap-2 text-[13px] font-extrabold uppercase tracking-wide text-muted-ink">
            <HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" />
            Loading queue
          </div>
        )}

        {board && (
          <>
            <section className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
              <div className="mb-4 text-[13px] font-extrabold uppercase tracking-wide text-ink">
                Processing now ({board.processing.length}/{board.concurrency})
              </div>
              {board.processing.length === 0 ? (
                <p className="text-[14px] font-semibold text-muted-ink">
                  Nothing processing — new jobs start instantly.
                </p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {board.processing.map((entry) => (
                    <BoardRow key={entry.id_prefix} entry={entry} mine={isMine(entry)} />
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
              <div className="mb-4 text-[13px] font-extrabold uppercase tracking-wide text-ink">
                Waiting ({board.waiting.length})
              </div>
              {board.waiting.length === 0 ? (
                <p className="text-[14px] font-semibold text-muted-ink">The line is empty.</p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {board.waiting.map((entry, index) => (
                    <BoardRow
                      key={entry.id_prefix}
                      entry={entry}
                      mine={isMine(entry)}
                      position={index + 1}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Typecheck and build**

Run: `cd web && bun run typecheck && bun run build`
Expected: both succeed with zero errors (the route tree regenerates `/queue` during build). If `soft-amber` is not a defined color utility, check `web/src/styles.css` for the token name used by `bg-soft-amber` in `compress.tsx:150` — it exists there, so it will resolve.

- [ ] **Step 5: Manual smoke test in the browser**

With `make rabbit` and `make dev` running: open http://localhost:3000/lock, lock a PDF, watch phases (Uploading → In line — #1 → Locking → Downloading), confirm the file downloads. Open http://localhost:3000/queue and confirm the board renders and highlights "Yours" after submitting another job. Confirm the header shows "Queue" instead of "Sign in".

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/ web/src/routeTree.gen.ts
git commit -m "Add queue board page, queued phase UI, and drop the sign-in button"
```

---

### Task 11: Regenerate the typed API client

**Files:**
- Modify: `web/src/services/api/_generated/*` (regenerated)

- [ ] **Step 1: Regenerate against the running API**

With `make dev` running (api serving the new OpenAPI document):
```bash
cd web && bun api:fetch && bun api:generate
```
Expected: the `_generated` files update with the new `/jobs` and `/queue` operations. Nothing outside `web/src/services/api/` imports these files, so no other changes follow. If `api:fetch` fails because its configured spec URL is unreachable, fix by starting `make dev` first; if it fails for a config reason unrelated to this feature, note it and skip this task — the generated client has no consumers.

- [ ] **Step 2: Typecheck, then commit whatever regenerated**

```bash
cd web && bun run typecheck
git add web/src/services/api/
git commit -m "Regenerate typed API client for job queue endpoints"
```

---

### Task 12: Deploy to Railway and verify in production

**Files:** none (operational)

- [ ] **Step 1: Commit any remaining working-tree changes for api/web**

```bash
git status --short   # confirm only intended files remain; api/Dockerfile (Railway mount fix) must be committed if still dirty
git add api/Dockerfile
git commit -m "Use Railway-compatible cache mounts in the api Dockerfile"
```
(Skip if already committed.)

- [ ] **Step 2: Point the api at RabbitMQ over private networking**

```bash
railway variable set 'CHOWBEA_RABBITMQ_URL=${{RabbitMQ.RABBITMQ_PRIVATE_URL}}' --service api
railway variable list --service api --json | python3 -c "import json,sys; print(json.load(sys.stdin)['CHOWBEA_RABBITMQ_URL'])"
```
Expected: an `amqp://…@rabbitmq.railway.internal:5672` URL.

- [ ] **Step 3: Deploy both services**

```bash
railway up /Users/oddspace/Documents/projects/chowbea/chowbea-pdf/api --service api --detach -m "Job queue: RabbitMQ-backed processing"
railway up /Users/oddspace/Documents/projects/chowbea/chowbea-pdf/web --service web --detach -m "Job queue: queued phase UI + queue board"
```
Poll `railway deployment list --service api --limit 1 --json` (and web) until both show `SUCCESS`.

- [ ] **Step 4: Verify production end to end**

```bash
cd api && uv run python -c "
import pikepdf
pdf = pikepdf.new(); pdf.add_blank_page(); pdf.save('/tmp/sample.pdf'); pdf.close()" && cd ..
JOB=$(curl -s -F "file=@/tmp/sample.pdf" -F "password=test123" https://api-production-9ae1.up.railway.app/pdf/lock | python3 -c "import json,sys; print(json.load(sys.stdin)['job_id'])")
sleep 4
curl -s https://api-production-9ae1.up.railway.app/jobs/$JOB              # "status":"done"
curl -s https://api-production-9ae1.up.railway.app/queue                  # board JSON
curl -s -o /tmp/prod-locked.pdf https://api-production-9ae1.up.railway.app/jobs/$JOB/download && head -c 4 /tmp/prod-locked.pdf   # %PDF
curl -s https://pdf.chowbea.com/ | grep -ci "sign in"                     # 0
curl -s -o /dev/null -w "%{http_code}\n" https://pdf.chowbea.com/queue    # 200
```
Also check `railway logs --service api --lines 30` for `Consuming pdf-jobs with prefetch=3`.

- [ ] **Step 5: Verify the RabbitMQ management UI shows the queue**

Open the RabbitMQ Web UI service URL (rabbitmq-web-ui-production-46ef.up.railway.app) → Queues → `pdf-jobs` exists with consumers = 1.
