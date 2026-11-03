"""Notifications: creation with de-duplication, threshold/anomaly evaluation, and the in-app notification centre API.

De-duplication: every notification has a dedupe_key (e.g. 'water-limit-reached:2026-11-02'); UNIQUE(user_id,
dedupe_key) makes re-evaluation idempotent, so reloading data or restarting never repeats an alert.
"""
from datetime import timedelta

import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException, Query

from . import db, limits, user_settings
from .auth import current_user

router = APIRouter(prefix="/api/notifications", tags=["notifications"])
MAX_ANOMALY_ALERTS_PER_RUN = 10
RECENT_DAYS = 7  # anomalies older than this (relative to the latest data) don't trigger alerts
UNITS = {"electricity": "kWh", "water": "L"}
# shown in the app: in-app notifications, minus the ones the removed WhatsApp feature created (kept, never displayed)
VISIBLE = ("json_extract(data, '$.in_app') IS NOT 0 AND kind != 'whatsapp_test' "
           "AND dedupe_key NOT LIKE 'whatsapp-test:%' AND dedupe_key NOT LIKE 'report-send:%'")


def create(conn, user, kind, title, body, dedupe_key, severity="info", data=None, settings=None):
    """Insert a notification unless one with the same key exists. Returns the new id or None (duplicate/disabled)."""
    settings = settings or user_settings.get(conn, user["id"])
    category = user_settings.NOTIFICATION_KINDS[kind][0]
    prefs = settings["notifications"].get(kind, {"in_app": True})
    if not prefs.get("in_app"):
        return None
    cur = conn.execute("INSERT OR IGNORE INTO notifications (user_id, category, kind, severity, title, body, dedupe_key, data, created_at) "
                       "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                       (user["id"], category, kind, severity, title, body, dedupe_key,
                        db.dumps({**(data or {}), "in_app": bool(prefs.get("in_app"))}), db.now()))
    if not cur.rowcount:
        return None
    return cur.lastrowid


def _fmt(v, util):
    return f"{v:,.1f} kWh" if util == "electricity" else f"{v:,.0f} L"


def _series(conn, user_id, util):
    if util == "electricity":
        from . import electricity
        s, ds = electricity.daily_series(conn, user_id)
        return s, (ds["id"] if ds else None)
    from . import water_api
    d, _ = water_api.series(conn, user_id)
    return d, None


def limit_check(conn, user, util, settings, lims):
    s, _ = _series(conn, user["id"], util)
    if s.empty or not settings[util]["notify_limits"]:
        return []
    day = s.index.max()
    used = float(s.iloc[-1])
    st = limits.status(used, limits.limit_for(lims[util], day), settings[util]["warn_pct"])
    if st["state"] in ("ok", "no_limit"):
        return []
    d = day.strftime("%Y-%m-%d")
    label = "Electricity" if util == "electricity" else "Water"
    prefix = "elec" if util == "electricity" else "water"
    when = f"on {day:%a %d %b %Y}"
    if st["state"] in ("reached", "exceeded"):
        over = f" ({_fmt(st['excess'], util)} over)" if st["state"] == "exceeded" else ""
        nid = create(conn, user, f"{prefix}_limit_reached", f"{label} daily limit reached",
                     f"{label} use {when} reached {_fmt(used, util)}, {st['pct']:.0f}% of your {_fmt(st['limit'], util)} daily limit{over}.",
                     f"{util}-limit-reached:{d}", "high", {"day": d, **st}, settings=settings)
    else:
        nid = create(conn, user, f"{prefix}_limit_warning", f"{label} use at {st['pct']:.0f}% of your daily limit",
                     f"{label} use {when} is {_fmt(used, util)} of your {_fmt(st['limit'], util)} limit - "
                     f"{_fmt(st['remaining'], util)} left.", f"{util}-limit-warning:{d}", "medium", {"day": d, **st}, settings=settings)
    return [nid] if nid else []


def anomaly_check(conn, user, util, settings):
    s, ds_id = _series(conn, user["id"], util)
    if s.empty:
        return []
    since = (s.index.max() - timedelta(days=RECENT_DAYS)).strftime("%Y-%m-%d")
    min_rank = user_settings.SEVERITY_ORDER.index(settings["anomaly_min_severity"])
    q = "SELECT * FROM anomalies WHERE user_id = ? AND utility = ? AND start_ts >= ?"
    args = [user["id"], util, since]
    if util == "electricity":  # the active dataset's anomalies and those found in manual readings
        q += " AND (dataset_id = ? OR dataset_id = 'manual')"
        args.append(ds_id or "")
    rows = [r for r in conn.execute(q + " ORDER BY start_ts DESC", args)
            if user_settings.SEVERITY_ORDER.index(r["severity"]) >= min_rank][:MAX_ANOMALY_ALERTS_PER_RUN]
    out = []
    for r in rows:
        data = db.loads(r["data"], {})
        start = pd.Timestamp(r["start_ts"])
        if util == "electricity":
            body = f"{r['title']} starting {start:%a %d %b %Y %H:%M} - about {data.get('excess_kwh', 0):.1f} kWh above this home's normal use."
            kind = "elec_anomaly"
        else:
            dev = data.get("deviation_pct")
            body = (f"{r['title']} on {start:%a %d %b %Y}: {data.get('actual_litres', 0):,.0f} L vs about {data.get('expected_litres', 0):,.0f} L expected"
                    + (f" ({dev:+.0f}%)." if dev is not None else ".") + " Open PowerPulse for suggested checks.")
            kind = "water_anomaly"
        nid = create(conn, user, kind, f"Unusual {util} consumption: {r['title'].lower()}", body,
                     f"{util}-anomaly:{r['type']}:{r['start_ts']}", r["severity"],
                     {"anomaly_id": r["id"], "type": r["type"], "start": r["start_ts"]}, settings=settings)
        if nid:
            out.append(nid)
    return out


def evaluate_user(conn, user_id):
    """Check limits and recent anomalies for both utilities. Idempotent."""
    user = db.row(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())
    if not user:
        return []
    settings = user_settings.get(conn, user_id)
    lims = user_settings.limits(conn, user_id)
    created = []
    for util in ("electricity", "water"):
        created += limit_check(conn, user, util, settings, lims)
        created += anomaly_check(conn, user, util, settings)
    return created


# ---------------- API ----------------
def _out(r):
    data = db.loads(r["data"], {})
    return {"id": r["id"], "category": r["category"], "kind": r["kind"], "severity": r["severity"], "title": r["title"],
            "body": r["body"], "created_at": r["created_at"], "read": bool(r["read_at"]), "read_at": r["read_at"],
            "data": data}


@router.get("")
def list_notifications(category: str = Query("all"), status: str = Query("all"), limit: int = Query(50, ge=1, le=200),
                       offset: int = Query(0, ge=0), user=Depends(current_user)):
    where, args = ["user_id = ?", VISIBLE], [user["id"]]
    if category != "all":
        if category not in ("electricity", "water", "report", "account"):
            raise HTTPException(422, "Unknown category.")
        where.append("category = ?")
        args.append(category)
    if status == "unread":
        where.append("read_at IS NULL")
    elif status == "read":
        where.append("read_at IS NOT NULL")
    w = " AND ".join(where)
    with db.connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM notifications WHERE {w}", args).fetchone()[0]
        unread = conn.execute(f"SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL AND {VISIBLE}",
                              (user["id"],)).fetchone()[0]
        rows = conn.execute(f"SELECT * FROM notifications WHERE {w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
    return {"total": total, "unread": unread, "items": [_out(r) for r in rows]}


@router.post("/read")
def mark_read(ids: list[int] = Body(default=[], embed=True), all: bool = Body(default=False, embed=True), user=Depends(current_user)):
    with db.connect() as conn:
        if all:
            n = conn.execute("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", (db.now(), user["id"])).rowcount
        else:
            ids = [int(i) for i in ids][:500]
            if not ids:
                return {"updated": 0}
            n = conn.execute(f"UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN ({','.join('?' * len(ids))})",
                             [db.now(), user["id"], *ids]).rowcount
    return {"updated": n}


@router.post("/unread")
def mark_unread(ids: list[int] = Body(..., embed=True), user=Depends(current_user)):
    ids = [int(i) for i in ids][:500]
    with db.connect() as conn:
        n = conn.execute(f"UPDATE notifications SET read_at = NULL WHERE user_id = ? AND id IN ({','.join('?' * len(ids))})",
                         [user["id"], *ids]).rowcount if ids else 0
    return {"updated": n}


@router.post("/evaluate")
def evaluate(user=Depends(current_user)):
    """Re-run threshold and anomaly checks now (they also run automatically after every data change)."""
    with db.connect() as conn:
        return {"created": len(evaluate_user(conn, user["id"]))}
