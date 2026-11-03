"""Settings, daily limits and recommendation checklists."""
import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException, Query

from . import db, limits, notify, user_settings
from .auth import current_user
from .engine import advisor, detector
from .engine import water as water_engine

router = APIRouter(prefix="/api", tags=["settings"])


def _payload(conn, user_id):
    s = user_settings.get(conn, user_id)
    s.pop("checklists", None)
    return {
        "settings": s,
        "limits": user_settings.limits(conn, user_id),
        "defaults": {"electricity_tariff": advisor.DEFAULT_TARIFF, "water_tariff": user_settings.DEFAULT_WATER_TARIFF,
                     "detection": detector.DEFAULT_CONFIG, "detection_bounds": detector.CONFIG_BOUNDS},
        "notification_kinds": {k: {"category": c, "label": label} for k, (c, label) in user_settings.NOTIFICATION_KINDS.items()},
    }


@router.get("/settings")
def get_settings(user=Depends(current_user)):
    with db.connect() as conn:
        return _payload(conn, user["id"])


@router.patch("/settings")
def patch_settings(patch: dict = Body(...), user=Depends(current_user)):
    with db.connect() as conn:
        current = user_settings.get(conn, user["id"])
        try:
            new = user_settings.apply_patch(current, patch)
        except (ValueError, TypeError) as e:
            raise HTTPException(422, str(e)) from e
        user_settings.save(conn, user["id"], new)
        if any(k in patch for k in ("electricity", "water", "anomaly_min_severity", "detection", "reset_detection")):
            if "detection" in patch or "reset_detection" in patch:
                from . import electricity
                electricity.analysis(conn, user["id"])  # recompute under the new thresholds and re-store anomalies
            notify.evaluate_user(conn, user["id"])
        return _payload(conn, user["id"])


@router.put("/limits/{utility}")
def put_limits(utility: str, body: dict = Body(...), user=Depends(current_user)):
    """body: {"default": number|null, "weekdays": {"0": number|null, ...}} - kWh for electricity, litres for water."""
    with db.connect() as conn:
        try:
            user_settings.set_limits(conn, user["id"], utility, body.get("default"), body.get("weekdays") or {})
        except (ValueError, TypeError) as e:
            raise HTTPException(422, str(e)) from e
        notify.evaluate_user(conn, user["id"])
        return _payload(conn, user["id"])


@router.put("/checklists")
def put_checklist(dataset_id: str = Body(...), key: str = Body(...), done: list[int] = Body(...), user=Depends(current_user)):
    """dataset_id is an electricity dataset id, or "water" for the water recommendations."""
    lists = water_engine.WATER_RECS if dataset_id == "water" else advisor.CHECKLISTS
    if key not in lists:
        raise HTTPException(422, "Unknown recommendation.")
    steps = len(lists[key][3] if dataset_id == "water" else lists[key])
    clean = sorted({int(i) for i in done if 0 <= int(i) < steps})
    with db.connect() as conn:
        if dataset_id != "water" and not conn.execute("SELECT 1 FROM datasets WHERE id = ? AND user_id = ?", (dataset_id, user["id"])).fetchone():
            raise HTTPException(404, "Dataset not found.")
        s = user_settings.get(conn, user["id"])
        s["checklists"].setdefault(dataset_id, {})[key] = clean
        s["checklists"] = {k: v for k, v in s["checklists"].items() if k == "water" or
                           conn.execute("SELECT 1 FROM datasets WHERE id = ? AND user_id = ?", (k, user["id"])).fetchone()}
        user_settings.save(conn, user["id"], s)
    return {"key": key, "done": clean, "steps": steps}


@router.get("/limits/{utility}/history")
def limit_history(utility: str, days: int = Query(90, ge=7, le=730), user=Depends(current_user)):
    """Daily use against the limit that applied each day (kWh or litres), with violation statistics."""
    if utility not in ("electricity", "water"):
        raise HTTPException(404, "Unknown utility.")
    from . import electricity, water_api
    with db.connect() as conn:
        s = user_settings.get(conn, user["id"])
        lims = user_settings.limits(conn, user["id"])[utility]
        series = electricity.daily_series(conn, user["id"])[0] if utility == "electricity" else water_api.series(conn, user["id"])[0]
    if series.empty:
        return {"has_data": False, "limits": lims, "warn_pct": s[utility]["warn_pct"], "notify": s[utility]["notify_limits"]}
    tail = series[series.index > series.index.max() - pd.Timedelta(days=days)]
    lim = limits.limit_series(tail.index, lims)
    pct = [round(v / cap * 100, 1) if cap else None for v, cap in zip(tail, lim, strict=True)]
    viol = limits.violations(tail, lims)
    with_limit = [p for p in pct if p is not None]
    streak = 0
    for p_ in reversed(pct):
        if p_ is None or p_ > 100:
            break
        streak += 1
    month = tail[tail.index.to_period("M") == tail.index.max().to_period("M")]
    latest = tail.index.max()
    return {
        "has_data": True, "unit": user_settings.UNITS[utility], "limits": lims, "warn_pct": s[utility]["warn_pct"], "notify": s[utility]["notify_limits"],
        "latest_day": latest.strftime("%Y-%m-%d"),
        "latest": limits.status(float(tail.iloc[-1]), limits.limit_for(lims, latest), s[utility]["warn_pct"]),
        "daily": {"t": [d.strftime("%Y-%m-%d") for d in tail.index], "v": [round(float(v), 2) for v in tail], "limit": lim, "pct": pct},
        "violations": list(reversed(viol)),
        "stats": {"days": int(len(tail)), "days_with_limit": len(with_limit), "days_over": len(viol),
                  "days_warning": sum(1 for p_ in with_limit if s[utility]["warn_pct"] <= p_ <= 100),
                  "avg_pct": round(sum(with_limit) / len(with_limit), 1) if with_limit else None,
                  "worst": max(viol, key=lambda v: v["excess"]) if viol else None,
                  "streak_within": streak, "month_over": len(limits.violations(month, lims)),
                  "total_excess": round(sum(v["excess"] for v in viol), 2)},
    }
