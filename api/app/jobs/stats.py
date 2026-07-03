"""Durable lifetime stats: a tiny JSON counter that survives redeploys.

The file lives on the Railway volume (CHOWBEA_DATA_DIR=/data in production).
Writes are atomic (temp file + os.replace) so a crash mid-write can never
corrupt the count; all increments happen on the event loop, so no locking.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)


class CounterStore:
    """Loads and persists the lifetime jobs-completed counter."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._count = self._load()

    def _load(self) -> int:
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
            count = payload["jobs_completed"]
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise ValueError(f"bad count: {count!r}")
            return count
        except FileNotFoundError:
            return 0
        except (ValueError, KeyError, TypeError, OSError):
            logger.warning("Stats file %s unreadable; starting the counter at 0", self._path)
            return 0

    @property
    def count(self) -> int:
        return self._count

    def increment(self) -> int:
        """Bump the counter and persist; a failed write never fails the job."""
        self._count += 1
        try:
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"jobs_completed": self._count}), encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError:
            logger.warning("Could not persist stats to %s", self._path)
        return self._count
