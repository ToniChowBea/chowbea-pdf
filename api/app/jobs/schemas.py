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
    jobs_completed: int
    processing: list[BoardEntry]
    waiting: list[BoardEntry]
