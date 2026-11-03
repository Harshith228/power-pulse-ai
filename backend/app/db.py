"""SQLite storage. One connection per unit of work; schema versioned with PRAGMA user_version.

Every user-owned table carries user_id with ON DELETE CASCADE, and every query in the API layer
filters by the authenticated user's id.
"""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

_init_lock = threading.Lock()
_initialised: set[str] = set()

MIGRATIONS = [
    # ---- v1 ----
    """
    CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        password_changed_at TEXT,
        whatsapp_number TEXT,
        whatsapp_verified_at TEXT,
        whatsapp_verified_mode TEXT,          -- 'live' | 'test'
        whatsapp_consent_at TEXT
    );
    CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        user_agent TEXT
    );
    CREATE INDEX ix_sessions_user ON sessions(user_id);
    CREATE TABLE password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
    );
    CREATE TABLE user_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data TEXT NOT NULL
    );
    -- weekday -1 = default limit for every day, 0..6 = Monday..Sunday override.
    -- value is kWh for electricity and litres for water.
    CREATE TABLE daily_limits (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        utility TEXT NOT NULL CHECK (utility IN ('electricity', 'water')),
        weekday INTEGER NOT NULL DEFAULT -1 CHECK (weekday BETWEEN -1 AND 6),
        limit_value REAL NOT NULL CHECK (limit_value > 0),
        PRIMARY KEY (user_id, utility, weekday)
    );
    -- electricity datasets: cleaned hourly frame stored as gzip CSV, daily totals in electricity_daily
    CREATE TABLE datasets (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        meta TEXT NOT NULL,
        frame BLOB NOT NULL,
        created_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX ix_datasets_user ON datasets(user_id);
    CREATE TABLE electricity_daily (
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        kwh REAL NOT NULL,
        hours INTEGER NOT NULL,
        PRIMARY KEY (dataset_id, day)
    );
    -- water: litres, normalised on input. granularity 'day' (manual / daily CSV) or 'hour' (meters, hourly CSV)
    CREATE TABLE water_readings (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        granularity TEXT NOT NULL CHECK (granularity IN ('day', 'hour')),
        litres REAL NOT NULL CHECK (litres >= 0),
        source TEXT NOT NULL,                 -- manual | csv | device | demo
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, ts, granularity)
    );
    CREATE INDEX ix_water_user_ts ON water_readings(user_id, ts);
    CREATE TABLE anomalies (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        utility TEXT NOT NULL,
        dataset_id TEXT,
        event_key TEXT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        start_ts TEXT NOT NULL,
        end_ts TEXT NOT NULL,
        title TEXT NOT NULL,
        data TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        UNIQUE (user_id, utility, event_key)
    );
    CREATE TABLE notifications (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category TEXT NOT NULL,               -- electricity | water | report | account
        kind TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        read_at TEXT,
        UNIQUE (user_id, dedupe_key)
    );
    CREATE INDEX ix_notifications_user ON notifications(user_id, created_at);
    CREATE TABLE deliveries (
        id INTEGER PRIMARY KEY,
        notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,                -- whatsapp
        status TEXT NOT NULL,                 -- queued | sent | delivered | read | failed | test_mode
        to_number TEXT NOT NULL,
        payload TEXT NOT NULL,
        provider_message_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX ix_deliveries_status ON deliveries(status, next_attempt_at);
    CREATE INDEX ix_deliveries_msg ON deliveries(provider_message_id);
    CREATE TABLE whatsapp_verifications (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        number TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT NOT NULL,
        mode TEXT NOT NULL
    );
    CREATE TABLE monthly_reports (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period TEXT NOT NULL,                 -- YYYY-MM
        status TEXT NOT NULL,                 -- ready | no_data
        data TEXT NOT NULL,
        trigger TEXT NOT NULL,                -- scheduled | manual
        generated_at TEXT NOT NULL,
        UNIQUE (user_id, period)
    );
    CREATE TABLE device_keys (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
    );
    """,
    # ---- v2: WhatsApp delivery lifecycle + customer-service window ----
    """
    ALTER TABLE deliveries ADD COLUMN error_code TEXT;
    ALTER TABLE deliveries ADD COLUMN sent_at TEXT;
    ALTER TABLE deliveries ADD COLUMN delivered_at TEXT;
    ALTER TABLE deliveries ADD COLUMN read_at TEXT;
    ALTER TABLE deliveries ADD COLUMN failed_at TEXT;
    ALTER TABLE users ADD COLUMN whatsapp_last_inbound_at TEXT;
    ALTER TABLE users ADD COLUMN whatsapp_number_status TEXT;
    -- earlier "test mode" verifications never reached WhatsApp, so they don't count as verified
    UPDATE users SET whatsapp_verified_at = NULL, whatsapp_verified_mode = NULL WHERE whatsapp_verified_mode = 'test';
    UPDATE deliveries SET status = 'not_configured' WHERE status = 'test_mode';
    """,
    # ---- v3: indexes for the queries every page makes ----
    """
    CREATE INDEX IF NOT EXISTS ix_anomalies_user_util_start ON anomalies(user_id, utility, start_ts);
    CREATE INDEX IF NOT EXISTS ix_anomalies_dataset ON anomalies(dataset_id);
    CREATE INDEX IF NOT EXISTS ix_notifications_user_read ON notifications(user_id, read_at);
    CREATE INDEX IF NOT EXISTS ix_deliveries_user ON deliveries(user_id, id);
    CREATE INDEX IF NOT EXISTS ix_users_whatsapp ON users(whatsapp_number);
    CREATE INDEX IF NOT EXISTS ix_device_keys_user ON device_keys(user_id);
    CREATE INDEX IF NOT EXISTS ix_password_resets_user ON password_resets(user_id);
    CREATE INDEX IF NOT EXISTS ix_datasets_user_active ON datasets(user_id, is_active);
    """,
    # v4: manually entered electricity readings, and per-user anomaly read state that survives re-detection
    """
    CREATE TABLE IF NOT EXISTS electricity_readings (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        hour INTEGER NOT NULL DEFAULT -1 CHECK (hour BETWEEN -1 AND 23),
        kwh REAL NOT NULL CHECK (kwh >= 0),
        source TEXT NOT NULL CHECK (source IN ('manual', 'smart_meter', 'other')),
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, day, hour)
    );
    CREATE INDEX IF NOT EXISTS ix_elec_readings_user_day ON electricity_readings(user_id, day);
    CREATE TABLE IF NOT EXISTS anomaly_state (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        utility TEXT NOT NULL CHECK (utility IN ('electricity', 'water')),
        event_key TEXT NOT NULL,
        first_detected_at TEXT NOT NULL,
        read_at TEXT,
        PRIMARY KEY (user_id, utility, event_key)
    );
    INSERT OR IGNORE INTO anomaly_state (user_id, utility, event_key, first_detected_at)
        SELECT user_id, utility, event_key, detected_at FROM anomalies;
    """,
    # v5: reports generated on request for any date range and type (automatic monthly ones stay in monthly_reports)
    """
    CREATE TABLE IF NOT EXISTS custom_reports (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('combined', 'electricity', 'water')),
        start TEXT NOT NULL,
        "end" TEXT NOT NULL,
        label TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_custom_reports_user ON custom_reports(user_id, created_at);
    """,
]


def now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _connect():
    path = config.db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30, isolation_level=None)  # autocommit; explicit BEGIN for transactions
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def migrate(conn):
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    for i, sql in enumerate(MIGRATIONS[version:], start=version + 1):
        conn.executescript("BEGIN;" + sql + f"; PRAGMA user_version = {i}; COMMIT;")


def init():
    key = str(config.db_path())
    with _init_lock:
        if key in _initialised:
            return
        conn = _connect()
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            migrate(conn)
        finally:
            conn.close()
        _initialised.add(key)


@contextmanager
def connect():
    init()
    conn = _connect()
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction(conn):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def row(r):
    return dict(r) if r is not None else None


def loads(s, default=None):
    try:
        return json.loads(s) if s else default
    except (TypeError, ValueError):
        return default


def dumps(o):
    return json.dumps(o, separators=(",", ":"), default=str)
