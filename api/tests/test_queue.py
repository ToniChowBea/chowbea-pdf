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
