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
