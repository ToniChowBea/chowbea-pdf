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
async def job_status(request: Request, job_id: str) -> JobStatusResponse:
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
async def job_download(request: Request, job_id: str) -> FileResponse:
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
async def queue_board(request: Request) -> QueueBoard:
    registry = request.app.state.registry
    counter = getattr(request.app.state, "counter", None)
    return QueueBoard(
        concurrency=settings.job_concurrency,
        jobs_completed=counter.count if counter is not None else 0,
        processing=[_board_entry(r) for r in registry.processing()],
        waiting=[_board_entry(r) for r in registry.waiting()],
    )
