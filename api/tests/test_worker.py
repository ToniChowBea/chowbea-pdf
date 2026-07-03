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


def test_redelivered_job_is_not_rerun(tmp_path):
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
    record.status = JobStatus.processing
    asyncio.run(execute_job(registry, record.id))
    assert record.status is JobStatus.processing
    assert record.finished_at is None


def test_merge_job_succeeds(tmp_path):
    registry = JobRegistry()
    workspace = tmp_path / "job"
    workspace.mkdir()
    write_blank_pdf(workspace / "input-0.pdf")
    write_blank_pdf(workspace / "input-1.pdf")
    record = registry.create(
        tool="merge",
        workspace=workspace,
        file_count=2,
        total_bytes=sum((workspace / f"input-{i}.pdf").stat().st_size for i in range(2)),
        params={"names": ["a.pdf", "b.pdf"]},
    )
    asyncio.run(execute_job(registry, record.id))
    assert record.status is JobStatus.done
    assert record.error is None
    assert record.result_path is not None and record.result_path.exists()
    assert record.download_name == "merged.pdf"
    assert record.media_type == "application/pdf"


def test_rotate_job_succeeds(tmp_path):
    registry = JobRegistry()
    workspace = tmp_path / "job"
    workspace.mkdir()
    write_blank_pdf(workspace / "input.pdf")
    record = registry.create(
        tool="rotate",
        workspace=workspace,
        file_count=1,
        total_bytes=(workspace / "input.pdf").stat().st_size,
        params={"name": "report.pdf", "pages": [{"index": 0, "rotation": 90}]},
    )
    asyncio.run(execute_job(registry, record.id))
    assert record.status is JobStatus.done
    assert record.error is None
    assert record.result_path is not None and record.result_path.exists()
    assert record.download_name == "rotated-report.pdf"
    assert record.media_type == "application/pdf"
