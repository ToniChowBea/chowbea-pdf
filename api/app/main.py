"""FastAPI application entrypoint for the Chowbea PDF API."""

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.jobs.queue import JobQueue
from app.jobs.registry import JobRegistry
from app.jobs.stats import CounterStore
from app.jobs.worker import execute_job
from app.routers import jobs, pdf

logger = logging.getLogger(__name__)


async def _run_queue(job_queue: JobQueue, registry: JobRegistry, handle) -> None:
    """Connect and start consuming, retrying forever so the API can come up
    (and serve 503s on submit) while the broker is unreachable."""

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
        try:
            removed = registry.sweep()
        except Exception:
            logger.exception("Job sweep failed; will retry next cycle")
            continue
        if removed:
            logger.info("Swept %d expired job(s)", removed)


@asynccontextmanager
async def lifespan(app: FastAPI):
    registry = JobRegistry(result_ttl_seconds=settings.result_ttl_minutes * 60)
    job_queue = JobQueue(settings.rabbitmq_url, prefetch=settings.job_concurrency)
    app.state.registry = registry
    app.state.job_queue = job_queue
    counter = None
    try:
        data_dir = Path(settings.data_dir)
        data_dir.mkdir(parents=True, exist_ok=True)
        counter = CounterStore(data_dir / "stats.json")
    except OSError:
        logger.warning("Data dir %s unavailable; the jobs counter is disabled", settings.data_dir)
    app.state.counter = counter

    async def handle(job_id: str) -> None:
        await execute_job(registry, job_id, counter)

    queue_task = asyncio.create_task(_run_queue(job_queue, registry, handle))
    sweep_task = asyncio.create_task(_sweep_forever(registry))
    try:
        yield
    finally:
        queue_task.cancel()
        sweep_task.cancel()
        # aio-pika's connect_robust can swallow cancellation while an initial
        # connect attempt is failing, so bound the wait — a task that will not
        # stop is abandoned after 5s rather than hanging shutdown forever.
        await asyncio.wait({queue_task, sweep_task}, timeout=5)
        await job_queue.close()


# The OpenAPI document produced here is consumed by the web app's `chowbea-axios`
# codegen to generate a fully typed client. The version carries the deployed
# commit so /docs identifies the running build; locally it stays stable so the
# codegen watcher doesn't churn.
app = FastAPI(
    title=settings.app_name,
    version=(
        settings.app_version
        if settings.commit_sha == "dev"
        else f"{settings.app_version}+{settings.commit_sha[:7]}"
    ),
    lifespan=lifespan,
)

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
    """Return a status payload used by load balancers, uptime checks, and
    bug reports (the commit identifies the running deploy)."""
    return {"status": "ok", "commit": settings.commit_sha[:7]}
