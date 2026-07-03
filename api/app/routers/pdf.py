"""Routes for PDF actions. Submissions are queued, not processed inline."""

from __future__ import annotations

import json
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
    except Exception as exc:  # noqa: BLE001 - any publish failure must not leave a phantom queued job
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


@router.post(
    "/merge",
    status_code=202,
    summary="Queue a merge of two or more PDF files",
    response_model=JobAccepted,
)
async def merge(
    request: Request,
    files: List[UploadFile] = File(..., description="Two or more PDF files, in merge order."),
) -> JobAccepted:
    """Validate and store the uploads, then queue a merge job."""
    if len(files) < 2:
        raise HTTPException(status_code=400, detail="Merging needs at least two PDF files.")

    work_dir = Path(tempfile.mkdtemp(prefix="chowbea-merge-"))
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
        tool="merge",
        workspace=work_dir,
        file_count=len(names),
        total_bytes=total_bytes,
        params={"names": names},
    )


def _parse_page_ops(raw: str) -> list[dict[str, int]]:
    """Parse and validate the rotate tool's page list; 400 on anything off."""
    invalid = HTTPException(status_code=400, detail="Invalid page list.")
    try:
        parsed = json.loads(raw)
    except (ValueError, RecursionError):
        raise invalid from None
    if not isinstance(parsed, list) or not parsed:
        raise invalid
    ops: list[dict[str, int]] = []
    seen: set[int] = set()
    for item in parsed:
        if not isinstance(item, dict):
            raise invalid
        index = item.get("index")
        rotation = item.get("rotation")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            raise invalid
        if isinstance(rotation, bool) or not isinstance(rotation, int) or rotation not in (0, 90, 180, 270):
            raise invalid
        if index in seen:
            raise HTTPException(status_code=400, detail="The page list contains duplicates.")
        seen.add(index)
        ops.append({"index": index, "rotation": rotation})
    return ops


@router.post(
    "/rotate",
    status_code=202,
    summary="Queue a rotate/reorder of a PDF's pages",
    response_model=JobAccepted,
)
async def rotate(
    request: Request,
    file: UploadFile = File(..., description="The PDF whose pages to rotate/reorder."),
    pages: str = Form(
        ...,
        description='JSON list of {"index", "rotation"}; array order is the new page order.',
    ),
) -> JobAccepted:
    """Validate and store the upload, then queue a rotate job."""
    page_ops = _parse_page_ops(pages)

    work_dir = Path(tempfile.mkdtemp(prefix="chowbea-rotate-"))
    try:
        input_path = work_dir / "input.pdf"
        await _stream_upload_to_disk(file, input_path)
        total_bytes = input_path.stat().st_size
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    return await _accept_job(
        request,
        tool="rotate",
        workspace=work_dir,
        file_count=1,
        total_bytes=total_bytes,
        params={"name": _safe_name(file.filename, "document.pdf"), "pages": page_ops},
    )
