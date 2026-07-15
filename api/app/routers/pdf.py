"""Routes for PDF actions. Submissions are queued, not processed inline."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import zipfile
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


def _parse_split_parts(raw: str) -> list[dict[str, list[int]]]:
    """Parse and validate the split tool's parts list; 400 on anything off."""
    invalid = HTTPException(status_code=400, detail="Invalid parts list.")
    try:
        parsed = json.loads(raw)
    except (ValueError, RecursionError):
        raise invalid from None
    if not isinstance(parsed, list) or not parsed:
        raise invalid
    parts: list[dict[str, list[int]]] = []
    for item in parsed:
        if not isinstance(item, dict):
            raise invalid
        pages = item.get("pages")
        if not isinstance(pages, list) or not pages:
            raise invalid
        cleaned: list[int] = []
        for page in pages:
            if isinstance(page, bool) or not isinstance(page, int) or page < 0:
                raise invalid
            cleaned.append(page)
        if len(cleaned) != len(set(cleaned)):
            raise HTTPException(
                status_code=400,
                detail="A part lists the same page more than once.",
            )
        parts.append({"pages": cleaned})
    return parts


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


@router.post(
    "/split",
    status_code=202,
    summary="Queue a split of a PDF into page groups",
    response_model=JobAccepted,
)
async def split(
    request: Request,
    file: UploadFile = File(..., description="The PDF to split."),
    parts: str = Form(
        ...,
        description='JSON list of {"pages": [int, ...]}; each entry becomes one output PDF.',
    ),
) -> JobAccepted:
    """Validate and store the upload, then queue a split job."""
    parsed_parts = _parse_split_parts(parts)

    work_dir = Path(tempfile.mkdtemp(prefix="chowbea-split-"))
    try:
        input_path = work_dir / "input.pdf"
        await _stream_upload_to_disk(file, input_path)
        total_bytes = input_path.stat().st_size
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    return await _accept_job(
        request,
        tool="split",
        workspace=work_dir,
        file_count=1,
        total_bytes=total_bytes,
        params={
            "name": _safe_name(file.filename, "document.pdf"),
            "parts": parsed_parts,
        },
    )


# Extension → convert-tool source kind.
_SOURCE_KINDS = {
    ".pdf": "pdf",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".docx": "docx",
    ".md": "md",
    ".markdown": "md",
    ".html": "html",
    ".htm": "html",
    ".txt": "txt",
}

# Binary signatures per kind; text kinds instead reject NUL bytes.
_MAGIC_PREFIXES = {
    "pdf": (b"%PDF",),
    "image": (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff"),
    "docx": (b"PK\x03\x04",),
}

_CONVERT_TARGETS = {"pdf", "docx", "md", "html", "txt", "png", "jpeg"}
_ALLOWED_PAIRS = {
    "pdf": {"png", "jpeg", "docx", "md", "txt"},
    "image": {"pdf"},
    "docx": {"pdf", "md", "html", "txt"},
    "md": {"pdf", "html", "docx", "txt"},
    "html": {"pdf", "md", "docx", "txt"},
    "txt": {"pdf", "md", "html", "docx"},
}
_DPI_PRESETS = {72, 150, 300}

_MAX_DOCX_ENTRIES = 10_000


def _looks_like_docx(dest: Path) -> bool:
    """Cheap, bounded check that a ZIP is a real Word document.

    Reads the end-of-central-directory record first and rejects absurd entry
    counts, so a crafted central directory can't burn CPU/RAM during parsing.
    """
    with dest.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - 65_536))
        tail = handle.read()
    eocd = tail.rfind(b"PK\x05\x06")
    if eocd == -1 or len(tail) < eocd + 12:
        return False
    total_entries = int.from_bytes(tail[eocd + 10 : eocd + 12], "little")
    if total_entries > _MAX_DOCX_ENTRIES:
        return False
    try:
        with zipfile.ZipFile(dest) as archive:
            return "word/document.xml" in archive.namelist()
    except zipfile.BadZipFile:
        return False


async def _stream_source_to_disk(file: UploadFile, dest: Path, kind: str, name: str) -> None:
    """Write any supported source file to disk with kind-aware validation.

    Binary kinds are checked by magic bytes; text kinds must not contain NUL
    bytes in any chunk. Size cap and empty check match the PDF validator.
    """
    mismatch = HTTPException(
        status_code=400, detail=f"'{name}' does not look like a {kind} file."
    )
    size = 0
    is_first_chunk = True
    with dest.open("wb") as out:
        while True:
            chunk = await file.read(_CHUNK_SIZE)
            if not chunk:
                break
            prefixes = _MAGIC_PREFIXES.get(kind)
            if is_first_chunk and prefixes is not None and not any(chunk.startswith(p) for p in prefixes):
                raise mismatch
            # NUL bytes reject UTF-16/binary masquerading as text; UTF-8 is the supported text encoding.
            if prefixes is None and b"\x00" in chunk:
                raise mismatch
            is_first_chunk = False
            size += len(chunk)
            if size > _MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"'{name}' exceeds the {settings.max_upload_mb} MB limit.",
                )
            out.write(chunk)
    if size == 0:
        raise HTTPException(status_code=400, detail=f"'{name}' is empty.")
    if kind == "docx" and not await asyncio.to_thread(_looks_like_docx, dest):
        raise mismatch


@router.post(
    "/convert",
    status_code=202,
    summary="Queue a file conversion",
    response_model=JobAccepted,
)
async def convert(
    request: Request,
    files: List[UploadFile] = File(..., description="The file to convert (multiple images may combine into one PDF)."),
    target: str = Form(..., description="Target format: pdf, docx, md, html, txt, png, or jpeg."),
    dpi: int | None = Form(None, description="Resolution for png/jpeg targets: 72, 150, or 300."),
) -> JobAccepted:
    """Validate the upload(s) and conversion pair, then queue a convert job."""
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded.")
    if target not in _CONVERT_TARGETS:
        raise HTTPException(status_code=400, detail="Invalid target format.")
    if dpi is not None and (target not in ("png", "jpeg") or dpi not in _DPI_PRESETS):
        raise HTTPException(status_code=400, detail="Invalid DPI.")

    names = [_safe_name(f.filename, f"document-{i + 1}") for i, f in enumerate(files)]
    kinds = [_SOURCE_KINDS.get(Path(name).suffix.lower()) for name in names]
    if any(kind is None for kind in kinds):
        raise HTTPException(status_code=400, detail="Unsupported file type.")
    source_kind = kinds[0]
    if len(files) > 1 and not (all(k == "image" for k in kinds) and target == "pdf"):
        raise HTTPException(
            status_code=400,
            detail="Convert takes one file at a time (multiple images can be combined into a PDF).",
        )
    if target not in _ALLOWED_PAIRS[source_kind]:
        raise HTTPException(status_code=400, detail=f"Cannot convert {source_kind} to {target}.")

    work_dir = Path(tempfile.mkdtemp(prefix="chowbea-convert-"))
    try:
        total_bytes = 0
        for index, (file, name, kind) in enumerate(zip(files, names, kinds)):
            input_path = work_dir / f"input-{index}{Path(name).suffix.lower()}"
            await _stream_source_to_disk(file, input_path, kind, name)
            total_bytes += input_path.stat().st_size
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    params: dict[str, Any] = {"target": target, "names": names, "source_kind": source_kind}
    if dpi is not None:
        params["dpi"] = dpi
    return await _accept_job(
        request,
        tool="convert",
        workspace=work_dir,
        file_count=len(names),
        total_bytes=total_bytes,
        params=params,
    )
