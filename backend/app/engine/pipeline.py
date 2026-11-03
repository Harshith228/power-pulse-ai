"""Glue: hourly frame -> detection -> cost + recommendations -> JSON-ready dict for the UI."""
import numpy as np
import pandas as pd

from . import advisor, detector


def _num(a, nd=3):
    a = np.asarray(a, dtype=float)
    return [None if np.isnan(v) else round(float(v), nd) for v in a]


def _ms(idx):
    # naive local timestamps -> epoch ms; the UI renders them as UTC so wall-clock hours are preserved
    return (idx.as_unit("ms").asi8).tolist()


def run_detection(df, cfg=None):
    det = detector.detect(df, cfg)
    det["validation"] = detector.evaluate(det)
    return det


def build_result(meta, det, tariff):
    f, daily, events = det["frame"], det["daily"], det["events"]
    cfg = det.get("config") or detector.DEFAULT_CONFIG
    days = max((f.index.max() - f.index.min()) / pd.Timedelta(days=1), 1)
    recs = advisor.recommend(events, f, tariff, days)
    cost = advisor.cost_summary(f, events, tariff, days)
    s = f["kwh"]
    peak_t = s.idxmax()
    sev = {k: sum(e["severity"] == k for e in events) for k in detector.SEVERITIES}
    by_type = {k: sum(e["type"] == k for e in events) for k in ("spike", "sustained", "repeated", "night")}
    potential = sum(r["inr_month"] for r in recs)

    kpis = {
        "total_kwh": round(float(s.sum()), 1),
        "avg_daily_kwh": round(float(s.sum() / days), 2),
        "peak_kwh": round(float(s.max()), 2), "peak_time": peak_t.isoformat(),
        "baseload_w": round(float(s.quantile(0.05)) * 1000),
        "anomalies": len(events), "by_severity": sev, "by_type": by_type,
        "anomaly_share": round(cost["anomaly_kwh_total"] / max(float(s.sum()), 1e-9), 4),
        "typical_month_bill": cost["typical_month_bill"],
        "potential_savings_month": round(potential, 0),
        "potential_savings_year": round(potential * 12, 0),
    }
    wk = f.index.day_of_week >= 5
    profile = {
        "weekday": _num(s[~wk].groupby(f.index.hour[~wk]).mean().reindex(range(24))),
        "weekend": _num(s[wk].groupby(f.index.hour[wk]).mean().reindex(range(24))),
        "heatmap": [[d, h, round(float(v), 3)] for (d, h), v in
                    s.groupby([f.index.day_of_week, f.index.hour]).mean().items()],
    }
    hourly = {
        "t": _ms(f.index), "kwh": _num(s), "expected": _num(f["expected"]), "threshold": _num(f["threshold"]),
        "score": _num(f["if_pct"], 4), "flag": f["flag"].astype(int).tolist(),
    }
    if "injected" in f.columns:
        hourly["injected"] = f["injected"].astype(int).tolist()
    daily_out = {
        "t": _ms(daily.index), "kwh": _num(daily["kwh"], 2), "expected": _num(daily["expected"], 2),
        "flag": daily["flag"].fillna(False).astype(int).tolist(),
    }
    clean_events = [{k: v for k, v in e.items() if not k.startswith("_")} for e in events]
    return {
        "dataset": meta, "kpis": kpis, "events": clean_events, "recommendations": recs, "cost": cost,
        "tariff": tariff, "profile": profile, "hourly": hourly, "daily": daily_out,
        "validation": det["validation"],
        "model": {
            "baseline": f"Median of the same clock-hour over the previous {detector.WINDOW_DAYS} days "
                        "(weekdays and weekends separately), spread = rolling MAD",
            "spike_rule": f"robust z >= {cfg['spike_z']:g} AND Isolation Forest rarity >= "
                          f"{cfg['if_rarity']:.0%} AND excess >= {cfg['min_excess_kwh']:g} kWh",
            "sustained_rule": f"daily total >= {cfg['sustain_ratio']:.0%} of lagged 4-week median for "
                              f">= {cfg['sustain_min_days']} consecutive days",
            "night_rule": (f"{cfg['night_start']:02d}:00-{cfg['night_end']:02d}:00 total >= {cfg['night_ratio']:.0%} of the "
                           f"previous {detector.NIGHT_HISTORY} nights' median and >= {cfg['night_min_excess_kwh']:g} kWh extra"
                           if cfg["night_enabled"] else "off"),
            "config": cfg,
            "repeated_rule": f"spikes at the same clock-hour on >= {detector.REPEAT_MIN} days, "
                             f"<= {detector.REPEAT_GAP_DAYS} days apart",
            "isolation_forest": "200 trees, 8 features (level, robust z, ratio to baseline, hourly jump, "
                                "24h mean, hour sin/cos, weekend)",
            "warmup_days": detector.WARMUP_DAYS,
        },
    }
