"""Per-user read/unread state of anomalies, separately for electricity and water.

Anomaly rows are re-created whenever detection re-runs (new data, new thresholds), so their read state lives in its
own table keyed by the anomaly's stable `event_key`: reading an anomaly once keeps it read across re-detection,
refreshes and sign-ins, and an anomaly that appears for the first time is unread. Nothing here deletes anomalies.
State only changes through the explicit endpoints below, which the UI calls when the user actually sees an anomaly
(row on screen, card or detail opened) or chooses "Mark all as read" - never as a side effect of loading data.
"""
from typing import Literal

from fastapi import APIRouter, Body, Depends

from . import db
from .auth import current_user

router = APIRouter(prefix="/api/anomalies", tags=["anomalies"])
UTILITIES = ("electricity", "water")


def remember(conn, user_id, utility, keys):
    """Record first detection for new keys (existing keys keep their first-detected time and read state)."""
    t = db.now()
    conn.executemany("INSERT OR IGNORE INTO anomaly_state (user_id, utility, event_key, first_detected_at) VALUES (?, ?, ?, ?)",
                     [(user_id, utility, k, t) for k in keys])


def _scope(conn, user_id, utility):
    """SQL filter + args selecting the anomalies the user currently sees for a utility."""
    if utility == "water":
        return "a.user_id = ? AND a.utility = 'water'", [user_id]
    ds = conn.execute("SELECT id FROM datasets WHERE user_id = ? AND is_active = 1", (user_id,)).fetchone()
    return ("a.user_id = ? AND a.utility = 'electricity' AND (a.dataset_id = 'manual' OR a.dataset_id = ?)",
            [user_id, ds["id"] if ds else ""])


def current_keys(conn, user_id, utility):
    where, args = _scope(conn, user_id, utility)
    return [r[0] for r in conn.execute(f"SELECT a.event_key FROM anomalies a WHERE {where}", args)]


def states(conn, user_id, utility):
    """{event_key: {"read": bool, "read_at", "detected_at"}} for the user's current anomalies."""
    where, args = _scope(conn, user_id, utility)
    rows = conn.execute(f"SELECT a.event_key, a.detected_at, s.first_detected_at, s.read_at FROM anomalies a "
                        f"LEFT JOIN anomaly_state s ON s.user_id = a.user_id AND s.utility = a.utility AND s.event_key = a.event_key "
                        f"WHERE {where}", args)
    return {r["event_key"]: {"read": r["read_at"] is not None, "read_at": r["read_at"],
                             "detected_at": r["first_detected_at"] or r["detected_at"]} for r in rows}


def counts(conn, user_id, utility):
    where, args = _scope(conn, user_id, utility)
    total, unread = conn.execute(
        f"SELECT COUNT(*), SUM(CASE WHEN s.read_at IS NULL THEN 1 ELSE 0 END) FROM anomalies a "
        f"LEFT JOIN anomaly_state s ON s.user_id = a.user_id AND s.utility = a.utility AND s.event_key = a.event_key WHERE {where}",
        args).fetchone()
    unread = unread or 0
    return {"total": total, "unread": unread, "read": total - unread}


def all_counts(conn, user_id):
    return {u: counts(conn, user_id, u) for u in UTILITIES}


@router.get("/counts")
def get_counts(user=Depends(current_user)):
    with db.connect() as conn:
        return all_counts(conn, user["id"])


@router.post("/{utility}/read")
def mark(utility: Literal["electricity", "water"], keys: list[str] = Body(..., embed=True, max_length=500),
         read: bool = Body(True, embed=True), user=Depends(current_user)):
    """Mark the given anomalies read (or unread again). Keys the user doesn't currently have are ignored."""
    with db.connect() as conn, db.transaction(conn):
        own = set(current_keys(conn, user["id"], utility)) & set(keys)
        remember(conn, user["id"], utility, own)
        if own:
            marks = ",".join("?" * len(own))
            conn.execute(f"UPDATE anomaly_state SET read_at = {'?' if read else 'NULL'} WHERE user_id = ? AND utility = ? AND event_key IN ({marks})",
                         ([db.now()] if read else []) + [user["id"], utility, *own])
        out = all_counts(conn, user["id"])
    return {"updated": len(own), "counts": out}


@router.post("/{utility}/read-all")
def mark_all(utility: Literal["electricity", "water"], user=Depends(current_user)):
    with db.connect() as conn, db.transaction(conn):
        keys = current_keys(conn, user["id"], utility)
        n = 0
        if keys:
            remember(conn, user["id"], utility, keys)
            marks = ",".join("?" * len(keys))
            n = conn.execute(f"UPDATE anomaly_state SET read_at = ? WHERE user_id = ? AND utility = ? AND read_at IS NULL AND event_key IN ({marks})",
                             [db.now(), user["id"], utility, *keys]).rowcount
        out = all_counts(conn, user["id"])
    return {"updated": n, "counts": out}


def with_state(events, st):
    """Copy events adding read / detected_at from the state map (unknown keys count as unread)."""
    return [{**e, "read": st.get(e["key"], {}).get("read", False), "detected_at": st.get(e["key"], {}).get("detected_at")} for e in events]


SEV = ["critical", "high", "medium", "low"]


@router.get("/electricity")
def electricity_anomalies(user=Depends(current_user)):
    """Every electricity anomaly the user has - the active dataset's and those found in manual readings - with read state."""
    from . import electricity, electricity_manual
    with db.connect() as conn:
        res = electricity.analysis(conn, user["id"])  # also keeps the stored rows in step with the current thresholds
        events = []
        if res:
            ds_id = res["dataset"]["id"]
            events = [{**e, "key": f"{ds_id}:{e['type']}:{e['start']}", "data_source": "dataset",
                       "deviation_pct": round((e["ratio"] - 1) * 100) if e.get("ratio") else None} for e in res["events"]]
        events += electricity_manual.stored_events(conn, user["id"])
        events.sort(key=lambda e: (SEV.index(e["severity"]), -(e.get("excess_kwh") or 0)))
        out = with_state(events, states(conn, user["id"], "electricity"))
        if res:
            rate = res["cost"]["marginal_rate"]
        else:  # manual readings only: price at the slab a typical month of this home falls in
            from . import user_settings
            from .engine import advisor
            s, _ = electricity.daily_series(conn, user["id"])
            rate = advisor.marginal_rate(float(s.iloc[-90:].mean()) * 30 if not s.empty else 0.0,
                                         user_settings.get(conn, user["id"])["electricity"]["tariff"])
        kwh, _ = electricity_manual.manual_daily(conn, user["id"])
        covered = electricity_manual.imported_days(conn, user["id"])
        manual_days = sum(d not in covered for d in kwh)
        c = counts(conn, user["id"], "electricity")
    return {"events": out, "counts": c, "has_dataset": bool(res), "marginal_rate": rate,
            "manual": {"days": manual_days, "min_days": electricity_manual.MIN_HISTORY_DAYS,
                       "ready": manual_days > electricity_manual.MIN_HISTORY_DAYS}}
