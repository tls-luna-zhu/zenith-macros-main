"""
In-memory sliding-window rate limiter.

No Redis required - designed for PythonAnywhere free tier where only one
worker process runs.  All state is process-local.
"""

import time
from collections import defaultdict
from threading import Lock


class InMemoryRateLimiter:
    """Thread-safe sliding-window rate limiter keyed by arbitrary strings."""

    def __init__(self):
        # key -> list of float timestamps (epoch seconds)
        self._buckets: dict[str, list[float]] = defaultdict(list)
        self._lock = Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def is_allowed(self, key: str, limit: int, window: int) -> bool:
        """Return True when *key* is within *limit* requests per *window* seconds."""
        now = time.monotonic()
        cutoff = now - window

        with self._lock:
            bucket = self._buckets[key]
            # Drop timestamps older than the window
            self._buckets[key] = [ts for ts in bucket if ts > cutoff]
            return len(self._buckets[key]) < limit

    def record(self, key: str) -> None:
        """Record a request for *key* at the current time."""
        now = time.monotonic()
        with self._lock:
            self._buckets[key].append(now)

    def check_and_record(self, key: str, limit: int, window: int) -> bool:
        """Atomically check the limit and record the request if allowed.

        Returns True when the request is permitted and has been recorded,
        False when the limit is already exceeded (request NOT recorded).
        """
        now = time.monotonic()
        cutoff = now - window

        with self._lock:
            bucket = self._buckets[key]
            # Evict old entries
            fresh = [ts for ts in bucket if ts > cutoff]
            if len(fresh) >= limit:
                self._buckets[key] = fresh
                return False
            fresh.append(now)
            self._buckets[key] = fresh
            return True

    def cleanup(self, max_age: float = 300.0) -> int:
        """Evict buckets that have had no activity in *max_age* seconds.

        Returns the number of keys removed.  Call periodically to avoid
        unbounded memory growth under heavy traffic.
        """
        now = time.monotonic()
        cutoff = now - max_age
        removed = 0
        with self._lock:
            dead_keys = [k for k, v in self._buckets.items() if not v or max(v) < cutoff]
            for k in dead_keys:
                del self._buckets[k]
                removed += 1
        return removed


# ---------------------------------------------------------------------------
# Module-level singleton used by the Flask app
# ---------------------------------------------------------------------------

_limiter = InMemoryRateLimiter()


def get_limiter() -> InMemoryRateLimiter:
    return _limiter
