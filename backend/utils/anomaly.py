"""
Lightweight anomaly detection for auth endpoints.

Tracks suspicious patterns per IP address in-process memory.  No external
dependencies required.

Risk score 0-100:
  0-24  -> normal
  25-49 -> monitor
  50-74 -> soft-block (extra logging)
  75+   -> hard-block (reject request)
"""

import time
from collections import defaultdict
from threading import Lock

_DECAY_WINDOW = 600   # 10 minutes - older events stop contributing
_CLOCK_SKEW_OK = 30   # seconds of acceptable skew


class AnomalyTracker:
    """Per-IP anomaly tracker."""

    def __init__(self):
        self._lock = Lock()
        # ip -> list of (timestamp, event_type, detail)
        self._events: dict[str, list[tuple[float, str, str]]] = defaultdict(list)
        # ip -> set of HWID fingerprints seen
        self._hwids: dict[str, set[str]] = defaultdict(set)

    # ------------------------------------------------------------------
    # Event recording
    # ------------------------------------------------------------------

    # Reasons that carry reduced weight — legitimate buyers mistyping their key.
    _SOFT_FAILURE_REASONS = frozenset({'not_found', 'inactive', 'standalone_tier'})

    def record_failure(self, ip: str, reason: str = '') -> None:
        event_type = 'failure_soft' if reason in self._SOFT_FAILURE_REASONS else 'failure'
        self._add_event(ip, event_type, reason)

    def record_success(self, ip: str) -> None:
        self._add_event(ip, 'success', '')

    def record_hwid(self, ip: str, hwid_fp: str) -> None:
        """Track which HWIDs have been seen from this IP."""
        with self._lock:
            self._hwids[ip].add(hwid_fp[:16])  # store prefix only
        self._add_event(ip, 'hwid', hwid_fp[:16])

    def record_clock_skew(self, ip: str, skew_seconds: float) -> None:
        if abs(skew_seconds) > _CLOCK_SKEW_OK:
            self._add_event(ip, 'skew', f'{skew_seconds:.1f}s')

    # ------------------------------------------------------------------
    # Risk assessment
    # ------------------------------------------------------------------

    def risk_score(self, ip: str, client_ts_ms: int = 0) -> int:
        """Return an integer 0-100 risk score for *ip*.

        Higher = more suspicious.
        """
        now = time.time()
        cutoff = now - _DECAY_WINDOW

        with self._lock:
            events = [(ts, evt, det) for ts, evt, det in self._events.get(ip, [])
                      if ts > cutoff]
            unique_hwids = len(self._hwids.get(ip, set()))

        # --- Clock skew ---
        skew_score = 0
        if client_ts_ms:
            skew_s = abs(now - client_ts_ms / 1000.0)
            if skew_s > 120:
                skew_score = 40
            elif skew_s > _CLOCK_SKEW_OK:
                skew_score = 20

        # --- Failure rate ---
        # Hard failures (bad challenge, wrong HWID, brute-force signals): +8 each
        # Soft failures (unknown key, inactive, wrong tier): +3 each — legitimate buyers mistyping
        hard_failures = sum(1 for _, evt, _ in events if evt == 'failure')
        soft_failures = sum(1 for _, evt, _ in events if evt == 'failure_soft')
        failure_score = min(hard_failures * 8 + soft_failures * 3, 50)

        # --- HWID diversity from same IP ---
        hwid_score = 0
        if unique_hwids >= 5:
            hwid_score = 40
        elif unique_hwids >= 3:
            hwid_score = 20
        elif unique_hwids >= 2:
            hwid_score = 10

        # --- Rapid repeated events (>20 in window) ---
        volume_score = 0
        if len(events) > 20:
            volume_score = 25
        elif len(events) > 10:
            volume_score = 10

        total = skew_score + failure_score + hwid_score + volume_score
        return min(total, 100)

    def is_suspicious(self, ip: str, threshold: int = 75, client_ts_ms: int = 0) -> bool:
        return self.risk_score(ip, client_ts_ms=client_ts_ms) >= threshold

    # ------------------------------------------------------------------
    # Housekeeping
    # ------------------------------------------------------------------

    def clear_ip(self, ip: str) -> None:
        """Wipe all recorded events and HWIDs for a specific IP (admin use)."""
        with self._lock:
            self._events.pop(ip, None)
            self._hwids.pop(ip, None)

    def cleanup(self) -> None:
        """Remove stale event history to bound memory use."""
        now = time.time()
        cutoff = now - _DECAY_WINDOW
        with self._lock:
            for ip in list(self._events.keys()):
                self._events[ip] = [(ts, e, d) for ts, e, d in self._events[ip] if ts > cutoff]
                if not self._events[ip]:
                    del self._events[ip]

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _add_event(self, ip: str, event_type: str, detail: str) -> None:
        now = time.time()
        with self._lock:
            self._events[ip].append((now, event_type, detail))


# Module-level singleton
_tracker = AnomalyTracker()


def get_tracker() -> AnomalyTracker:
    return _tracker
