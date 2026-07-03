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
from app.jobs.stats import CounterStore
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
from app.services.merge import MergeError, merge_pdf_files
from app.services.rotate import RotateError, rearrange_pdf_file
from app.services.convert import ConvertError, convert_files

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
    MergeError,
    RotateError,
    ConvertError,
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


def _run_merge(record: JobRecord) -> None:
    names: list[str] = record.params["names"]
    input_paths = [record.workspace / f"input-{index}.pdf" for index in range(len(names))]
    output_path = record.workspace / "output.pdf"
    merge_pdf_files(input_paths, names, output_path)
    record.result_path = output_path
    record.download_name = "merged.pdf"
    record.media_type = "application/pdf"


def _run_rotate(record: JobRecord) -> None:
    name: str = record.params["name"]
    input_path = record.workspace / "input.pdf"
    output_path = record.workspace / "output.pdf"
    rearrange_pdf_file(input_path, name, output_path, record.params["pages"])
    record.result_path = output_path
    record.download_name = name if name.startswith("rotated-") else f"rotated-{name}"
    record.media_type = "application/pdf"


def _run_convert(record: JobRecord) -> None:
    result_path, download_name, media_type = convert_files(
        record.workspace,
        record.params["names"],
        record.params["source_kind"],
        record.params["target"],
        record.params.get("dpi") or 150,
    )
    record.result_path = result_path
    record.download_name = download_name
    record.media_type = media_type


_RUNNERS = {"compress": _run_compress, "lock": _run_lock, "unlock": _run_unlock, "merge": _run_merge, "rotate": _run_rotate, "convert": _run_convert}


def run_job(record: JobRecord) -> None:
    """Synchronously execute one job; raises service errors on failure."""
    runner = _RUNNERS.get(record.tool)
    if runner is None:
        raise ValueError(f"Unknown tool '{record.tool}'")
    runner(record)


async def execute_job(registry: JobRegistry, job_id: str, counter: CounterStore | None = None) -> None:
    """Consumer handler: run one job and record the outcome on the registry."""
    record = registry.get(job_id)
    if record is None:
        # Message survived a redeploy but the registry/workspace did not.
        logger.warning("Dropping job %s with no registry entry", job_id)
        return

    if record.status is not JobStatus.queued:
        logger.warning("Ignoring redelivery of job %s in state %s", job_id, record.status.value)
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
        if counter is not None:
            counter.increment()
    finally:
        record.finished_at = time.time()
