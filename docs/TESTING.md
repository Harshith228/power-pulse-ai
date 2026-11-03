# Testing

| Suite | Tool | Where | What it uses |
|---|---|---|---|
| Backend unit + integration | pytest + FastAPI `TestClient` (httpx) | `backend/tests/` | A temporary SQLite database per run; never the real `data/powerpulse.db` |
| End-to-end + responsive | Node.js 22+ driving Chrome/Edge over the DevTools Protocol | `e2e/run.mjs` | Its own server on port 8765 with a throwaway database and generated test data |
| Static checks | ruff, mypy, oxlint, `node --check` | whole repo | - |
| Dependency audit | pip-audit | `requirements.txt` | - |

No suite uses real user data, sends email, or contacts external services (SMTP is unset in tests, so password-reset links go to the log).

## Backend tests

```bash
cd backend
../.venv/bin/python -m pytest -q          # Windows: ..\.venv\Scripts\python -m pytest -q
```

| File | Covers |
|---|---|
| `test_engine.py` | Normal household raises no alerts, injected anomalies found with the right type, explanations and circuit attribution, slab billing, CSV loading / cleaning / rejection, analysis API end to end |
| `test_platform.py` | Register / login / logout and protected routes, CSRF guard, password change and reset, per-user isolation, limits and de-duplicated notifications, water entries / CSV / demo / device ingest, monthly report calculations, PDF and scheduler, detection settings and the night-time rule, checklists, account export and delete, theme preference, removal of the WhatsApp feature |
| `test_production.py` | Rate limits, security headers / CSP / HSTS, no inline scripts, gzip, errors that don't leak internals, health check, cleanup of expired sessions and tokens, CSV formula neutralisation, migration from v1 preserving data, detection cache sharing and tamper detection, every data endpoint requiring a session |
| `test_manual_and_read_state.py` | Manual electricity readings, no double counting, daily spike detection, anomaly read / unread state |
| `test_water_import.py` | Water CSV preview and import: column detection, units, rejected rows, duplicates, refusal of electricity files |
| `test_reports_content.py` | Monthly reports state a missing utility instead of inventing figures, respect report-type settings, and never render header-only tables |
| `test_custom_reports.py` | On-request reports: validation, no-data handling, meaningful filenames, PDF / CSV downloads |

Last local run: **105 passed**.

## End-to-end tests

```bash
node e2e/run.mjs
```

Environment: `CHROME_PATH` (browser binary), `CHROME_ARGS` (extra browser flags, e.g. `--no-sandbox` on CI), `PYTHON` (interpreter; default `.venv`), `E2E_PORT` (default 8765), `E2E_KEEP=1` keeps the temporary folder.

The journey: register → sign out → sign in → every page → electricity upload → analytics → manual readings → water CSV import (native file picker, preview, cancel, electricity-file refusal, confirm) → limits → a water spike → notifications and unread badges → monthly reports (generate without downloading, real PDF and CSV downloads with meaningful names, CSV totals match the report, no-data and invalid-range errors) → settings (report schedule saves and persists) → theme → sign out. Then every page at 1920, 1440, 1024, 768, 390 and 360 px in light, dark and system themes (no horizontal scroll, navigation drawer, no phantom page height), and finally no Content-Security-Policy violations or console errors.

Results: `e2e/output/results.json` and screenshots in `e2e/output/` (git-ignored). Last local run: **178 passed, 0 failed**.

## Static checks

```bash
pip install ruff mypy pip-audit
ruff check backend
cd backend && mypy app --ignore-missing-imports && cd ..
pip-audit -r requirements.txt
npx oxlint@1.90.0 frontend/js e2e
for f in $(find frontend/js e2e -name '*.js' -o -name '*.mjs'); do node --check "$f"; done
```

The frontend has no bundling step, so the "production build" check is lint + a syntax check of every module (what the browser will load).

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push and pull request:

| Job | Steps |
|---|---|
| `backend` (Python 3.12 and 3.13) | install requirements, ruff, mypy, pytest |
| `frontend` | oxlint, `node --check` on every module |
| `e2e` | full browser journey with the runner's Chrome; uploads `e2e/output/` as an artifact |

CI needs no secrets.
