"""Water consumption API: records (manual / CSV / device / demo), summary, anomalies and device keys."""
import csv
import io
from datetime import date, datetime, timedelta

import pandas as pd
from fastapi import APIRouter, Body, Depends, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from . import anomaly_state, db, limits, security, user_settings
from .auth import current_user
from .engine import advisor
from .engine import water as engine
from .engine.loader import DataError

router = APIRouter(prefix="/api/water", tags=["water"])
MAX_INGEST = 1000


class ReadingIn(BaseModel):
    date: str
    value: float
    unit: str = "L"
    notes: str | None = None


# ---------------- service helpers ----------------
def _rows(conn, user_id):
    return conn.execute("SELECT ts, granularity, litres FROM water_readings WHERE user_id = ? ORDER BY ts", (user_id,)).fetchall()


def series(conn, user_id):
    """(daily litres Series, hourly litres Series) for the user."""
    return engine.series_from_rows((r["ts"], r["granularity"], r["litres"]) for r in _rows(conn, user_id))


def refresh(conn, user_id):
    """Re-run detection after any data change, store the anomaly set and evaluate notifications."""
    d, h = series(conn, user_id)
    events = engine.detect(d, h)
    with db.transaction(conn):
        conn.execute("DELETE FROM anomalies WHERE user_id = ? AND utility = 'water'", (user_id,))
        conn.executemany("INSERT OR IGNORE INTO anomalies (user_id, utility, dataset_id, event_key, type, severity, start_ts, end_ts, title, data, detected_at) "
                         "VALUES (?, 'water', NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
                         [(user_id, e["key"], e["type"], e["severity"], e["start"], e["end"], e["title"], db.dumps(e), db.now()) for e in events])
        anomaly_state.remember(conn, user_id, "water", [e["key"] for e in events])
    from . import notify
    notify.evaluate_user(conn, user_id)
    return events


def _value(v, unit):
    try:
        litres = engine.to_litres(v, unit)
    except DataError as e:
        raise HTTPException(422, str(e)) from e
    if not 0 <= litres <= engine.MAX_LITRES_DAY:
        raise HTTPException(422, f"Daily usage must be between 0 and {engine.MAX_LITRES_DAY:,.0f} L ({engine.MAX_LITRES_DAY / 1000:g} kL).")
    return round(litres, 2)


def _day(value):
    try:
        d = engine.parse_day(value)
    except DataError as e:
        raise HTTPException(422, str(e)) from e
    if d > date.today():
        raise HTTPException(422, "The date can't be in the future.")
    if d < date(2000, 1, 1):
        raise HTTPException(422, "The date is too far in the past.")
    return d.isoformat()


def _notes(n):
    n = (n or "").strip()
    if len(n) > 500:
        raise HTTPException(422, "Notes must be 500 characters or fewer.")
    return n or None


def _insert(conn, user_id, records, source, on_duplicate):
    """Insert records; on_duplicate 'skip' keeps existing rows, 'replace' overwrites them. Returns counts."""
    t = db.now()
    inserted = updated = skipped = 0
    with db.transaction(conn):
        for ts, gran, litres in records:
            if on_duplicate == "replace":
                n = conn.execute("UPDATE water_readings SET litres = ?, source = ?, updated_at = ? WHERE user_id = ? AND ts = ? AND granularity = ?",
                                 (litres, source, t, user_id, ts, gran)).rowcount
                if not n:
                    conn.execute("INSERT INTO water_readings (user_id, ts, granularity, litres, source, notes, created_at, updated_at) "
                                 "VALUES (?, ?, ?, ?, ?, NULL, ?, ?)", (user_id, ts, gran, litres, source, t, t))
                inserted += not n
                updated += n
            else:
                cur = conn.execute("INSERT OR IGNORE INTO water_readings (user_id, ts, granularity, litres, source, notes, created_at, updated_at) "
                                   "VALUES (?, ?, ?, ?, ?, NULL, ?, ?)", (user_id, ts, gran, litres, source, t, t))
                inserted += cur.rowcount
                skipped += 1 - cur.rowcount
    return {"inserted": inserted, "updated": updated, "skipped_duplicates": skipped}


def _owned_reading(conn, user_id, rid):
    r = conn.execute("SELECT * FROM water_readings WHERE id = ? AND user_id = ?", (rid, user_id)).fetchone()
    if not r:
        raise HTTPException(404, "Record not found.")
    return db.row(r)


# ---------------- records ----------------
@router.get("/readings")
def list_readings(limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0), source: str = Query("all"),
                  user=Depends(current_user)):
    where, args = "user_id = ?", [user["id"]]
    if source != "all":
        where += " AND source = ?"
        args.append(source)
    with db.connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM water_readings WHERE {where}", args).fetchone()[0]
        rows = conn.execute(f"SELECT id, ts, granularity, litres, source, notes, created_at, updated_at FROM water_readings WHERE {where} "
                            f"ORDER BY ts DESC LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
        counts = {r["source"]: r["n"] for r in conn.execute("SELECT source, COUNT(*) AS n FROM water_readings WHERE user_id = ? GROUP BY source", (user["id"],))}
    return {"total": total, "by_source": counts, "items": [dict(r) for r in rows]}


@router.post("/readings", status_code=201)
def add_reading(body: ReadingIn, user=Depends(current_user)):
    day, litres, notes = _day(body.date), _value(body.value, body.unit), _notes(body.notes)
    with db.connect() as conn:
        if conn.execute("SELECT 1 FROM water_readings WHERE user_id = ? AND granularity = 'day' AND ts = ?", (user["id"], day)).fetchone():
            raise HTTPException(409, f"There is already a daily entry for {day}. Edit that entry instead.")
        nxt = (date.fromisoformat(day) + timedelta(days=1)).isoformat()  # range query uses the (user_id, ts) index
        if conn.execute("SELECT 1 FROM water_readings WHERE user_id = ? AND granularity = 'hour' AND ts >= ? AND ts < ?", (user["id"], day, nxt)).fetchone():
            raise HTTPException(409, f"{day} already has hourly meter readings, which take priority over a manual daily total.")
        t = db.now()
        rid = conn.execute("INSERT INTO water_readings (user_id, ts, granularity, litres, source, notes, created_at, updated_at) "
                           "VALUES (?, ?, 'day', ?, 'manual', ?, ?, ?)", (user["id"], day, litres, notes, t, t)).lastrowid
        refresh(conn, user["id"])
        return dict(conn.execute("SELECT * FROM water_readings WHERE id = ?", (rid,)).fetchone())


@router.put("/readings/{rid}")
def edit_reading(rid: int, body: ReadingIn, user=Depends(current_user)):
    with db.connect() as conn:
        r = _owned_reading(conn, user["id"], rid)
        litres, notes = _value(body.value, body.unit), _notes(body.notes)
        ts = r["ts"]
        if r["granularity"] == "day":
            ts = _day(body.date)
            if ts != r["ts"] and conn.execute("SELECT 1 FROM water_readings WHERE user_id = ? AND granularity = 'day' AND ts = ?", (user["id"], ts)).fetchone():
                raise HTTPException(409, f"There is already a daily entry for {ts}.")
        elif litres > engine.MAX_LITRES_HOUR:
            raise HTTPException(422, f"An hourly reading can't exceed {engine.MAX_LITRES_HOUR:,.0f} L.")
        conn.execute("UPDATE water_readings SET ts = ?, litres = ?, notes = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                     (ts, litres, notes, db.now(), rid, user["id"]))
        refresh(conn, user["id"])
        return dict(conn.execute("SELECT * FROM water_readings WHERE id = ?", (rid,)).fetchone())


@router.delete("/readings/{rid}")
def delete_reading(rid: int, user=Depends(current_user)):
    with db.connect() as conn:
        _owned_reading(conn, user["id"], rid)
        conn.execute("DELETE FROM water_readings WHERE id = ? AND user_id = ?", (rid, user["id"]))
        refresh(conn, user["id"])
    return {"ok": True}


@router.delete("/readings")
def clear_readings(source: str = Query(...), user=Depends(current_user)):
    if source not in ("demo", "csv", "manual", "device", "all"):
        raise HTTPException(422, "Unknown source.")
    with db.connect() as conn:
        if source == "all":
            n = conn.execute("DELETE FROM water_readings WHERE user_id = ?", (user["id"],)).rowcount
        else:
            n = conn.execute("DELETE FROM water_readings WHERE user_id = ? AND source = ?", (user["id"], source)).rowcount
        refresh(conn, user["id"])
    return {"deleted": n}


async def _read_upload(file: UploadFile, unit: str, date_column: str, value_column: str):
    if not (file.filename or "").lower().endswith((".csv", ".txt")):
        raise HTTPException(422, "Please choose a .csv file.")
    if unit not in ("L", "kL"):
        raise HTTPException(422, "Unit must be L or kL.")
    content = await file.read(engine.MAX_BYTES + 1)
    return lambda: engine.parse_water_csv(content, unit, date_column or None, value_column or None)


def _existing(conn, user_id, records):
    """How many of these (ts, granularity) pairs the user already has."""
    have = {(r["ts"], r["granularity"]) for r in conn.execute(
        "SELECT ts, granularity FROM water_readings WHERE user_id = ? AND ts >= ? AND ts <= ?",
        (user_id, records[0][0], records[-1][0] + "T23:59:59"))} if records else set()
    return sum((ts, g) in have for ts, g, _ in records)


@router.post("/upload/preview")
async def upload_preview(file: UploadFile = File(...), unit: str = Form("L"), date_column: str = Form(""), value_column: str = Form(""),
                         user=Depends(current_user)):
    """Parse and validate without storing anything: mapping, row-level problems, a preview and the overlap with saved data."""
    parse = await _read_upload(file, unit, date_column, value_column)
    try:
        records, report = parse()
    except DataError as e:
        return {"ok": False, "file": file.filename, "error": str(e), **e.details}
    with db.connect() as conn:
        overlap = _existing(conn, user["id"], records)
    return {"ok": True, "file": file.filename, **report, "preview": [{"ts": ts, "granularity": g, "litres": v} for ts, g, v in records[:12]],
            "already_saved": overlap, "new_records": len(records) - overlap}


@router.post("/upload")
async def upload(file: UploadFile = File(...), unit: str = Form("L"), on_duplicate: str = Form("skip"), date_column: str = Form(""),
                 value_column: str = Form(""), user=Depends(current_user)):
    if on_duplicate not in ("skip", "replace"):
        raise HTTPException(422, "Invalid duplicate policy.")
    parse = await _read_upload(file, unit, date_column, value_column)
    try:
        records, report = parse()
    except DataError as e:
        raise HTTPException(422, str(e)) from e
    with db.connect() as conn:
        counts = _insert(conn, user["id"], records, "csv", on_duplicate)
        refresh(conn, user["id"])
    report.pop("preview_raw", None)
    return {"file": file.filename, **report, **counts}


@router.post("/demo")
def load_demo(user=Depends(current_user)):
    """Replace earlier demo rows with 60 days of clearly labelled synthetic hourly data ending now."""
    with db.connect() as conn:
        conn.execute("DELETE FROM water_readings WHERE user_id = ? AND source = 'demo'", (user["id"],))
        counts = _insert(conn, user["id"], engine.generate_demo(), "demo", "skip")
        refresh(conn, user["id"])
    return counts


# ---------------- analysis ----------------
def _bill(litres_month, tariff):
    return advisor.bill(litres_month / 1000.0, tariff)


@router.get("/summary")
def summary(user=Depends(current_user)):
    with db.connect() as conn:
        d, h = series(conn, user["id"])
        s = user_settings.get(conn, user["id"])
        lims = user_settings.limits(conn, user["id"])["water"]
        anomalies = anomaly_state.with_state([db.loads(r["data"], {}) for r in conn.execute(
            "SELECT data FROM anomalies WHERE user_id = ? AND utility = 'water' ORDER BY start_ts DESC", (user["id"],))],
            anomaly_state.states(conn, user["id"], "water"))
        anomaly_counts = anomaly_state.counts(conn, user["id"], "water")
    return {**build_summary(d, h, s, lims, anomalies), "anomaly_counts": anomaly_counts}


def build_summary(d, h, s, lims, anomalies):
    tariff, warn = s["water"]["tariff"], s["water"]["warn_pct"]
    if d.empty:
        return {"has_data": False, "unit_pref": s["water"]["unit"], "limits": lims, "warn_pct": warn, "tariff": tariff}
    latest = d.index.max()
    today = pd.Timestamp(date.today())
    last7 = d[d.index > latest - pd.Timedelta(days=7)]
    last30 = d[d.index > latest - pd.Timedelta(days=30)]
    month = d[d.index.to_period("M") == latest.to_period("M")]
    days_in_month = latest.days_in_month
    month_proj = float(month.mean()) * days_in_month if len(month) else 0.0
    typical_month = float(last30.mean()) * 30.44
    complete_days = d[d.index < today] if latest == today else d
    hi = complete_days.idxmax() if not complete_days.empty else latest
    hourly_today = h[h.index.normalize() == latest] if not h.empty else h
    profile = None
    if not h.empty:
        hh = h[h.index > h.index.max() - pd.Timedelta(days=30)]
        profile = [round(float(v), 1) if pd.notna(v) else None for v in hh.groupby(hh.index.hour).mean().reindex(range(24))]
    weekly = d.resample("W-SUN").sum()
    monthly = d.resample("MS").sum()
    tail = d[d.index > latest - pd.Timedelta(days=90)]
    return {
        "has_data": True, "unit_pref": s["water"]["unit"], "warn_pct": warn, "limits": lims, "tariff": tariff,
        "latest_day": latest.strftime("%Y-%m-%d"), "latest_is_today": bool(latest == today),
        "latest_hours": int(len(hourly_today)) if not h.empty else None,
        "latest_litres": round(float(d.iloc[-1]), 1),
        "limit_status": limits.status(float(d.iloc[-1]), limits.limit_for(lims, latest), warn),
        "total_litres": round(float(d.sum()), 1), "days": int(len(d)),
        "start": d.index.min().strftime("%Y-%m-%d"),
        "avg_daily": round(float(last30.mean()), 1), "week_litres": round(float(last7.sum()), 1),
        "month": latest.strftime("%Y-%m"), "month_litres": round(float(month.sum()), 1), "month_days": int(len(month)),
        "highest_day": {"day": hi.strftime("%Y-%m-%d"), "litres": round(float(d[hi]), 1)},
        "cost": {"month_to_date": round(_bill(float(month.sum()), tariff), 0), "month_projected": round(_bill(month_proj, tariff), 0),
                 "typical_month": round(_bill(typical_month, tariff), 0), "typical_month_litres": round(typical_month, 0)},
        "violations_30d": limits.violations(last30, lims),
        "daily": {"t": [x.strftime("%Y-%m-%d") for x in tail.index], "litres": [round(float(v), 1) for v in tail],
                  "limit": limits.limit_series(tail.index, lims)},
        "weekly": [{"week_end": x.strftime("%Y-%m-%d"), "litres": round(float(v), 1)} for x, v in weekly.tail(12).items()],
        "monthly": [{"month": x.strftime("%Y-%m"), "litres": round(float(v), 1)} for x, v in monthly.tail(12).items()],
        "hourly_profile": profile, "has_hourly": not h.empty,
        "anomalies": anomalies,
        **_parity(d, h, s, lims, anomalies),
    }


def _parity(d, h, s, lims, anomalies):
    """Water equivalents of the electricity analysis: monthly bills, savings recommendations, patterns, rules."""
    tariff = s["water"]["tariff"]
    recs = engine.recommend(anomalies, d, tariff, advisor)
    done = s.get("checklists", {}).get("water", {})
    for r in recs:
        r["done"] = [i for i in done.get(r["key"], []) if i < len(r["steps"])]
    typical_kl = float(d.tail(30).mean()) * engine.DAYS_PER_MONTH / 1000
    return {
        "monthly_costs": engine.monthly_costs(d, anomalies, tariff, lims, advisor, limits),
        "recommendations": recs,
        "potential_savings_month": round(sum(r["inr_month"] for r in recs), 0),
        "potential_litres_month": round(sum(r["litres_month"] for r in recs), 0),
        "marginal_rate": advisor.marginal_rate(typical_kl, tariff),
        "effective_rate": round(advisor.bill(typical_kl, tariff) / typical_kl, 2) if typical_kl else 0,
        "anomaly_litres_total": round(sum(engine.event_excess_litres(e) for e in anomalies), 0),
        "patterns": engine.patterns(d, h),
        "rules": engine.RULES,
    }


def safe_cell(text: str) -> str:
    """Stop spreadsheet apps from executing user text as a formula (CSV injection)."""
    return "'" + text if text[:1] in ("=", "+", "-", "@", chr(9), chr(13)) else text


@router.get("/export.csv")
def export_csv(user=Depends(current_user)):
    """All of the user's water readings (litres) - re-uploadable."""
    with db.connect() as conn:
        rows = conn.execute("SELECT ts, granularity, litres, source, notes FROM water_readings WHERE user_id = ? ORDER BY ts", (user["id"],)).fetchall()
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["timestamp", "granularity", "litres", "source", "notes"])
    w.writerows([r["ts"], r["granularity"], r["litres"], r["source"], safe_cell(r["notes"] or "")] for r in rows)
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="powerpulse-water.csv"'})


@router.get("/anomalies")
def anomalies(user=Depends(current_user)):
    with db.connect() as conn:
        return anomaly_state.with_state([db.loads(r["data"], {}) for r in conn.execute(
            "SELECT data FROM anomalies WHERE user_id = ? AND utility = 'water' ORDER BY start_ts DESC", (user["id"],))],
            anomaly_state.states(conn, user["id"], "water"))


# ---------------- smart meter / IoT ingestion ----------------
@router.get("/devices")
def devices(user=Depends(current_user)):
    with db.connect() as conn:
        return [dict(r) for r in conn.execute("SELECT id, name, prefix, created_at, last_used_at FROM device_keys WHERE user_id = ? ORDER BY id",
                                              (user["id"],))]


@router.post("/devices", status_code=201)
def add_device(name: str = Body(..., embed=True), user=Depends(current_user)):
    name = " ".join((name or "").split())[:60]
    if not name:
        raise HTTPException(422, "Give the device a name.")
    key = "ppw_" + security.new_token(24)
    with db.connect() as conn:
        if conn.execute("SELECT COUNT(*) FROM device_keys WHERE user_id = ?", (user["id"],)).fetchone()[0] >= 10:
            raise HTTPException(409, "You can register up to 10 devices.")
        did = conn.execute("INSERT INTO device_keys (user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)",
                           (user["id"], name, security.token_hash(key), key[:8], db.now())).lastrowid
    return {"id": did, "name": name, "key": key, "note": "Copy this key now - it is shown only once."}


@router.delete("/devices/{did}")
def remove_device(did: int, user=Depends(current_user)):
    with db.connect() as conn:
        n = conn.execute("DELETE FROM device_keys WHERE id = ? AND user_id = ?", (did, user["id"])).rowcount
    if not n:
        raise HTTPException(404, "Device not found.")
    return {"ok": True}


@router.post("/ingest")
def ingest(payload: dict = Body(...), x_device_key: str = Header(None)):
    """Smart-meter / IoT endpoint. Header X-Device-Key; body {"readings": [{"ts": ISO hour, "litres": n} | {"ts", "value", "unit"}]}.
    Each reading is an hourly total; re-sending an hour replaces it, so retries are safe."""
    if not x_device_key:
        raise HTTPException(401, "Missing X-Device-Key header.")
    with db.connect() as conn:
        dev = conn.execute("SELECT * FROM device_keys WHERE key_hash = ?", (security.token_hash(x_device_key),)).fetchone()
        if not dev:
            raise HTTPException(401, "Unknown device key.")
        items = payload.get("readings")
        if not isinstance(items, list) or not 1 <= len(items) <= MAX_INGEST:
            raise HTTPException(422, f"Send 'readings' as a list of 1-{MAX_INGEST} items.")
        records, errors = [], []
        horizon = datetime.now() + timedelta(hours=1)
        for i, it in enumerate(items):
            try:
                ts = pd.Timestamp(it["ts"])
                if ts.tzinfo is not None:
                    ts = ts.tz_convert(None)
                ts = ts.floor("h")
                litres = engine.to_litres(it["litres"], "L") if "litres" in it else engine.to_litres(it["value"], it.get("unit", "L"))
                if ts > pd.Timestamp(horizon) or not 0 <= litres <= engine.MAX_LITRES_HOUR:
                    raise ValueError("out of range")
                records.append((ts.strftime("%Y-%m-%dT%H:00:00"), "hour", round(litres, 2)))
            except (KeyError, ValueError, TypeError, DataError) as e:
                errors.append({"index": i, "error": str(e) or "invalid reading"})
        counts = _insert(conn, dev["user_id"], records, "device", "replace") if records else {"inserted": 0, "updated": 0}
        conn.execute("UPDATE device_keys SET last_used_at = ? WHERE id = ?", (db.now(), dev["id"]))
        if records:
            refresh(conn, dev["user_id"])
    return {**counts, "rejected": errors}
