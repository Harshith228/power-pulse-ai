"""Unified household dashboard: electricity + water side by side, comparisons and recent notifications."""
import pandas as pd
from fastapi import APIRouter, Depends

from . import db, limits, notify, user_settings
from .auth import current_user
from .engine import advisor

router = APIRouter(prefix="/api/household", tags=["household"])


def _change(a, b):
    return None if not b else round((a / b - 1) * 100, 1)


def _utility(s: pd.Series, lims, warn, tariff, unit_div, anomalies, hours=None):
    """Common shape for one utility. unit_div converts the series unit to the tariff unit (1 for kWh, 1000 for L->kL)."""
    if s.empty:
        return {"has_data": False}
    latest = s.index.max()
    month = s[s.index.to_period("M") == latest.to_period("M")]
    prev_p = latest.to_period("M") - 1
    prev = s[s.index.to_period("M") == prev_p]
    last30 = s[s.index > latest - pd.Timedelta(days=30)]
    prev30 = s[(s.index <= latest - pd.Timedelta(days=30)) & (s.index > latest - pd.Timedelta(days=60))]
    complete = s.iloc[:-1] if len(s) > 1 else s
    proj = float(month.mean()) * latest.days_in_month
    tail = s[s.index > latest - pd.Timedelta(days=30)]
    since = (latest - pd.Timedelta(days=30)).strftime("%Y-%m-%d")
    recent = [a for a in anomalies if a["start_ts"] >= since]
    return {
        "has_data": True, "latest_day": latest.strftime("%Y-%m-%d"), "latest_value": round(float(s.iloc[-1]), 2),
        "latest_hours": (hours or {}).get(latest.strftime("%Y-%m-%d")),
        "limit_status": limits.status(float(s.iloc[-1]), limits.limit_for(lims, latest), warn),
        "month": latest.strftime("%Y-%m"), "month_total": round(float(month.sum()), 2), "month_days": int(len(month)),
        "month_cost": round(advisor.bill(float(month.sum()) / unit_div, tariff), 0),
        "month_cost_projected": round(advisor.bill(proj / unit_div, tariff), 0),
        "avg_30d": round(float(last30.mean()), 2),
        "comparisons": {
            "latest_vs_30d_avg_pct": _change(float(s.iloc[-1]), float(complete.tail(30).mean()) if len(complete) else 0),
            "month_vs_prev_month_avg_pct": _change(float(month.mean()), float(prev.mean())) if len(prev) else None,
            "last30_vs_prev30_pct": _change(float(last30.mean()), float(prev30.mean())) if len(prev30) >= 7 else None,
            "prev_month": str(prev_p) if len(prev) else None, "prev_month_avg": round(float(prev.mean()), 2) if len(prev) else None,
        },
        "violations_30d": len(limits.violations(last30, lims)),
        "anomalies_total": len(anomalies), "anomalies_30d": len(recent),
        "recent_anomalies": [{"id": a["id"], "title": a["title"], "severity": a["severity"], "start": a["start_ts"], "type": a["type"]}
                             for a in sorted(anomalies, key=lambda a: a["start_ts"], reverse=True)[:4]],
        "daily": {"t": [d.strftime("%Y-%m-%d") for d in tail.index], "v": [round(float(v), 2) for v in tail],
                  "limit": limits.limit_series(tail.index, lims)},
    }


@router.get("/summary")
def summary(user=Depends(current_user)):
    from . import electricity, water_api
    with db.connect() as conn:
        s = user_settings.get(conn, user["id"])
        lims = user_settings.limits(conn, user["id"])
        es, ds = electricity.daily_series(conn, user["id"])
        wd, _ = water_api.series(conn, user["id"])
        ea = [dict(r) for r in conn.execute("SELECT id, title, severity, start_ts, type FROM anomalies WHERE user_id = ? AND utility = 'electricity' "
                                            "AND (dataset_id = ? OR dataset_id = 'manual')", (user["id"], ds["id"] if ds else ""))]
        wa = [dict(r) for r in conn.execute("SELECT id, title, severity, start_ts, type FROM anomalies WHERE user_id = ? AND utility = 'water'",
                                            (user["id"],))]
        notes = [dict(r) for r in conn.execute(
            "SELECT id, category, kind, severity, title, body, created_at, read_at FROM notifications WHERE user_id = ? "
            f"AND {notify.VISIBLE} ORDER BY created_at DESC, id DESC LIMIT 6", (user["id"],))]
        unread = conn.execute(f"SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL AND {notify.VISIBLE}",
                              (user["id"],)).fetchone()[0]
    elec = _utility(es, lims["electricity"], s["electricity"]["warn_pct"], s["electricity"]["tariff"], 1, ea, es.attrs.get("hours"))
    if ds:
        elec["dataset"] = {"id": ds["id"], "name": ds["name"], "source": ds["source"]}
    water = _utility(wd, lims["water"], s["water"]["warn_pct"], s["water"]["tariff"], 1000, wa)
    both = [u for u in (elec, water) if u.get("has_data")]
    return {
        "electricity": elec, "water": water, "limits": lims,
        "units": {"electricity": "kWh", "water": "L", "water_pref": s["water"]["unit"]},
        "household": {"monthly_cost_projected": round(sum(u["month_cost_projected"] for u in both), 0),
                      "anomalies_30d": sum(u["anomalies_30d"] for u in both),
                      "limits_set": {k: v["default"] is not None or bool(v["weekdays"]) for k, v in lims.items()}},
        "notifications": {"unread": unread, "recent": notes},
    }
