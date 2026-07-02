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
