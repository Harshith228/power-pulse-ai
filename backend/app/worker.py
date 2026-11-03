"""Background worker thread: runs the monthly-report scheduler and cleans up expired sessions.

Runs in-process (started by the FastAPI lifespan). All work is idempotent and DB-backed, so a restart or a
second process never creates duplicates: reports are UNIQUE(user_id, period).
"""
import logging
import threading
import time

log = logging.getLogger("powerpulse.worker")
_wake = threading.Event()
_stop = threading.Event()
_thread = None
TICK_S = 60
SCHEDULE_EVERY_S = 10 * 60
CLEANUP_EVERY_S = 60 * 60



def cleanup():
    """Purge expired sessions and old password-reset tokens (they are useless and only grow the database)."""
    from . import db
    with db.connect() as conn:
        s = conn.execute("DELETE FROM sessions WHERE expires_at < ?", (db.now(),)).rowcount
        r = conn.execute("DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL", (db.now(),)).rowcount
    if s or r:
        log.info("cleanup: removed %s expired sessions and %s reset tokens", s, r)
    return s, r


def alive():
    return bool(_thread and _thread.is_alive())


def _loop():
    from . import monthly
    last_schedule = last_cleanup = 0.0
    while not _stop.is_set():
        try:
            if time.monotonic() - last_schedule >= SCHEDULE_EVERY_S:
                last_schedule = time.monotonic()
                monthly.run_scheduler()
            if time.monotonic() - last_cleanup >= CLEANUP_EVERY_S:
                last_cleanup = time.monotonic()
                cleanup()
        except Exception:  # noqa: BLE001 - keep the worker alive; errors are logged
            log.exception("worker iteration failed")
        _wake.wait(TICK_S)
        _wake.clear()


def start():
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="powerpulse-worker", daemon=True)
    _thread.start()


def stop():
    _stop.set()
    _wake.set()
