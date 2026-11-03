# Deploying PowerPulse AI

PowerPulse is one Python process: FastAPI serves the API and the static frontend, SQLite holds all data, and a
background thread inside the same process runs the monthly-report scheduler and an
hourly cleanup of expired sessions and reset tokens. There is no build step.

## 1. Requirements

- Python 3.12+ (developed and tested on 3.13)
- Memory: about 170 MB at idle in testing, plus roughly 16 MB per cached analysis; 1 GB leaves ample headroom
- A reverse proxy with HTTPS (Caddy, nginx, IIS, a PaaS router) for anything beyond localhost
- Optional: an SMTP account for password-reset emails

## 2. Install

```bash
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt        # Windows: .\.venv\Scripts\python
.venv/bin/python scripts/fetch_uci.py                      # optional: the public UCI demo household (~20 MB)
cp .env.example .env                                        # then edit .env
```

`.env` holds secrets: keep it out of version control (it is in `.gitignore`), readable only by the service account.
Real environment variables override `.env`. Never put a value and a `# comment` on the same line - comments must
be on their own lines (values such as SMTP passwords may contain `#`).

Minimum production settings:

```ini
# https:// turns on Secure cookies and HSTS
POWERPULSE_APP_URL=https://energy.example.com
# only the proxy talks to the app
POWERPULSE_HOST=127.0.0.1
POWERPULSE_PORT=8000
# the proxy's address, so rate limits see real client IPs
POWERPULSE_TRUSTED_PROXIES=127.0.0.1
# hide /docs
POWERPULSE_HIDE_API_DOCS=1
```

## 3. Run

```bash
.venv/bin/python run.py
```

Run exactly **one** process. Rate limits, the detection cache and the worker live in-process; extra processes would
each run their own worker (deliveries and reports are still de-duplicated by the database, but limits would be per
process). If you must run more, set `POWERPULSE_SCHEDULER=0` on all but one.

Keep it running with your platform's service manager, for example systemd:

```ini
[Service]
WorkingDirectory=/srv/powerpulse
ExecStart=/srv/powerpulse/.venv/bin/python run.py
Restart=on-failure
User=powerpulse
```

On Windows use NSSM or a Task Scheduler task "At startup" running `.venv\Scripts\python.exe run.py` in the project folder.

### Reverse proxy (Caddy example)

```
energy.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

nginx: `proxy_pass http://127.0.0.1:8000;` plus `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
and `proxy_set_header X-Forwarded-Proto $scheme;`, and `client_max_body_size 25m;` (uploads are capped at 20 MB).

The app already sends a strict Content-Security-Policy (no inline scripts), X-Frame-Options DENY, nosniff,
Referrer-Policy, Permissions-Policy, HSTS (on HTTPS) and `Cache-Control: no-store` on API responses, and gzips
responses over 1 KB.

## 4. Database and migrations

The database is `data/powerpulse.db` (override with `POWERPULSE_DB`). Migrations are numbered in
`backend/app/db.py` and applied automatically at startup inside a transaction; the version is SQLite's
`PRAGMA user_version`. `GET /api/health` reports it, e.g. `"database": "ok (schema v5)"`.

Upgrading:

1. Back up the database (below).
2. Stop the service, deploy the new code, `pip install -r requirements.txt`.
3. Start the service and check `/api/health` shows the new schema version.

Migrations only add tables, columns and indexes or correct data that was wrong; they never drop user data. (Tables and
columns from the removed WhatsApp feature are kept as they were, so no stored data was deleted.)

## 5. Backup and restore

Back up while running (SQLite's online backup is consistent even with WAL):

```bash
.venv/bin/python -c "import sqlite3; s=sqlite3.connect('data/powerpulse.db'); d=sqlite3.connect('backups/powerpulse-$(date +%F).db'); s.backup(d); d.close()"
```

Schedule it daily and copy the files off the machine. Also keep `.env` somewhere safe (it is not in the database).
`data/cache/` is disposable: it is rebuilt automatically.

Restore:

1. Stop the service.
2. Replace `data/powerpulse.db` with the backup and delete `data/powerpulse.db-wal` and `data/powerpulse.db-shm` if present.
3. Start the service; `/api/health` must return `ok`.

## 6. Monitoring

- `GET /api/health` - 200 with `ok: true` when the database answers; 503 otherwise. `worker` is `running`,
  `stopped` (needs attention) or `disabled`.
- Unexpected errors are logged with a traceback and a short reference; users see only "Something went wrong…
  quote reference XXXX", never internals.

## 7. Email

Without SMTP, password-reset links are written to the server log (never shown in the browser).

## 8. Before each release

CI (`.github/workflows/ci.yml`) runs lint, type checks, backend tests and the end-to-end suite on every push. Locally:

```bash
cd backend && ../.venv/bin/python -m pytest -q      # unit + integration
cd .. && node e2e/run.mjs                           # browser end-to-end + responsive/theme matrix (Chrome + Node 22)
```

Both use their own temporary databases. The E2E runner starts its own server on port
8765 (`E2E_PORT` to change) and writes results to `e2e/output/results.json`.

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Missing request header. Reload the page" (403) | A client called the API without `X-Requested-With: PowerPulse` (CSRF guard). Use the app, or add the header in scripts. |
| Everyone gets "Too many sign-in attempts" | The proxy's IP is seen as the client: set `POWERPULSE_TRUSTED_PROXIES` to the proxy address and forward `X-Forwarded-For`. Limits: `POWERPULSE_LOGIN_LIMIT_PER_IP`, `POWERPULSE_REGISTER_LIMIT_PER_IP`. |
| Sign-in succeeds but you're immediately signed out | With `POWERPULSE_APP_URL=https://…` cookies are `Secure`, so the site must be opened over HTTPS. For plain-HTTP testing use an `http://` URL (or `POWERPULSE_SECURE_COOKIES=0`). |
| First analysis takes ~10 s | Expected for the 4-year UCI home on a cold cache; later loads and other users with the same data are served from `data/cache/`. |
| `/api/health` says `worker: stopped` | The background thread died: check the log, restart the service. |
| Charts blank in a browser | A browser extension or proxy injecting scripts can be blocked by the CSP; check the console for "Content Security Policy" messages. |
