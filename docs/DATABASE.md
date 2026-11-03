# Database

PowerPulse AI uses **SQLite** through Python's standard `sqlite3` module - one file, no database server. Default location `data/powerpulse.db` (override with `POWERPULSE_DB`). Connections use WAL journaling and enforce foreign keys; every user-owned table references `users(id) ON DELETE CASCADE`, so deleting an account deletes all of its data.

The database file is **not** in version control (`.gitignore`); it is created on first start.

## Migrations

Migrations are the numbered SQL scripts in the `MIGRATIONS` list in [`backend/app/db.py`](../backend/app/db.py). On startup `migrate()` reads `PRAGMA user_version` and applies each pending script inside a transaction, then bumps the version. There is no separate migration command.

| Version | Change |
|---|---|
| v1 | Core schema: users, sessions, password resets, settings, limits, datasets, daily electricity totals, water readings, anomalies, notifications, deliveries, monthly reports, device keys |
| v2 | Delivery lifecycle columns for the (since removed) WhatsApp channel |
| v3 | Indexes for the queries every page makes |
| v4 | `electricity_readings` (manual entries) and `anomaly_state` (per-user read state that survives re-detection) |
| v5 | `custom_reports` (reports generated on request for any type and date range) |

`GET /api/health` returns the current version, e.g. `"database": "ok (schema v5)"`. Migrations only add tables, columns and indexes; they never drop user data.

## Tables

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | Accounts: email, name, scrypt password hash | `email` unique, case-insensitive |
| `sessions` | Server-side sessions; only the SHA-256 of the token is stored | expires_at; cleaned hourly |
| `password_resets` | Single-use reset tokens (hashed), 30-minute validity | `used_at` marks use |
| `user_settings` | Per-user settings JSON (theme, notifications, report schedule, tariffs, detection thresholds, ...) | one row per user |
| `daily_limits` | Daily limit per utility; `weekday = -1` is the default, 0-6 are per-weekday overrides | `limit_value > 0` |
| `datasets` | Imported electricity datasets: metadata and the cleaned hourly frame (BLOB); one active per user | `is_active` |
| `electricity_daily` | Daily kWh totals per dataset (fast queries for limits and reports) | PK (dataset_id, day) |
| `electricity_readings` | Manual electricity readings: whole-day (`hour = -1`) or hourly | `UNIQUE(user_id, day, hour)`, `kwh >= 0` |
| `water_readings` | Water readings in litres, daily or hourly, source manual / csv / device / demo | `UNIQUE(user_id, ts, granularity)`, `litres >= 0` |
| `anomalies` | Detected anomalies per utility with a stable `event_key` and full detail JSON | `UNIQUE(user_id, utility, event_key)` |
| `anomaly_state` | Read / unread state per user and anomaly key | PK (user_id, utility, event_key) |
| `notifications` | In-app notifications | `UNIQUE(user_id, dedupe_key)` - prevents duplicate alerts |
| `monthly_reports` | Automatic / manual calendar-month reports (`YYYY-MM`) with stored data | `UNIQUE(user_id, period)` - never duplicated |
| `custom_reports` | On-request reports: kind (combined / electricity / water), start, end, stored data incl. daily rows | `kind` check |
| `device_keys` | Smart-meter API keys (hash + display prefix) for water ingest | `key_hash` unique |
| `deliveries` | **Legacy, unused.** Outbound message queue from the removed WhatsApp channel | - |
| `whatsapp_verifications` | **Legacy, unused.** Phone verification codes from the removed WhatsApp channel | - |

The `users` table also still has legacy `whatsapp_*` columns. They are no longer read or written by the application and are kept only so databases created by earlier builds upgrade without dropping stored data. A future migration may remove them.

## Data rules worth knowing

- **No double counting of electricity:** imported dataset data is authoritative for each day it covers; a manual reading for such a day is stored but marked *not counted*.
- **Water day totals:** the sum of hourly readings when a day has any, otherwise its daily reading.
- **Reports store their data:** each report keeps the figures (including daily rows) it was generated from, so the on-screen report, PDF and CSV always match.
- **Read state survives re-detection:** `anomaly_state` is keyed by the anomaly's stable key (dataset, type, start), not by row id.

## Backup and restore

SQLite's online backup is consistent while the app is running:

```bash
.venv/bin/python -c "import sqlite3; s=sqlite3.connect('data/powerpulse.db'); d=sqlite3.connect('backups/powerpulse-backup.db'); s.backup(d); d.close()"
```

To restore: stop the app, replace `data/powerpulse.db` with the backup, delete any `powerpulse.db-wal` / `powerpulse.db-shm`, start the app and check `/api/health`. `data/cache/` is disposable and rebuilt automatically.
