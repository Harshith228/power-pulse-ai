"""Anomaly detection on an hourly kWh series.

Three layers, each explainable on its own:
1. Robust baseline  - expected kWh for every hour = median of the same clock-hour over the
   previous 28 days; spread = rolling MAD of the prediction error. Gives a robust z-score.
2. Isolation Forest - multivariate outlier score over time-series features (level, deviation,
   hour-to-hour jump, daily context, time of day). Confirms moderate deviations and ranks rarity.
3. Event rules      - spikes (short, sharp), sustained (>=3 days of elevated daily totals vs a
   lagged baseline), repeated (same clock-hour spike on >=3 days within a week of each other) and
   night-time increases (a night's total well above the previous two weeks of nights).

Thresholds are tunable per user (see DEFAULT_CONFIG / validate_config); the defaults are the values the
validation suite was tuned on.
"""
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

WINDOW_DAYS = 28
WARMUP_DAYS = 7
SPIKE_Z = 4.0          # robust z alone that makes an hour anomalous
IF_RARITY = 0.98       # Isolation Forest must also rank the hour in its rarest 2%
MIN_EXCESS_KWH = 0.25
SUSTAIN_RATIO = 1.2
SUSTAIN_Z = 1.0        # per-day; noisy homes have wide daily spread, so the run average does the work
SUSTAIN_RUN_RATIO = 1.3  # the whole run must average >= +30%
SUSTAIN_MIN_DAYS = 3
SUSTAIN_LAG_DAYS = 7   # daily baseline ignores the last week so a slow drift can't hide itself
REPEAT_MIN = 3
REPEAT_GAP_DAYS = 7
NIGHT_HISTORY = 14     # nights in the night-time baseline
SEVERITIES = ["low", "medium", "high", "critical"]

DEFAULT_CONFIG = {
    "spike_z": SPIKE_Z, "if_rarity": IF_RARITY, "min_excess_kwh": MIN_EXCESS_KWH,
    "sustain_ratio": SUSTAIN_RATIO, "sustain_min_days": SUSTAIN_MIN_DAYS,
    "night_enabled": True, "night_start": 22, "night_end": 6, "night_ratio": 2.0, "night_min_excess_kwh": 2.0,
}
# (min, max) for numeric settings; hours are 0-23
CONFIG_BOUNDS = {
    "spike_z": (2.5, 8.0), "if_rarity": (0.90, 0.999), "min_excess_kwh": (0.05, 5.0),
    "sustain_ratio": (1.05, 2.0), "sustain_min_days": (2, 14),
    "night_start": (0, 23), "night_end": (0, 23), "night_ratio": (1.2, 4.0), "night_min_excess_kwh": (0.2, 20.0),
}
INT_KEYS = ("sustain_min_days", "night_start", "night_end")


def validate_config(cfg):
    """Return a complete, clean detection config or raise ValueError with a user-facing message."""
    out = dict(DEFAULT_CONFIG)
    for k, v in (cfg or {}).items():
        if k not in DEFAULT_CONFIG:
            raise ValueError(f"Unknown detection setting: {k}")
        if k == "night_enabled":
            out[k] = bool(v)
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            raise ValueError(f"{k.replace('_', ' ')} must be a number.") from None
        lo, hi = CONFIG_BOUNDS[k]
        if not lo <= v <= hi:
            raise ValueError(f"{k.replace('_', ' ')} must be between {lo:g} and {hi:g}.")
        out[k] = int(v) if k in INT_KEYS else v
    if out["night_start"] == out["night_end"]:
        raise ValueError("The night window must start and end at different hours.")
    return out


def night_hours(cfg):
    a, b = cfg["night_start"], cfg["night_end"]
    return list(range(a, b)) if a < b else list(range(a, 24)) + list(range(0, b))


def trailing_baseline(s: pd.Series, window=WINDOW_DAYS, min_periods=WARMUP_DAYS):
    """(expected, mad) per hour from the same clock-hour on previous days of the same type
    (weekday vs weekend) over roughly the last `window` days. NaN during warm-up."""
    f = pd.DataFrame({"v": s.to_numpy(), "date": s.index.normalize(), "hour": s.index.hour})
    mat = f.pivot_table(index="date", columns="hour", values="v", aggfunc="mean")
    mat = mat.reindex(pd.date_range(mat.index.min(), mat.index.max(), freq="D"))
    weekend = mat.index.day_of_week >= 5
    med = pd.DataFrame(index=mat.index, columns=mat.columns, dtype=float)
    mad = med.copy()
    for mask, share in ((~weekend, 5 / 7), (weekend, 2 / 7)):
        sub = mat[mask]
        w, mp = max(2, round(window * share)), max(2, round(min_periods * share))
        m = sub.rolling(w, min_periods=mp).median().shift(1)
        med[mask] = m
        mad[mask] = (sub - m).abs().rolling(w, min_periods=mp).median().shift(1)

    def back(m):
        st = m.stack()
        st.index = st.index.get_level_values(0) + pd.to_timedelta(st.index.get_level_values(1).astype(int), unit="h")
        return st[~st.index.duplicated()].reindex(s.index).astype(float)

    return back(med), back(mad)


def _bump(sev, cond):
    return SEVERITIES[min(SEVERITIES.index(sev) + 1, 3)] if cond else sev


def _level(x, cuts):
    return SEVERITIES[sum(x >= c for c in cuts)]


def _fmt_t(ts):
    return ts.strftime("%a %d %b %Y, %H:%M")


def _hour_band(hours):
    hours = sorted(hours)
    return f"{hours[0]:02d}:00-{(hours[-1] + 1) % 24:02d}:00"


def _attribute(cx, mask):
    """Share of excess energy per circuit for the masked hours -> the top circuit and its share."""
    if cx is None:
        return None
    sums = cx[0][mask].sum(axis=0)
    total = sums.sum()
    if total <= 0:
        return None
    i = int(sums.argmax())
    return {"label": cx[1][i], "share": round(float(sums[i] / total), 3)}


def detect(df: pd.DataFrame, cfg=None):
    conf = validate_config(cfg)
    # local names shadow the module defaults so the rules below read the user's thresholds
    SPIKE_Z, IF_RARITY, MIN_EXCESS_KWH = conf["spike_z"], conf["if_rarity"], conf["min_excess_kwh"]  # noqa: N806
    SUSTAIN_RATIO, SUSTAIN_MIN_DAYS = conf["sustain_ratio"], conf["sustain_min_days"]  # noqa: N806
    s = df["kwh"]
    f = pd.DataFrame(index=df.index)
    f["kwh"] = s
    f["expected"], mad = trailing_baseline(s)
    f["scale"] = np.maximum.reduce([1.4826 * mad.fillna(0), 0.15 * f["expected"].fillna(0),
                                    np.full(len(f), 0.05)])
    f["z"] = (s - f["expected"]) / f["scale"]
    f["threshold"] = f["expected"] + SPIKE_Z * f["scale"]

    # circuit baselines (for attribution in explanations)
    circuits = [c for c in df.columns if c.startswith("circuit:")]
    cx = None  # (hours x circuits excess-kWh matrix, labels)
    for c in circuits:
        f[c] = df[c]
        f[c + "#exp"] = trailing_baseline(df[c].fillna(0))[0]
    if circuits:
        other = (s - df[circuits].sum(axis=1)).clip(lower=0)
        if other.mean() > 0.05:
            f["other"] = other
            f["other#exp"] = trailing_baseline(other)[0]
        cols = circuits + (["other"] if "other" in f.columns else [])
        matrix = np.column_stack([(f[c] - f[c + "#exp"]).clip(lower=0).fillna(0).to_numpy() for c in cols])
        labels = [c.removeprefix("circuit:") for c in circuits]
        cx = (matrix, labels + ["Unmetered (lighting, other appliances)"] * ("other" in f.columns))

    # Isolation Forest over engineered features
    hour = df.index.hour.to_numpy()
    feats = np.column_stack([
        s, f["z"].fillna(0).clip(-20, 20), (s / f["expected"]).fillna(1).clip(0, 20),
        s.diff().fillna(0), s.rolling(24, min_periods=1).mean(),
        np.sin(2 * np.pi * hour / 24), np.cos(2 * np.pi * hour / 24), (df.index.day_of_week >= 5).astype(float),
    ])
    iforest = IsolationForest(n_estimators=200, contamination=0.01, random_state=42).fit(feats)
    f["if_flag"] = iforest.predict(feats) == -1
    f["if_pct"] = pd.Series(-iforest.score_samples(feats), index=f.index).rank(pct=True)

    excess = s - f["expected"]
    big_enough = f["expected"].notna() & (excess >= np.maximum(MIN_EXCESS_KWH, 0.3 * f["expected"]))
    f["point"] = big_enough & (f["z"] >= SPIKE_Z) & (f["if_pct"] >= IF_RARITY)
    typical = float(s.median()) or 0.1  # spike severity is graded in "typical hours" of extra energy

    # ---- daily layer (sustained) ----
    counts = s.resample("D").count()
    daily = pd.DataFrame({"kwh": s.resample("D").sum()})
    daily.loc[counts < 20, "kwh"] = np.nan
    home = daily["kwh"].where(daily["kwh"] >= 0.4 * daily["kwh"].median())  # drop "away on holiday" days
    daily["expected"] = home.rolling(WINDOW_DAYS, min_periods=10).median().shift(SUSTAIN_LAG_DAYS)
    dmad = (daily["kwh"] - daily["expected"]).abs().rolling(WINDOW_DAYS, min_periods=10).median().shift(1)
    daily["scale"] = np.maximum(1.4826 * dmad.fillna(0), 0.08 * daily["expected"])
    daily["z"] = (daily["kwh"] - daily["expected"]) / daily["scale"]
    daily["flag"] = (daily["kwh"] / daily["expected"] >= SUSTAIN_RATIO) & (daily["z"] >= SUSTAIN_Z)

    events = []
    sustained_days = set()
    obs = daily["flag"][daily["kwh"].notna()]  # days without data don't break a run
    runs = (obs != obs.shift()).cumsum()
    for _, run in obs[obs].groupby(runs[obs]):
        grp = daily.loc[run.index]
        if len(run) < SUSTAIN_MIN_DAYS or grp["kwh"].sum() < SUSTAIN_RUN_RATIO * grp["expected"].sum():
            continue
        days = list(grp.index)
        sustained_days.update(days + [days[0] - pd.Timedelta(days=1)])  # onset day is often partial
        mask = f.index.normalize().isin(days)
        by_hour = excess[mask].groupby(f.index.hour[mask]).mean()
        hot = list(by_hour[by_hour >= 0.5 * by_hour.max()].index) if by_hour.max() > 0 else []
        actual, base = grp["kwh"].mean(), grp["expected"].mean()
        ratio = actual / base
        ev = {
            "type": "sustained",
            "start": days[0].isoformat(), "end": (days[-1] + pd.Timedelta(hours=23)).isoformat(),
            "duration_hours": len(days) * 24, "days": len(days),
            "peak_time": grp["kwh"].idxmax().isoformat(), "peak_kwh": round(float(grp["kwh"].max()), 2),
            "expected_kwh": round(float(base), 2), "actual_kwh": round(float(actual), 2),
            "excess_kwh": round(float((grp["kwh"] - grp["expected"]).sum()), 2),
            "ratio": round(float(ratio), 2), "z": round(float(grp["z"].max()), 1),
            "if_pct": round(float(f.loc[mask, "if_pct"].mean()), 3),
            "hours_of_day": [int(h) for h in hot],
            "severity": _bump(_level(ratio, [1.3, 1.5, 1.8]), len(days) >= 7),
            "circuit": _attribute(cx, mask),
        }
        ev["title"] = f"Consumption up {ratio - 1:.0%} for {len(days)} days"
        ev["factors"] = [
            f"Daily use averaged {actual:.1f} kWh vs a {base:.1f} kWh baseline (+{ratio - 1:.0%}) "
            f"from {days[0]:%d %b} to {days[-1]:%d %b %Y}.",
            f"Baseline = median daily use over the 4 weeks before ({SUSTAIN_LAG_DAYS}-day lag), so a slow "
            "drift can't absorb itself.",
            f"Peak day {grp['z'].max():.1f} robust standard deviations above normal.",
        ]
        if hot:
            ev["factors"].append(f"Extra load is concentrated in {_hour_band(hot)}.")
        events.append(ev)

    # ---- point layer (spikes, then repeated) ----
    pt = f.index[f["point"]]
    spikes = []
    if len(pt):
        groups = (pd.Series(pt).diff() > pd.Timedelta(hours=1)).cumsum().to_numpy()
        for g in np.unique(groups):
            hours = pt[groups == g]
            seg = f.loc[hours]
            peak = seg["z"].idxmax()
            p = f.loc[peak]
            if peak.normalize() in sustained_days and p["z"] < 2 * SPIKE_Z:
                continue  # part of a sustained rise, explained by that event
            mask = f.index.isin(hours)
            prev = f["kwh"].shift(1).loc[peak]
            spikes.append({
                "type": "spike", "start": hours[0].isoformat(),
                "end": hours[-1].isoformat(), "duration_hours": len(hours),
                "peak_time": peak.isoformat(), "peak_kwh": round(float(p["kwh"]), 2),
                "expected_kwh": round(float(p["expected"]), 2), "actual_kwh": round(float(seg["kwh"].sum()), 2),
                "excess_kwh": round(float((seg["kwh"] - seg["expected"]).clip(lower=0).sum()), 2),
                "ratio": round(float(p["kwh"] / max(p["expected"], 0.01)), 2), "z": round(float(p["z"]), 1),
                "if_pct": round(float(p["if_pct"]), 4), "if_flag": bool(p["if_flag"]),
                "jump_kwh": round(float(p["kwh"] - prev), 2) if pd.notna(prev) else None,
                "hours_of_day": sorted({int(h.hour) for h in hours}),
                "circuit": _attribute(cx, mask), "_ts": peak,
            })

    # repeated: spikes at the same clock-hour on several days close together
    used = set()
    by_hour = {}
    for i, sp in enumerate(spikes):
        by_hour.setdefault(sp["_ts"].hour, []).append(i)
    for hr, idxs in by_hour.items():
        cluster = [idxs[0]]
        for i in idxs[1:] + [None]:
            if i is not None and (spikes[i]["_ts"] - spikes[cluster[-1]]["_ts"]).days <= REPEAT_GAP_DAYS:
                cluster.append(i)
                continue
            if len({spikes[j]["_ts"].date() for j in cluster}) >= REPEAT_MIN:
                used.update(cluster)
                members = [spikes[j] for j in cluster]
                n = len(members)
                tot_excess = sum(m["excess_kwh"] for m in members)
                avg_peak = np.mean([m["peak_kwh"] for m in members])
                avg_exp = np.mean([m["expected_kwh"] for m in members])
                mask = f.index.isin([pd.Timestamp(m["peak_time"]) for m in members])
                events.append({
                    "type": "repeated", "start": members[0]["start"], "end": members[-1]["end"],
                    "duration_hours": sum(m["duration_hours"] for m in members),
                    "occurrences": [m["peak_time"] for m in members],
                    "peak_time": max(members, key=lambda m: m["z"])["peak_time"],
                    "peak_kwh": round(max(m["peak_kwh"] for m in members), 2),
                    "expected_kwh": round(float(avg_exp), 2), "actual_kwh": round(float(avg_peak), 2),
                    "excess_kwh": round(tot_excess, 2), "ratio": round(float(avg_peak / max(avg_exp, 0.01)), 2),
                    "z": max(m["z"] for m in members), "if_pct": max(m["if_pct"] for m in members),
                    "hours_of_day": [hr], "severity": _level(n, [3, 4, 6]) if n >= 4 else "medium",
                    "circuit": _attribute(cx, mask),
                    "title": f"Recurring {hr:02d}:00 load on {n} days",
                    "factors": [
                        f"An unusual load appeared around {hr:02d}:00 on {n} separate days "
                        f"({pd.Timestamp(members[0]['peak_time']):%d %b} - {pd.Timestamp(members[-1]['peak_time']):%d %b}).",
                        f"Each time it averaged {avg_peak:.2f} kWh vs a normal {avg_exp:.2f} kWh for that hour "
                        f"({avg_peak / max(avg_exp, 0.01):.1f}x).",
                        f"{tot_excess:.1f} kWh of extra energy in total - a pattern like this usually means a timer, "
                        "pump or appliance left on a schedule.",
                    ],
                })
            cluster = [i] if i is not None else []

    for i, sp in enumerate(spikes):
        if i in used:
            continue
        ts = sp.pop("_ts")
        sp["severity"] = _level(sp["excess_kwh"] / typical, [1, 2.5, 5])
        sp["title"] = f"Spike of {sp['peak_kwh']:.2f} kWh at {ts:%H:%M}"
        sp["factors"] = [
            f"Used {sp['peak_kwh']:.2f} kWh at {_fmt_t(ts)} - {sp['ratio']:.1f}x the typical "
            f"{sp['expected_kwh']:.2f} kWh for this hour.",
            f"Robust z-score {sp['z']:.1f} (alert threshold {SPIKE_Z:.0f}; based on the same hour over the last "
            f"{WINDOW_DAYS} days).",
            f"Isolation Forest rates it rarer than {min(sp['if_pct'], 0.9999):.2%} of all hours"
            + (" (outlier by the model)." if sp["if_flag"] else "."),
        ]
        if sp["jump_kwh"] is not None and sp["jump_kwh"] > 0.3:
            sp["factors"].append(f"Jumped +{sp['jump_kwh']:.2f} kWh from the previous hour - a sudden switch-on.")
        if sp["duration_hours"] > 1:
            sp["factors"].append(f"Lasted {sp['duration_hours']} hours, {sp['excess_kwh']:.2f} kWh above normal.")
        events.append(sp)
    if conf["night_enabled"]:
        events = _reconcile_nights(f, excess, conf, events, _night_events(f, excess, cx, conf, sustained_days, events))
    for ev in events:
        ev.pop("_ts", None)
        ev.pop("if_flag", None)
        if ev.get("circuit"):
            ev["factors"].append(f"{ev['circuit']['label']} accounts for {ev['circuit']['share']:.0%} of the extra energy.")

    # ground truth (synthetic / injected datasets)
    has_truth = "injected" in df.columns
    event_mask = np.zeros(len(f), dtype=bool)
    for ev in events:
        if ev["type"] == "sustained":
            m = (f.index >= pd.Timestamp(ev["start"])) & (f.index <= pd.Timestamp(ev["end"]))
        elif ev["type"] == "repeated":
            m = f.index.isin([pd.Timestamp(t) for t in ev["occurrences"]])
        else:
            m = (f.index >= pd.Timestamp(ev["start"])) & (f.index <= pd.Timestamp(ev["end"]))
        ev["_mask"] = m
        event_mask |= m
        ev["origin"] = ("injected" if df["injected"].to_numpy()[m].any() else "natural") if has_truth else "observed"

    rank = {s: i for i, s in enumerate(SEVERITIES)}
    events.sort(key=lambda e: (-rank[e["severity"]], -e["excess_kwh"]))
    for i, ev in enumerate(events, 1):
        ev["id"] = i
    f["flag"] = event_mask
    f["sustained_day"] = f.index.normalize().isin(list(sustained_days))
    if has_truth:
        f["injected"] = df["injected"].to_numpy()
        f["injected_type"] = df["injected_type"].to_numpy()
    return {"frame": f, "daily": daily, "events": events, "circuits": [x.removeprefix("circuit:") for x in circuits], "config": conf}


def _span_mask(f, ev):
    if ev["type"] == "repeated":
        return f.index.isin([pd.Timestamp(t) for t in ev["occurrences"]])
    return (f.index >= pd.Timestamp(ev["start"])) & (f.index <= pd.Timestamp(ev["end"]))


def _reconcile_nights(f, excess, c, events, nights):
    """Decide which explanation wins when a night-time increase overlaps other events.
    - sustained rise whose extra energy is mostly (>=60%) at night -> it is a night-time pattern: keep the night event
    - repeated / spike events entirely inside the flagged nights -> folded into the night event
    - a single night explained mostly (>=60%) by one spike -> keep the spike, drop the night event"""
    night_hour = f.index.hour.isin(night_hours(c))
    pos = excess.clip(lower=0).fillna(0)
    drop, keep_nights = set(), []
    for nv in nights:
        m = nv.pop("_mask")
        ex_n = float(pos[m].sum())
        ok = True
        for i, ev in enumerate(events):
            em = _span_mask(f, ev)
            if not (em & m).any():
                continue
            if ev["type"] == "sustained":
                share = float(pos[em & night_hour].sum()) / max(float(pos[em].sum()), 1e-9)
                if share >= 0.6:
                    drop.add(i)
                else:
                    ok = False  # mostly a daytime/all-day rise: the sustained event explains these nights
            elif ev["type"] in ("spike", "repeated"):
                if nv["nights"] == 1 and ev["type"] == "spike" and ev["excess_kwh"] >= 0.6 * ex_n:
                    ok = False
                elif not (em & ~m).any():
                    drop.add(i)
        if ok:
            keep_nights.append(nv)
    return [e for i, e in enumerate(events) if i not in drop] + keep_nights


def _night_events(f, excess, cx, c, sustained_days, events):
    """Nights whose total is well above the previous NIGHT_HISTORY nights. A night is labelled by the date it
    starts on. Nights explained by a spike or a sustained rise are skipped; consecutive nights merge."""
    hours = night_hours(c)
    s = f["kwh"]
    m = s.index.hour.isin(hours)
    wraps = c["night_start"] > c["night_end"]
    # after-midnight hours belong to the previous evening's night
    owner = (s.index - pd.to_timedelta(((s.index.hour < c["night_end"]) & wraps).astype(int), unit="D")).normalize()
    night = pd.DataFrame({"kwh": s[m].to_numpy(), "owner": owner[m]}).groupby("owner")["kwh"].agg(["sum", "count"])
    night = night[night["count"] >= 0.8 * len(hours)]["sum"]
    flagged = []
    for t, v in night.items():
        # baseline nights exclude ones that were themselves far above normal, so a run can't hide itself
        hist = night[(night.index < t) & (night.index >= t - pd.Timedelta(days=NIGHT_HISTORY))]
        if len(hist) < 5:
            continue
        exp = float(hist.median())
        if exp <= 0 or v < c["night_ratio"] * exp or v - exp < c["night_min_excess_kwh"]:
            continue
        flagged.append((t, float(v), exp, m & (owner == t)))
    out, i = [], 0
    while i < len(flagged):
        j = i
        while j + 1 < len(flagged) and (flagged[j + 1][0] - flagged[j][0]).days == 1:
            j += 1
        run = flagged[i:j + 1]
        win = np.logical_or.reduce([r[3] for r in run])
        act, exp = float(np.mean([r[1] for r in run])), float(np.mean([r[2] for r in run]))
        ratio = act / exp
        idx = f.index[win]
        by_hour = excess[win].groupby(f.index.hour[win]).mean()
        hot = [int(h) for h in by_hour[by_hour >= 0.5 * by_hour.max()].index] if by_hour.max() > 0 else []
        peak = f.loc[idx, "kwh"].idxmax()
        n = len(run)
        win_txt = f"{c['night_start']:02d}:00-{c['night_end']:02d}:00"
        several = f" on {n} consecutive nights" if n > 1 else ""
        out.append({
            "type": "night", "start": idx[0].isoformat(), "end": idx[-1].isoformat(), "duration_hours": int(win.sum()),
            "nights": n, "peak_time": peak.isoformat(), "peak_kwh": round(float(f.loc[peak, "kwh"]), 2),
            "expected_kwh": round(exp, 2), "actual_kwh": round(act, 2),
            "excess_kwh": round(float(sum(r[1] - r[2] for r in run)), 2), "ratio": round(ratio, 2),
            "z": round(float(f.loc[idx, "z"].max()), 1), "if_pct": round(float(f.loc[idx, "if_pct"].mean()), 3),
            "hours_of_day": sorted(hot), "severity": _bump(_level(ratio, [2.3, 3.0, 4.0]), n >= 3), "_mask": win,
            "circuit": _attribute(cx, win),
            "title": f"Night-time use up {ratio - 1:.0%}" + (f" on {n} nights" if n > 1 else ""),
            "factors": [
                f"Between {win_txt} the home used {act:.2f} kWh per night vs a typical {exp:.2f} kWh "
                f"({ratio:.1f}x){several}, starting {run[0][0]:%a %d %b %Y}.",
                f"Baseline = median of the previous {NIGHT_HISTORY} nights; alert at >= {c['night_ratio']:.0%} of it "
                f"and >= {c['night_min_excess_kwh']:g} kWh extra.",
                "The extra load was spread across the night rather than one short spike - typical of a heater, pump, "
                "charger or appliance left running.",
            ],
        })
        i = j + 1
    return out


def evaluate(det):
    """Compare detections with injected ground truth. Segment = same-type injected hours <=13h apart
    (sustained windows may also span a short data gap)."""
    f = det["frame"]
    if "injected" not in f.columns or not f["injected"].any():
        return None
    inj = f[f["injected"]]
    gap = inj.index.to_series().diff()
    seg_id = ((gap > pd.Timedelta(hours=13)) & ~((inj["injected_type"] == "sustained") & (gap <= pd.Timedelta(days=5))) |
              (inj["injected_type"] != inj["injected_type"].shift())).cumsum()
    segments = []
    for _, seg in inj.groupby(seg_id):
        m = f.index.isin(seg.index)
        hit = [ev for ev in det["events"] if (ev["_mask"] & m).any()]
        segments.append({
            "type": seg["injected_type"].iloc[0], "start": seg.index[0].isoformat(), "end": seg.index[-1].isoformat(),
            "hours": len(seg), "detected": bool(hit), "matched_event": hit[0]["id"] if hit else None,
            "matched_type": hit[0]["type"] if hit else None,
        })
    flagged, truth = f["flag"].to_numpy(), f["injected"].to_numpy()
    tp = int((flagged & truth).sum())
    inj_events = sum(ev["origin"] == "injected" for ev in det["events"])
    by_type = {}
    for sgm in segments:
        t = by_type.setdefault(sgm["type"], {"segments": 0, "detected": 0})
        t["segments"] += 1
        t["detected"] += sgm["detected"]
    return {
        "segments": segments, "by_type": by_type,
        "segment_recall": round(sum(s["detected"] for s in segments) / len(segments), 3),
        "event_precision": round(inj_events / len(det["events"]), 3) if det["events"] else None,
        "hour_precision": round(tp / flagged.sum(), 3) if flagged.sum() else None,
        "hour_recall": round(tp / truth.sum(), 3),
        "injected_events": inj_events, "natural_events": len(det["events"]) - inj_events,
    }
