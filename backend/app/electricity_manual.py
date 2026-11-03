"""Manually entered electricity readings: validation, storage, how they combine with imported data, and daily-level
anomaly checks once there is enough history.

Data-source strategy - one figure per day, never two:
- Imported data (the active dataset: a CSV upload, the UCI household, a smart-meter export) is authoritative for every
  day it covers. Imported rows are never changed by anything here.
- A manual reading for a day the active dataset already covers is kept and listed, but marked "not counted", so the
  same day is never counted twice.
- Manual readings for every other day fill in the daily series behind the overview, daily limits, costs, monthly
  reports and limit alerts (`electricity.daily_series`).
- A day's manual figure is its whole-day total if one was entered, otherwise the sum of its hourly entries; a day
  can't hold both, so a total and its own hours can't be added together.

Anomaly checks on manual data work on daily totals only (no hourly profile, no appliance attribution) and need at
least MIN_HISTORY_DAYS days of earlier data in the 28 days before a day - a single reading is never enough.
"""
import math
from datetime import date, datetime
from typing import Literal

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from . import anomaly_state, db, user_settings
from .auth import current_user
from .engine import advisor
from .engine.loader import MAX_HOURLY_KWH

router = APIRouter(prefix="/api/electricity", tags=["electricity-manual"])

MAX_DAILY_KWH = 500.0          # far above any home's day; larger values are almost always a meter's running total
MIN_HISTORY_DAYS = 14
WINDOW_DAYS = 28
SPIKE_RATIO, SPIKE_Z, SPIKE_MIN_KWH = 1.5, 3.5, 2.0
SOURCES = {"manual": "Manual entry", "smart_meter": "Smart meter", "other": "Other"}
CHECKS = [
    "Compare the meter reading with the day before to rule out a typing or reading mistake.",
    "Think about what ran that day: AC or heater, geyser, washing machine, guests, an EV or inverter charging.",
    "Check for something left on - a heater, iron, pump or water heater - and for a fridge door not closing.",
    "If it repeats, read the meter hourly for a day to see when the extra load happens.",
]


class ReadingIn(BaseModel):
    date: str
    time: str | None = None      # "HH:00" for an hourly reading; empty = whole-day total
    kwh: float
    source: Literal["manual", "smart_meter", "other"] = "manual"
    notes: str | None = None


# ---------------- validation ----------------
def _day(v):
    try:
        d = date.fromisoformat(str(v).strip()[:10])
    except ValueError:
        raise HTTPException(422, "Enter the date as YYYY-MM-DD.") from None
    if d > date.today():
        raise HTTPException(422, "The date can't be in the future.")
    if d.year < 2000:
        raise HTTPException(422, "The date must be in the year 2000 or later.")
    return d.isoformat()


def _hour(v, day):
    if v is None or str(v).strip() == "":
        return -1
    try:
        t = datetime.strptime(str(v).strip()[:5], "%H:%M")
    except ValueError:
        raise HTTPException(422, "Enter the time as HH:MM, e.g. 18:00.") from None
    if t.minute:
        raise HTTPException(422, "Hourly readings cover a whole hour: use a time on the hour, e.g. 18:00 for 18:00-19:00.")
    now = datetime.now()
    if day == now.date().isoformat() and t.hour > now.hour:
        raise HTTPException(422, "That hour hasn't happened yet.")
    return t.hour


def _kwh(v, hour):
    if v is None or not math.isfinite(v):
        raise HTTPException(422, "Enter the electricity used in kWh as a number.")
    if v < 0:
        raise HTTPException(422, "Electricity used can't be negative.")
    cap = MAX_HOURLY_KWH if hour >= 0 else MAX_DAILY_KWH
    if v > cap:
        raise HTTPException(422, f"{v:,.1f} kWh in one {'hour' if hour >= 0 else 'day'} isn't plausible for a home (limit {cap:,.0f}). "
                                 "Enter the units used, not the meter's running total.")
    return round(float(v), 3)


def _notes(v):
    v = (v or "").strip()
    if len(v) > 500:
        raise HTTPException(422, "Notes can be at most 500 characters.")
    return v or None


def _label(day, hour):
    d = date.fromisoformat(day).strftime("%d %b %Y")
    return f"{d} {hour:02d}:00" if hour >= 0 else f"{d} (whole day)"


def _check_duplicates(conn, user_id, day, hour, exclude_id=None):
    """Refuse a second figure for the same day or hour, and a day mixing a whole-day total with hourly entries."""
    rows = conn.execute("SELECT id, hour, kwh FROM electricity_readings WHERE user_id = ? AND day = ? AND id IS NOT ?",
                        (user_id, day, exclude_id)).fetchall()
    for r in rows:
        if r["hour"] == hour:
            raise HTTPException(409, f"You already entered {r['kwh']:g} kWh for {_label(day, hour)}. Edit or delete that entry instead.")
    if hour == -1 and any(r["hour"] >= 0 for r in rows):
        raise HTTPException(409, f"{date.fromisoformat(day).strftime('%d %b %Y')} already has hourly entries. Add another hour, or delete them before entering a whole-day total.")
    if hour >= 0 and any(r["hour"] == -1 for r in rows):
        raise HTTPException(409, f"{_label(day, -1)} is already recorded as a whole-day total. Edit that total instead of adding hours.")


# ---------------- combining with imported data ----------------
def imported_days(conn, user_id):
    ds = conn.execute("SELECT id FROM datasets WHERE user_id = ? AND is_active = 1", (user_id,)).fetchone()
    if not ds:
        return set()
    return {r[0] for r in conn.execute("SELECT day FROM electricity_daily WHERE dataset_id = ?", (ds["id"],))}


def manual_daily(conn, user_id) -> tuple[dict[str, float], dict[str, int]]:
    """{day: kWh} and {day: hours covered} from the user's manual readings."""
    kwh: dict[str, float] = {}
    hours: dict[str, int] = {}
    for r in conn.execute("SELECT day, hour, kwh FROM electricity_readings WHERE user_id = ?", (user_id,)):
        kwh[r["day"]] = kwh.get(r["day"], 0.0) + r["kwh"]
        hours[r["day"]] = 24 if r["hour"] == -1 else hours.get(r["day"], 0) + 1
    return kwh, hours


def combine(imported: dict, imported_hours: dict, manual: dict, manual_hours: dict) -> pd.Series:
    """One kWh figure per day: imported data wins, manual readings fill the other days. attrs: hours, sources."""
    days = sorted(set(imported) | set(manual))
    vals, hours, sources = [], {}, {}
    for d in days:
        if d in imported:
            vals.append(imported[d])
            hours[d], sources[d] = imported_hours.get(d), "imported"
        else:
            vals.append(manual[d])
            hours[d], sources[d] = manual_hours.get(d), "manual"
    s = pd.Series(vals, index=pd.to_datetime(days), dtype=float)
    s.attrs["hours"], s.attrs["sources"] = hours, sources
    return s


# ---------------- daily anomaly checks on manual data ----------------
def _severity(ratio):
    return "critical" if ratio >= 3.0 else "high" if ratio >= 2.2 else "medium" if ratio >= 1.8 else "low"


def detect(s: pd.Series):
    """Daily spikes on the days whose figure comes from manual readings. Needs MIN_HISTORY_DAYS earlier days."""
    sources = s.attrs.get("sources", {})
    events = []
    for t, v in s.items():
        day = t.strftime("%Y-%m-%d")
        if sources.get(day) != "manual":
            continue
        hist = s[(s.index < t) & (s.index >= t - pd.Timedelta(days=WINDOW_DAYS))]
        if len(hist) < MIN_HISTORY_DAYS:
            continue
        med = float(hist.median())
        mad = float((hist - med).abs().median()) * 1.4826
        scale = max(mad, 0.1 * med, 0.3)
        z = (v - med) / scale
        if med <= 0 or v < SPIKE_RATIO * med or z < SPIKE_Z or v - med < SPIKE_MIN_KWH:
            continue
        ratio = v / med
        events.append({
            "key": f"manual:spike:{day}", "type": "spike", "granularity": "day", "data_source": "manual",
            "title": f"Daily use {v:.1f} kWh, {ratio:.1f}× normal", "severity": _severity(ratio),
            "start": f"{day}T00:00:00", "end": f"{day}T23:00:00", "duration_hours": 24, "days": 1,
            "actual_kwh": round(float(v), 2), "expected_kwh": round(med, 2), "excess_kwh": round(float(v) - med, 2),
            "ratio": round(ratio, 2), "z": round(z, 1), "deviation_pct": round((ratio - 1) * 100), "origin": "observed",
            "factors": [f"{day}: {v:.1f} kWh against a typical {med:.1f} kWh (median of the {len(hist)} days with data in the 4 weeks before).",
                        f"{z:.1f} robust standard deviations above normal; flagged at {SPIKE_Z} or more and at least {SPIKE_RATIO}× typical.",
                        "Based on daily totals you entered, so it can't tell which hour or appliance caused it."],
            "checks": CHECKS,
        })
    events.sort(key=lambda e: (["critical", "high", "medium", "low"].index(e["severity"]), -e["excess_kwh"]))
    for i, e in enumerate(events, 1):
        e["id"] = f"m{i}"
    return events


def refresh(conn, user_id):
    """Re-run the manual-data checks after any change, store them and evaluate notifications (limits included)."""
    from . import electricity, notify
    s, _ = electricity.daily_series(conn, user_id)
    events = detect(s)
    with db.transaction(conn):
        conn.execute("DELETE FROM anomalies WHERE user_id = ? AND utility = 'electricity' AND dataset_id = 'manual'", (user_id,))
        conn.executemany(
            "INSERT OR IGNORE INTO anomalies (user_id, utility, dataset_id, event_key, type, severity, start_ts, end_ts, title, data, detected_at) "
            "VALUES (?, 'electricity', 'manual', ?, ?, ?, ?, ?, ?, ?, ?)",
            [(user_id, e["key"], e["type"], e["severity"], e["start"], e["end"], e["title"], db.dumps(e), db.now()) for e in events])
        anomaly_state.remember(conn, user_id, "electricity", [e["key"] for e in events])
    notify.evaluate_user(conn, user_id)
    return events


def stored_events(conn, user_id):
    return [db.loads(r["data"], {}) for r in conn.execute(
        "SELECT data FROM anomalies WHERE user_id = ? AND utility = 'electricity' AND dataset_id = 'manual' ORDER BY start_ts DESC", (user_id,))]


# ---------------- API ----------------
def _owned(conn, user_id, rid):
    r = conn.execute("SELECT * FROM electricity_readings WHERE id = ? AND user_id = ?", (rid, user_id)).fetchone()
    if not r:
        raise HTTPException(404, "Reading not found.")
    return db.row(r)


def _out(r, covered):
    counted = r["day"] not in covered
    return {**dict(r), "time": f"{r['hour']:02d}:00" if r["hour"] >= 0 else None, "source_label": SOURCES[r["source"]],
            "counted": counted,
            "status": "Counted" if counted else "Not counted - imported data already covers this day"}


def _validated(body: ReadingIn):
    day = _day(body.date)
    hour = _hour(body.time, day)
    return day, hour, _kwh(body.kwh, hour), _notes(body.notes)


@router.get("/readings")
def list_readings(limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0), user=Depends(current_user)):
    with db.connect() as conn:
        covered = imported_days(conn, user["id"])
        total = conn.execute("SELECT COUNT(*) FROM electricity_readings WHERE user_id = ?", (user["id"],)).fetchone()[0]
        rows = conn.execute("SELECT * FROM electricity_readings WHERE user_id = ? ORDER BY day DESC, hour DESC LIMIT ? OFFSET ?",
                            (user["id"], limit, offset)).fetchall()
        kwh, _ = manual_daily(conn, user["id"])
    counted_days = [d for d in kwh if d not in covered]
    return {"total": total, "items": [_out(r, covered) for r in rows],
            "days": len(kwh), "counted_days": len(counted_days), "not_counted_days": len(kwh) - len(counted_days),
            "detection": {"min_days": MIN_HISTORY_DAYS, "ready": len(counted_days) > MIN_HISTORY_DAYS}}


@router.post("/readings", status_code=201)
def add_reading(body: ReadingIn, user=Depends(current_user)):
    day, hour, kwh, notes = _validated(body)
    with db.connect() as conn:
        _check_duplicates(conn, user["id"], day, hour)
        t = db.now()
        rid = conn.execute("INSERT INTO electricity_readings (user_id, day, hour, kwh, source, notes, created_at, updated_at) "
                           "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (user["id"], day, hour, kwh, body.source, notes, t, t)).lastrowid
        refresh(conn, user["id"])
        return _out(_owned(conn, user["id"], rid), imported_days(conn, user["id"]))


@router.put("/readings/{rid}")
def edit_reading(rid: int, body: ReadingIn, user=Depends(current_user)):
    day, hour, kwh, notes = _validated(body)
    with db.connect() as conn:
        _owned(conn, user["id"], rid)
        _check_duplicates(conn, user["id"], day, hour, exclude_id=rid)
        conn.execute("UPDATE electricity_readings SET day = ?, hour = ?, kwh = ?, source = ?, notes = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                     (day, hour, kwh, body.source, notes, db.now(), rid, user["id"]))
        refresh(conn, user["id"])
        return _out(_owned(conn, user["id"], rid), imported_days(conn, user["id"]))


@router.delete("/readings/{rid}")
def delete_reading(rid: int, user=Depends(current_user)):
    with db.connect() as conn:
        _owned(conn, user["id"], rid)
        conn.execute("DELETE FROM electricity_readings WHERE id = ? AND user_id = ?", (rid, user["id"]))
        refresh(conn, user["id"])
    return {"deleted": 1}


@router.get("/usage")
def usage(days: int = Query(90, ge=7, le=730), user=Depends(current_user)):
    """Daily / weekly / monthly kWh and cost from every source combined (imported data first, then manual readings)."""
    from . import electricity
    with db.connect() as conn:
        s, ds = electricity.daily_series(conn, user["id"])
        tariff = user_settings.get(conn, user["id"])["electricity"]["tariff"]
        manual_n = conn.execute("SELECT COUNT(*) FROM electricity_readings WHERE user_id = ?", (user["id"],)).fetchone()[0]
    if s.empty:
        return {"has_data": False, "manual_readings": manual_n}
    src = s.attrs["sources"]
    tail = s[s.index > s.index.max() - pd.Timedelta(days=days)]
    weekly = tail.resample("W-SUN").sum(min_count=1).dropna().iloc[-12:]
    monthly = s.resample("MS").sum(min_count=1).dropna().iloc[-12:]
    month = s[s.index.to_period("M") == s.index.max().to_period("M")]
    dim = s.index.max().days_in_month
    total = float(tail.sum())
    return {
        "has_data": True, "manual_readings": manual_n, "dataset": ds["name"] if ds else None,
        "daily": {"t": [t.strftime("%Y-%m-%d") for t in tail.index], "kwh": [round(float(v), 2) for v in tail],
                  "source": [src[t.strftime("%Y-%m-%d")] for t in tail.index]},
        "weekly": [{"week_end": t.strftime("%Y-%m-%d"), "kwh": round(float(v), 2)} for t, v in weekly.items()],
        "monthly": [{"month": t.strftime("%Y-%m"), "kwh": round(float(v), 1), "cost_inr": round(advisor.bill(float(v), tariff), 0)}
                    for t, v in monthly.items()],
        "window": {"days": int(len(tail)), "total_kwh": round(total, 1), "avg_daily_kwh": round(total / len(tail), 2),
                   "manual_days": sum(src[t.strftime("%Y-%m-%d")] == "manual" for t in tail.index)},
        "month": {"month": s.index.max().strftime("%Y-%m"), "days": int(len(month)), "kwh": round(float(month.sum()), 1),
                  "cost_inr": round(advisor.bill(float(month.sum()), tariff), 0),
                  "projected_cost_inr": round(advisor.bill(float(month.mean()) * dim, tariff), 0)},
        "latest_day": s.index.max().strftime("%Y-%m-%d"),
    }
