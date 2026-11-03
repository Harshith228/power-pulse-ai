# API documentation

All endpoints live under `/api` and exchange JSON unless noted. The running app also serves interactive OpenAPI docs at **`/docs`** (hidden when `POWERPULSE_HIDE_API_DOCS=1`). This file lists every endpoint that exists in this release (73 operations).

## Conventions

- **Authentication:** a session cookie set by `register` / `login`. All endpoints need it **except** `GET /api/health`, `GET /api/sources`, `GET /api/samples[/{name}]`, the auth entry points (`register`, `login`, `forgot`, `reset`) and `POST /api/water/ingest` (device key instead).
- **CSRF:** every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) must send the header `X-Requested-With: PowerPulse`, otherwise 403.
- **Isolation:** every query is scoped to the signed-in user. Another user's resource returns **404**.
- **Errors:** `{"detail": "message"}` with 400 / 401 / 403 / 404 / 409 / 422 / 429. Unexpected errors return 500 with a short reference code (details only in the server log).
- **Units:** electricity in kWh; water stored in litres (`unit` may be `L` or `kL` on input).
- `utility` path parameters are `electricity` or `water`.

## Health and public data

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | `{"ok", "database": "ok (schema vN)", "worker": "running|stopped|disabled"}`; 503 when the database is unreachable or the worker died |
| GET | `/api/sources` | Available electricity data sources |
| GET | `/api/samples` | List of downloadable sample CSV files |
| GET | `/api/samples/{name}` | Download one sample CSV |

## Authentication and account

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/auth/register` | `{name, email, password, remember?}` | Create an account and sign in (password ≥ 8 characters; rate-limited per IP) |
| POST | `/api/auth/login` | `{email, password, remember?}` | Sign in; `remember` extends the session to 30 days (rate-limited per IP) |
| POST | `/api/auth/logout` | - | End this session |
| POST | `/api/auth/logout-others` | - | End every other session |
| GET | `/api/auth/me` | - | Current user |
| GET | `/api/auth/sessions` | - | Active sessions (device, created, expires) |
| PATCH | `/api/auth/profile` | `{name?, email?, current_password?}` | Update profile (changing email needs the current password) |
| POST | `/api/auth/password` | `{current_password, new_password}` | Change password |
| POST | `/api/auth/forgot` | `{email}` | Send a reset link (email via SMTP, or server log); same response whether or not the account exists |
| POST | `/api/auth/reset` | `{token, password}` | Set a new password with a single-use token (30 minutes) |
| GET | `/api/auth/export` | - | JSON export of the account: profile, settings, limits, dataset list, water readings, anomalies, notifications |
| POST | `/api/auth/delete-account` | `{password}` | Permanently delete the account and its data |

## Electricity datasets

| Method | Path | Description |
|---|---|---|
| GET | `/api/datasets` | The user's datasets |
| GET | `/api/datasets/active` | Analysis of the active dataset (404 when none) |
| POST | `/api/datasets/upload` | Multipart `file` (CSV, ≤ 20 MB): parse, clean, analyse, activate |
| POST | `/api/datasets/validate` | Multipart `file`: data-quality report without saving |
| POST | `/api/datasets/uci` | Load the public UCI household |
| POST | `/api/datasets/scenario` | `{scenario?, base?, seed?}` - synthetic household with labelled injected anomalies (validation lab) |
| GET | `/api/datasets/{ds_id}` | Full analysis of one dataset |
| DELETE | `/api/datasets/{ds_id}` | Delete a dataset |
| POST | `/api/datasets/{ds_id}/activate` | Make it the active dataset |
| PUT | `/api/datasets/{ds_id}/tariff` | Tariff `{name, fixed_monthly, slabs: [{upto, rate}]}` (stored as the user's electricity tariff) |
| GET | `/api/datasets/{ds_id}/report.html` | Printable anomaly report (`?download=1` to save) |
| GET | `/api/datasets/{ds_id}/report.csv` | Anomalies as CSV |
| GET | `/api/datasets/{ds_id}/data.csv` | Cleaned hourly data as CSV |

## Manual electricity readings

| Method | Path | Body / query | Description |
|---|---|---|---|
| GET | `/api/electricity/readings` | `?limit&offset` | Readings with *counted / not counted* status |
| POST | `/api/electricity/readings` | `{date, time?, kwh, source?, notes?}` | Add a reading. `time` = `HH:00` or empty for a whole-day total; `source` = `manual`, `smart_meter`, `other`. 409 if that day/hour already has a figure |
| PUT | `/api/electricity/readings/{rid}` | same | Edit |
| DELETE | `/api/electricity/readings/{rid}` | - | Delete |
| GET | `/api/electricity/usage` | `?days` | Daily series combining imported and manual data, by source |

## Anomalies (read state)

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/api/anomalies/counts` | - | Unread counts per utility (sidebar badges) |
| GET | `/api/anomalies/electricity` | - | Electricity anomalies with read state |
| POST | `/api/anomalies/{utility}/read` | `{keys: [...], read?: true}` | Mark specific anomalies read / unread |
| POST | `/api/anomalies/{utility}/read-all` | - | Mark all read |

## Water

| Method | Path | Body / query | Description |
|---|---|---|---|
| GET | `/api/water/readings` | `?limit&offset&source` | Readings |
| POST | `/api/water/readings` | `{date, value, unit?, notes?}` | Add a daily reading (`unit` `L` or `kL`) |
| PUT | `/api/water/readings/{rid}` | same | Edit |
| DELETE | `/api/water/readings/{rid}` | - | Delete one |
| DELETE | `/api/water/readings` | `?source=` (required) | Delete all readings from one source (e.g. `demo`) |
| POST | `/api/water/upload/preview` | multipart `file, unit?, date_column?, value_column?` | Validate a CSV **without saving**: detected columns, ready rows, duplicates, every rejected row by line number |
| POST | `/api/water/upload` | multipart `file, unit?, on_duplicate?, date_column?, value_column?` | Import (`on_duplicate` = `skip` keeps existing dates, `replace` overwrites them) |
| POST | `/api/water/demo` | - | Load demo water data |
| GET | `/api/water/summary` | - | Totals, trends, limits, tariff costs |
| GET | `/api/water/anomalies` | - | Water anomalies with explanations and checks |
| GET | `/api/water/export.csv` | - | All water readings as CSV |
| GET | `/api/water/devices` | - | Smart-meter device keys (prefix only) |
| POST | `/api/water/devices` | `{name}` | Create a device key - the full key is shown **once** |
| DELETE | `/api/water/devices/{did}` | - | Revoke a device key |
| POST | `/api/water/ingest` | header `X-Device-Key`; `{"readings": [{"ts": "<ISO hour>", "litres": n}]}` (or `value` + `unit`) | Smart-meter push; no session or CSRF header needed |

## Settings and limits

| Method | Path | Body / query | Description |
|---|---|---|---|
| GET | `/api/settings` | - | All per-user settings (tariffs, notifications, report schedule, detection thresholds, appearance) and limits |
| PATCH | `/api/settings` | partial settings object | Update settings; detection changes re-run the analysis |
| PUT | `/api/limits/{utility}` | `{"default": n|null, "weekdays": {"0": n|null, ...}}` | Daily limits (kWh or litres) |
| GET | `/api/limits/{utility}/history` | `?days` | Daily use vs limit, violations |
| PUT | `/api/checklists` | `{dataset_id, key, done}` | Save progress on a recommendation checklist |

## Notifications

| Method | Path | Body / query | Description |
|---|---|---|---|
| GET | `/api/notifications` | `?category&status&limit&offset` | Notification centre (`category` electricity / water / report / account; `status` read / unread) |
| POST | `/api/notifications/read` | `{ids?: [...], all?: true}` | Mark read |
| POST | `/api/notifications/unread` | `{ids: [...]}` | Mark unread |
| POST | `/api/notifications/evaluate` | - | Re-evaluate limits and anomalies now (de-duplicated) |

## Household overview

| Method | Path | Description |
|---|---|---|
| GET | `/api/household/summary` | Electricity + water KPIs for the overview page |

## Reports

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/api/reports` | - | Monthly reports, custom reports, schedule status, available periods |
| POST | `/api/reports/custom` | `{kind?: "combined"|"electricity"|"water", start, end}` | Generate a report for a date range (≤ 1 year, not in the future). 201 with the report; 422 when the range has no data for that type |
| GET | `/api/reports/custom/{rid}` | - | Stored custom report |
| GET | `/api/reports/custom/{rid}/pdf` | - | PDF download, e.g. `PowerPulse_Combined_Report_October_2026.pdf` |
| GET | `/api/reports/custom/{rid}/csv` | - | CSV download (daily figures, limits and over-limit flags) |
| DELETE | `/api/reports/custom/{rid}` | - | Delete a custom report |
| POST | `/api/reports/generate` | `{period: "YYYY-MM"}` | Generate (or regenerate) a calendar-month report |
| GET | `/api/reports/{period}` | - | Stored monthly report |
| GET | `/api/reports/{period}/pdf` | - | Monthly report PDF |
| GET | `/api/reports/{period}/csv` | - | Monthly report CSV (409 for reports generated before daily figures were stored) |

## Page routes (HTML)

`/` landing · `/login`, `/register`, `/forgot-password`, `/reset-password` (redirect to `/dashboard` when signed in) · `/dashboard` (redirects to `/login` when signed out).

## Example

```bash
# sign in, keep the cookie, then call an authenticated endpoint
curl -c jar.txt -H "Content-Type: application/json" -H "X-Requested-With: PowerPulse" \
     -d '{"email":"you@example.com","password":"<your password>"}' http://127.0.0.1:8000/api/auth/login
curl -b jar.txt http://127.0.0.1:8000/api/household/summary
```
