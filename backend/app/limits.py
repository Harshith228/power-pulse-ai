"""Daily consumption limits: which limit applies on a day, the status of a day against it, and violations."""
import pandas as pd

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def limit_for(lims, day) -> float | None:
    """lims = {"default": x|None, "weekdays": {0..6: y}} -> the limit for that calendar day."""
    wd = pd.Timestamp(day).weekday()
    return lims["weekdays"].get(wd, lims["weekdays"].get(str(wd), lims["default"]))


def status(used, limit, warn_pct):
    if limit is None or used is None:
        return {"used": used, "limit": limit, "state": "no_limit"}
    pct = used / limit * 100 if limit else 0
    state = "exceeded" if used > limit * 1.0005 else "reached" if pct >= 99.95 else "warning" if pct >= warn_pct else "ok"
    return {"used": round(used, 3), "limit": limit, "pct": round(pct, 1), "remaining": round(max(limit - used, 0), 3),
            "excess": round(max(used - limit, 0), 3), "warn_pct": warn_pct, "state": state}


def violations(series: pd.Series, lims) -> list[dict]:
    """Days whose total was above the limit that applied that day."""
    out = []
    for day, used in series.dropna().items():
        lim = limit_for(lims, day)
        if lim is not None and used > lim:
            out.append({"day": day.strftime("%Y-%m-%d"), "used": round(float(used), 3), "limit": lim, "excess": round(float(used - lim), 3)})
    return out


def limit_series(index, lims):
    """Limit value for each day in a DatetimeIndex (None where no limit applies), for charts."""
    return [limit_for(lims, d) for d in index]
