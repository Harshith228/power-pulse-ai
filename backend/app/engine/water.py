"""Household water consumption: CSV parsing, series building and anomaly detection.

All volumes are litres internally. Readings are either daily totals (granularity 'day', e.g. manual entries)
or hourly totals ('hour', e.g. smart meters). A day's total is the sum of its hourly readings when it has any,
otherwise its daily reading.

Detection is statistical and explains itself. Without per-fixture sensors it can only suggest *possible*
causes and checks; it never claims a specific pipe or appliance is faulty.
"""
import io
import re
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

from .loader import TIME_NAMES, DataError, _norm

MAX_LITRES_HOUR = 3000.0
MAX_LITRES_DAY = 30000.0
MAX_BYTES = 20 * 1024 * 1024
BASELINE_DAYS = 28
MIN_HISTORY = 7
SEVERITIES = ["low", "medium", "high", "critical"]

CHECKS = {
    "taps": "Check for leaking taps and dripping shower heads.",
    "flush": "Inspect toilet flush tanks - add a few drops of food colouring to the cistern and see if it reaches the bowl without flushing.",
    "tank": "Check the overhead tank for overflow and the float valve / pump cut-off.",
    "pipes": "Inspect visible water pipelines and joints for damp patches or drips.",
    "meter": "Close every tap and see whether the meter keeps moving - if it does, water is escaping somewhere.",
    "review": "Review unusual household water usage on that day (guests, washing, gardening, cleaning, filling storage).",
    "schedule": "Review timers on pumps, garden watering and RO purifiers that may run at the same time.",
}
EXPLAIN = {
    "spike": ["One-off heavy use such as washing, gardening, cleaning or filling storage containers.",
              "An overflowing overhead tank while the pump was running.",
              "A burst or open tap left running for a while."],
    "overnight": ["Water flowed while the household is usually asleep.",
                  "Possible causes include a running toilet cistern, a tank filling or overflowing, or a leaking tap."],
    "continuous": ["Consumption never dropped to zero for an entire day - every hour had some flow.",
                   "That pattern is consistent with a continuous leak (cistern, tap or pipe), though a device running all day can look the same."],
    "sustained": ["Daily use has stayed well above this home's own recent level for several days.",
                  "Possible causes include more people at home, a new appliance, seasonal use, or a slow leak."],
    "repeated": ["Unusually high days keep recurring rather than happening once.",
                 "Possible causes include a scheduled pump or watering timer, a regular activity, or an intermittent leak."],
}
RULE_CHECKS = {
    "spike": ["review", "tank", "taps"],
    "overnight": ["flush", "taps", "tank"],
    "continuous": ["meter", "flush", "taps", "pipes"],
    "sustained": ["meter", "pipes", "taps", "review"],
    "repeated": ["schedule", "tank", "review"],
}
TITLES = {
    "spike": "Sudden water spike", "overnight": "High overnight water use", "continuous": "Continuous water flow",
    "sustained": "Water use rising above normal", "repeated": "Repeated unusual water use",
}
DISCLAIMER = "PowerPulse sees the household total only, so these are possible causes to check, not a confirmed fault."


def to_litres(value: float, unit: str) -> float:
    unit = (unit or "L").strip()
    if unit in ("L", "l", "litre", "litres", "liter", "liters"):
        return float(value)
    if unit in ("kL", "kl", "KL", "m3", "m³"):
        return float(value) * 1000.0
    raise DataError("Unit must be litres (L) or kilolitres (kL).")


# ---------------- CSV ----------------
# Column names that mean electricity, so an electricity export is never imported as water.
ELECTRIC_COL = re.compile(r"(^|_)(kwh|wh|kw|watts?|energy|power|voltage|amps?|current|global_active_power|sub_metering\w*)(_|$)")
MAX_ISSUES = 200          # row-level problems listed in the report (all are counted)
PREVIEW_ROWS = 8


def _is_time_name(n):
    return n in TIME_NAMES or n in ("date", "time", "day", "reading_date", "usage_date")


def _unit_of(n):
    if re.search(r"(^|_)(kl|kilolit\w*|m3|cubic\w*)(_|$)", n):
        return "kL"
    if re.search(r"(^|_)(l|ltr|ltrs|litres?|liters?)(_|$)", n):
        return "L"
    return None


def _value_column(cols):
    """Best guess at the water column -> (column, unit from the header or None, cumulative meter?)."""
    for c in cols:
        n = _norm(c)
        if _is_time_name(n) or n in ("notes", "note") or ELECTRIC_COL.search(n):
            continue
        unit = _unit_of(n)
        if unit:
            return c, unit, any(k in n for k in ("reading", "meter_index", "index", "cumulative", "totaliser", "totalizer"))
    for c in cols:
        n = _norm(c)
        if _is_time_name(n) or ELECTRIC_COL.search(n) or any(k in n for k in ("date", "day", "time")):
            continue
        if any(k in n for k in ("water", "usage", "consumption", "volume", "reading", "value", "amount", "flow")):
            return c, None, any(k in n for k in ("reading", "index", "cumulative"))
    return None, None, False


def _date_column(cols):
    names = {_norm(c): c for c in cols}
    for n in TIME_NAMES + ["day", "reading_date", "usage_date"]:
        if n in names:
            return names[n]
    return next((c for c in cols if any(k in _norm(c) for k in ("date", "time", "day"))), None)


def _read(content: bytes):
    if not content or not content.strip():
        raise DataError("The file is empty.")
    if len(content) > MAX_BYTES:
        raise DataError(f"File is larger than {MAX_BYTES // 2**20} MB.")
    text = content.decode("utf-8-sig", errors="replace")
    first = text.split("\n", 1)[0]
    sep = max([",", ";", "\t", "|"], key=first.count)
    try:
        df = pd.read_csv(io.StringIO(text), sep=sep, dtype=str, keep_default_na=False, skip_blank_lines=True)
    except Exception:  # noqa: BLE001 - pandas raises many types for malformed text
        raise DataError("Could not read the file as CSV. Save it as comma-separated values (.csv) and try again.") from None
    df.columns = [str(c).strip() for c in df.columns]
    if len(df.columns) < 2:
        raise DataError("Need at least two columns: a date and a water amount (e.g. 'date,water_usage_litres').")
    return df


def parse_water_csv(content: bytes, default_unit: str = "L", date_column: str | None = None, value_column: str | None = None,
                    today: date | None = None):
    """Parse a water CSV -> (records [(ts_iso, granularity, litres)], report).

    Every row that is not imported is listed in report["issues"] with its line number (line 1 = header) and
    counted in report["issue_counts"]; nothing is dropped silently. `date_column` / `value_column` override the
    automatic column mapping. Raises DataError (with `details` carrying columns/issues/preview where known).
    """
    df = _read(content)
    cols = list(df.columns)
    details = {"columns": cols, "preview_raw": df.head(PREVIEW_ROWS).values.tolist()}
    for chosen in (date_column, value_column):
        if chosen and chosen not in cols:
            raise DataError(f"Column '{chosen}' is not in this file.", details)

    vcol, unit, cumulative = (value_column, _unit_of(_norm(value_column)), False) if value_column else _value_column(cols)
    if value_column:
        cumulative = any(k in _norm(value_column) for k in ("reading", "index", "cumulative", "totaliser", "totalizer"))
    if vcol is not None and ELECTRIC_COL.search(_norm(vcol)) and not _unit_of(_norm(vcol)):
        raise DataError(f"Column '{vcol}' holds electricity, not water. Upload electricity files under Electricity > Manage electricity data.", details)
    if vcol is None:
        elec = [c for c in cols if ELECTRIC_COL.search(_norm(c))]
        if elec:
            raise DataError(f"This looks like an electricity file (column '{elec[0]}'), not water. Upload it under Electricity > "
                            "Manage electricity data, or choose the water column below.", details)
        raise DataError("No water column found. Name it e.g. 'water_usage_litres', 'water_usage_kl' or 'litres', or choose it below.", details)
    details["value_column"] = vcol

    two_part = date_column is None and {"date", "time"} <= {_norm(c) for c in cols}
    if two_part:
        names = {_norm(c): c for c in cols}
        dcol = names["date"]
        raw_ts = (df[names["date"]].str.strip() + " " + df[names["time"]].str.strip()).str.strip()
    else:
        dcol = date_column or _date_column([c for c in cols if c != vcol])
        if dcol is None:
            raise DataError(f"No date column found. Columns seen: {', '.join(cols)}. Name it 'date', or choose it below.", details)
        raw_ts = df[dcol].str.strip()
    if dcol == vcol:
        raise DataError("The date and the water amount must be different columns.", details)
    details["date_column"] = dcol
    unit_source = "header" if unit else "chosen"
    unit = unit or (default_unit if default_unit in ("L", "kL") else "L")

    raw_val = df[vcol].str.strip()
    ts = pd.to_datetime(raw_ts.where(raw_ts != ""), errors="coerce", format="mixed", dayfirst=False)
    vals = pd.to_numeric(raw_val.str.replace(",", "", regex=False).where(raw_val != ""), errors="coerce")
    today = today or date.today()
    lines = np.arange(len(df)) + 2

    bad_date = ts.isna().to_numpy()
    missing = (raw_val == "").to_numpy() & ~bad_date
    non_numeric = (vals.isna() & (raw_val != "")).to_numpy() & ~bad_date
    negative = (vals < 0).to_numpy() & ~bad_date
    future = (ts.dt.date > today).fillna(False).to_numpy().astype(bool) & ~bad_date
    ok = ~(bad_date | missing | non_numeric | negative | future)
    dup = np.zeros(len(df), dtype=bool)  # among valid rows only: a bad row must not shadow a good one
    dup[np.flatnonzero(ok)] = ts[ok].duplicated(keep="first").to_numpy()
    ok &= ~dup
    sub_daily = not bool(((ts[ok].dt.hour == 0) & (ts[ok].dt.minute == 0)).all()) if ok.any() else False
    row_cap = (MAX_LITRES_HOUR if sub_daily else MAX_LITRES_DAY) / (1000.0 if unit == "kL" else 1.0)
    huge = (vals > row_cap).to_numpy() & ok & (not cumulative)
    ok &= ~huge

    checks = [
        (bad_date, "date", "Missing or unrecognised date - not imported", raw_ts),
        (missing, "value", "Missing water amount - not imported", raw_val),
        (non_numeric, "value", "Not a number - not imported", raw_val),
        (negative, "value", "Negative amount - not imported", raw_val),
        (future, "date", "Date is in the future - not imported", raw_ts),
        (dup, "date", "Duplicate date/time in this file - the first row was kept", raw_ts),
        (huge, "value", f"Implausibly large for one {'hour' if sub_daily else 'day'} (over {num_cap(row_cap)} {unit}) - not imported", raw_val),
    ]
    issues: list[dict] = []
    counts: dict[str, int] = {}
    for mask, field, problem, shown in checks:
        idx = np.flatnonzero(mask)
        if len(idx):
            counts[problem] = int(len(idx))
            issues += [{"line": int(lines[i]), "field": field, "problem": problem, "value": str(shown.iloc[i])[:40]} for i in idx[:MAX_ISSUES]]
    issues.sort(key=lambda x: x["line"])
    report = {"rows_raw": int(len(df)), "columns": cols, "date_column": dcol + (" + time" if two_part else ""), "value_column": str(vcol),
              "unit_in_file": unit, "unit_source": unit_source, "cumulative_meter": bool(cumulative),
              "issues": issues[:MAX_ISSUES], "issue_counts": counts, "rows_excluded": int((~ok).sum()), "rows_valid": int(ok.sum()),
              "preview_raw": details["preview_raw"]}
    details.update({k: report[k] for k in ("issues", "issue_counts", "rows_excluded", "rows_raw")})

    s = pd.Series(vals[ok].to_numpy(), index=ts[ok]).sort_index()
    if s.empty:
        raise DataError("No valid rows to import - see the problems listed below.", details)
    if cumulative:
        d = s.diff()
        report["meter_resets_dropped"] = int((d < 0).sum())
        s = d[d >= 0]
    s = s * (1000.0 if unit == "kL" else 1.0)
    if not sub_daily:
        out, cap, gran = s.groupby(s.index.normalize()).sum(), MAX_LITRES_DAY, "day"
    else:
        out, cap, gran = s.resample("h").sum(min_count=1).dropna(), MAX_LITRES_HOUR, "hour"
    report["impossible_totals_removed"] = int((out > cap).sum())
    out = out[out <= cap]
    if out.empty:
        raise DataError("No usable readings after cleaning - see the problems listed below.", details)
    report.update({"granularity": gran, "rows_clean": int(len(out)),
                   "start": out.index.min().isoformat(), "end": out.index.max().isoformat()})
    fmt = "%Y-%m-%d" if gran == "day" else "%Y-%m-%dT%H:00:00"
    return [(t.strftime(fmt), gran, round(float(v), 2)) for t, v in out.items()], report


def num_cap(v):
    return f"{v:,.0f}" if v >= 10 else f"{v:g}"


# ---------------- series ----------------
def series_from_rows(rows):
    """rows: iterable of (ts, granularity, litres) -> (daily Series, hourly Series), indexed by Timestamp."""
    daily, hsum, hours = {}, {}, {}
    for ts, gran, litres in rows:
        if gran == "hour":
            hours[ts] = litres
            hsum[ts[:10]] = hsum.get(ts[:10], 0.0) + litres
        else:
            daily[ts[:10]] = litres
    daily.update(hsum)  # hourly detail wins over a daily figure for the same day
    d = pd.Series(daily, dtype=float)
    d.index = pd.to_datetime(d.index)
    h = pd.Series(hours, dtype=float)
    h.index = pd.to_datetime(h.index)
    return d.sort_index(), h.sort_index()


def _robust(window: pd.Series):
    w = window.dropna()
    if len(w) < MIN_HISTORY:
        return None, None
    med = float(w.median())
    mad = float((w - med).abs().median()) * 1.4826
    return med, max(mad, 0.1 * med, 20.0)


def _sev(x, cuts):
    """cuts ascending for medium, high, critical."""
    return "critical" if x >= cuts[2] else "high" if x >= cuts[1] else "medium" if x >= cuts[0] else "low"


def _event(kind, start, end, actual, expected, severity, detail, extra=None):
    dev = None if not expected else round((actual - expected) / expected * 100, 1)
    return {"type": kind, "title": TITLES[kind], "severity": severity, "start": str(start)[:19], "end": str(end)[:19],
            "actual_litres": round(float(actual), 1), "expected_litres": round(float(expected), 1),
            "excess_litres": round(max(float(actual) - float(expected), 0), 1), "deviation_pct": dev,
            "detail": detail, "explanations": EXPLAIN[kind], "checks": [CHECKS[c] for c in RULE_CHECKS[kind]],
            "disclaimer": DISCLAIMER, **(extra or {})}


def detect(daily: pd.Series, hourly: pd.Series | None = None) -> list[dict]:
    events: list[dict] = []
    if daily.empty:
        return events
    d = daily.asfreq("D")  # missing days become NaN and are ignored
    base = {}
    for t in d.index:
        hist = d[(d.index < t) & (d.index >= t - pd.Timedelta(days=BASELINE_DAYS))]
        base[t] = _robust(hist)

    # 1 + 3. spikes, and repeated near-spikes
    near = []
    for t, v in d.items():
        med, spread = base[t]
        if med is None or np.isnan(v):
            continue
        z = (v - med) / spread
        if v >= 1.5 * med and z >= 3.5 and v - med >= 50:
            events.append(_event("spike", t.date(), t.date(), v, med, _sev(v / med, (1.8, 2.2, 3.0)),
                                 f"{v:,.0f} L on {t:%a %d %b %Y} vs a typical {med:,.0f} L ({v / med:.1f}x, robust z {z:.1f}).",
                                 {"z": round(z, 1)}))
        if v >= 1.35 * med and z >= 3.0 and v - med >= 40:
            near.append((t, v, med))
    i = 0
    while i < len(near):
        group = [near[i]]
        j = i + 1
        while j < len(near) and (near[j][0] - group[0][0]).days <= 21:
            group.append(near[j])
            j += 1
        if len(group) >= 3:
            act = float(np.mean([g[1] for g in group]))
            exp = float(np.mean([g[2] for g in group]))
            events.append(_event("repeated", group[0][0].date(), group[-1][0].date(), act, exp,
                                 _sev(len(group), (3, 4, 6)),
                                 f"{len(group)} unusually high days between {group[0][0]:%d %b} and {group[-1][0]:%d %b %Y}, "
                                 f"averaging {act:,.0f} L vs a typical {exp:,.0f} L.",
                                 {"occurrences": [g[0].strftime("%Y-%m-%d") for g in group]}))
            i = j
        else:
            i += 1

    # 2. sustained increase: 7-day mean (spikes clipped) vs a lagged 4-week median
    clipped = d.copy()
    for t in d.index:
        med = base[t][0]
        if med is not None and not np.isnan(d[t]):
            clipped[t] = min(d[t], 1.5 * med)
    r7 = clipped.rolling(7, min_periods=5).mean()
    flags: list[tuple] = []
    for t in d.index:
        lag = d[(d.index <= t - pd.Timedelta(days=8)) & (d.index >= t - pd.Timedelta(days=35))].dropna()
        if len(lag) < 14 or np.isnan(r7[t]):
            flags.append((t, False, None))
            continue
        lm = float(lag.median())
        flags.append((t, r7[t] >= 1.3 * lm and r7[t] - lm >= 40, lm))
    run = []
    for t, f, lm in flags + [(None, False, None)]:
        if f:
            run.append((t, r7[t], lm))
            continue
        if len(run) >= 3:
            act = float(np.mean([r[1] for r in run]))
            exp = float(np.mean([r[2] for r in run]))
            pct = (act / exp - 1) * 100
            events.append(_event("sustained", run[0][0].date(), run[-1][0].date(), act, exp, _sev(pct, (35, 50, 80)),
                                 f"7-day average of {act:,.0f} L/day vs {exp:,.0f} L/day a month earlier (+{pct:.0f}%), "
                                 f"for {len(run)} days."))
        run = []

    if hourly is not None and not hourly.empty:
        h = hourly.asfreq("h")
        # 4. overnight (00:00-04:59)
        night = h[h.index.hour < 5]
        nights = night.groupby(night.index.normalize()).agg(["sum", "count"])
        nights = nights[nights["count"] >= 4]["sum"]
        for t, v in nights.items():
            hist = nights[(nights.index < t) & (nights.index >= t - pd.Timedelta(days=14))]
            if len(hist) < 5:
                continue
            exp = float(hist.median())
            if v >= max(3 * exp, exp + 40) and v >= 30:
                ratio = v / max(exp, 5)
                events.append(_event("overnight", t.date(), t.date(), v, exp, _sev(ratio, (3, 4, 6)),
                                     f"{v:,.0f} L used between 00:00 and 05:00 on {t:%a %d %b %Y}; this home normally uses about {exp:,.0f} L then."))
        # 5. continuous flow: every hour of a (near-)complete day had flow >= 2 L
        per_day = h.groupby(h.index.normalize()).agg(["min", "count"])
        cont = per_day[(per_day["count"] >= 20) & (per_day["min"] >= 2.0)]
        mins_hist = per_day[per_day["count"] >= 20]["min"]
        days = list(cont.index)
        k = 0
        while k < len(days):
            j = k
            while j + 1 < len(days) and (days[j + 1] - days[j]).days == 1:
                j += 1
            span = days[k:j + 1]
            act = float(cont.loc[span, "min"].mean())
            prior = mins_hist[(mins_hist.index < span[0]) & (mins_hist.index >= span[0] - pd.Timedelta(days=14))]
            exp = float(prior.median()) if len(prior) >= 3 else 0.0
            sev = _sev(act, (3, 5, 10))
            if len(span) >= 3 and sev != "critical":
                sev = SEVERITIES[SEVERITIES.index(sev) + 1]
            events.append(_event("continuous", span[0].date(), span[-1].date(), act, exp, sev,
                                 f"Water never stopped flowing for {len(span)} day{'s' if len(span) > 1 else ''} "
                                 f"({span[0]:%d %b} - {span[-1]:%d %b %Y}): the quietest hour still used {act:.1f} L "
                                 f"(normally about {exp:.1f} L).",
                                 {"unit_basis": "litres per hour (minimum hourly flow)"}))
            k = j + 1

    # spikes / repeated days inside a sustained rise (or the week before it, which feeds its 7-day mean) are
    # part of that rise, so fold them in rather than reporting the same water twice
    spans = [(pd.Timestamp(e["start"]) - pd.Timedelta(days=7), pd.Timestamp(e["end"])) for e in events if e["type"] == "sustained"]
    inside = lambda t: any(a <= pd.Timestamp(t) <= b for a, b in spans)  # noqa: E731
    events = [e for e in events if not (
        (e["type"] == "spike" and e["severity"] != "critical" and inside(e["start"])) or
        (e["type"] == "repeated" and sum(map(inside, e["occurrences"])) * 2 >= len(e["occurrences"])))]

    order = {s: i for i, s in enumerate(reversed(SEVERITIES))}
    events.sort(key=lambda e: e["start"], reverse=True)
    events.sort(key=lambda e: order[e["severity"]])
    for i, e in enumerate(events, 1):
        e["id"] = i
        e["key"] = f"{e['type']}:{e['start']}"
    return events


# ---------------- rules, recommendations, monthly costs (water equivalents of the electricity advisor) ----------------
DAYS_PER_MONTH = 30.44
AVOIDABLE_SHARE = 0.8  # same assumption as electricity: most excess is avoidable once the cause is fixed
FIXTURE_SHARE = 0.10   # assumed saving from tap aerators / dual-flush cisterns (an estimate, shown as such)

RULES = {
    "spike": "day >= 1.5x its 28-day median AND robust z >= 3.5 AND at least 50 L extra",
    "sustained": "7-day average (spikes clipped) >= 130% of a lagged 4-week median for >= 3 days, at least 40 L/day extra",
    "repeated": ">= 3 unusually high days (>= 1.35x, z >= 3) within 21 days",
    "overnight": "00:00-05:00 total >= 3x the previous 14 nights' median and >= 30 L (needs hourly data)",
    "continuous": "every hour of a near-complete day used >= 2 L - water never stopped (needs hourly data)",
    "warmup": "needs 7 days of history before a day can be judged",
}

WATER_RECS = {
    "leak": ("Find and fix the leak", "Water kept flowing when nobody should be using it - the classic sign of a leaking cistern, "
             "dripping tap or pipe joint. Fixing it saves that flow every hour of every day.", "droplet",
             ["Close every tap and check whether the meter still moves", "Put food colouring in each toilet cistern - colour in the bowl means a leak",
              "Check taps, shower heads and outdoor taps for drips", "Inspect visible pipes and joints for damp patches"]),
    "overflow": ("Stop overhead-tank overflows", "One-off days far above normal often mean the overhead tank overflowed while the pump ran.",
                 "pump", ["Check the tank's float valve or ball cock", "Fit an automatic water-level controller on the pump",
                          "Note whether the pump was left on during the high-use days"]),
    "rising": ("Investigate rising water use", "Daily use has stayed well above this home's normal level for days.", "trendUp",
               ["Check whether more people are staying or a new appliance was added", "Look for a slow leak (see the meter test)",
                "Review garden watering and washing habits"]),
    "schedule": ("Check timers and scheduled use", "Unusually high days keep recurring, which often points to a timer or routine.", "clock",
                 ["Review garden-watering and pump timers", "Check RO purifier and washing-machine schedules",
                  "Note what happens on the recurring high-use days"]),
    "fixtures": ("Fit water-saving fixtures", "Tap aerators, low-flow shower heads and dual-flush cisterns reduce everyday use without "
                 "changing habits.", "sparkles",
                 ["Fit aerators on kitchen and bathroom taps", "Switch to a low-flow shower head", "Use the half-flush button where available",
                  "Run the washing machine and dishwasher only when full"]),
}
CAUSE = {"continuous": "leak", "overnight": "leak", "spike": "overflow", "sustained": "rising", "repeated": "schedule"}


def event_excess_litres(e):
    """Extra litres an event represents. Continuous-flow events are measured per hour, so scale to whole days."""
    days = (pd.Timestamp(e["end"]) - pd.Timestamp(e["start"])).days + 1
    if e["type"] == "continuous":
        return max(e["actual_litres"] - e["expected_litres"], 0) * 24 * days
    if e["type"] == "sustained":
        return max(e["actual_litres"] - e["expected_litres"], 0) * days
    if e["type"] == "repeated":
        return max(e["actual_litres"] - e["expected_litres"], 0) * len(e.get("occurrences") or [1])
    return max(e["actual_litres"] - e["expected_litres"], 0)


def recommend(events, daily: pd.Series, tariff, advisor):
    """Rule-based water recommendations with estimated monthly litres and rupees saved (assumptions included)."""
    if daily.empty:
        return []
    days = max(len(daily), 1)
    typical_kl = float(daily.tail(30).mean()) * DAYS_PER_MONTH / 1000
    rate = advisor.marginal_rate(typical_kl, tariff)
    groups: dict = {}
    for e in events:
        g = groups.setdefault(CAUSE[e["type"]], {"events": [], "litres": 0.0})
        g["events"].append(e["id"])
        if e["type"] == "continuous":  # an unfixed leak keeps running: price it as ongoing
            g["litres"] += max(e["actual_litres"] - e["expected_litres"], 0) * 24 * DAYS_PER_MONTH
        else:
            g["litres"] += event_excess_litres(e) / days * DAYS_PER_MONTH * AVOIDABLE_SHARE
    out = []
    for key, g in groups.items():
        title, detail, icon, steps = WATER_RECS[key]
        assumption = "fixing the leak stops the measured minimum flow all day" if key == "leak" else \
            f"{AVOIDABLE_SHARE:.0%} of the extra water in linked events is avoidable"
        out.append({"key": key, "title": title, "detail": detail, "icon": icon, "steps": steps, "events": g["events"],
                    "litres_month": round(g["litres"], 0), "inr_month": round(g["litres"] / 1000 * rate, 0), "assumption": assumption})
    fl = typical_kl * 1000 * FIXTURE_SHARE
    title, detail, icon, steps = WATER_RECS["fixtures"]
    out.append({"key": "fixtures", "title": title, "detail": detail, "icon": icon, "steps": steps, "events": [],
                "litres_month": round(fl, 0), "inr_month": round(fl / 1000 * rate, 0),
                "assumption": f"an estimated {FIXTURE_SHARE:.0%} cut in everyday use"})
    out.sort(key=lambda r: -r["litres_month"])
    for i, r in enumerate(out):
        r["priority"] = "high" if i < 2 and r["litres_month"] >= 300 else "medium" if r["litres_month"] >= 100 else "low"
    return out


def monthly_costs(daily: pd.Series, events, tariff, lims, advisor, limits_mod):
    """Per calendar month: litres, bill, anomalous excess, avoidable cost, limit violations - water's cost_summary."""
    out: list[dict] = []
    if daily.empty:
        return out
    excess: dict = {}
    for e in events:
        k = str(e["start"])[:7]
        excess[k] = excess.get(k, 0) + event_excess_litres(e)
    for p, grp in daily.groupby(daily.index.to_period("M")):
        litres = float(grp.sum())
        ex = min(excess.get(str(p), 0.0), litres)
        bill = advisor.bill(litres / 1000, tariff)
        out.append({"month": str(p), "litres": round(litres, 0), "kl": round(litres / 1000, 2), "days": int(len(grp)),
                    "complete": len(grp) >= p.days_in_month, "bill": round(bill, 0), "anomaly_litres": round(ex, 0),
                    "avoidable_inr": round(bill - advisor.bill((litres - ex * AVOIDABLE_SHARE) / 1000, tariff), 0),
                    "violations": len(limits_mod.violations(grp, lims))})
    return out


def patterns(daily: pd.Series, hourly: pd.Series | None):
    """Weekday averages, hour-of-day x weekday heatmap (hourly data only) and plain-language insight inputs."""
    out: dict = {"weekday_avg": [None] * 7, "heatmap": [], "night_share": None, "weekend_vs_weekday": None, "trend_30d": None}
    if daily.empty:
        return out
    by_wd = daily.groupby(daily.index.day_of_week).mean()
    out["weekday_avg"] = [round(float(by_wd[i]), 1) if i in by_wd.index else None for i in range(7)]
    wk, we = daily[daily.index.day_of_week < 5], daily[daily.index.day_of_week >= 5]
    if len(wk) and len(we):
        out["weekend_vs_weekday"] = round(float(we.mean() / wk.mean() - 1), 3)
    if len(daily) >= 60:
        a, b = float(daily.iloc[-30:].mean()), float(daily.iloc[-60:-30].mean())
        out["trend_30d"] = {"last": round(a, 1), "prev": round(b, 1), "change": round(a / b - 1, 3) if b else None}
    if hourly is not None and not hourly.empty:
        h = hourly[hourly.index > hourly.index.max() - pd.Timedelta(days=60)]
        hm = h.groupby([h.index.day_of_week, h.index.hour]).mean()
        out["heatmap"] = [[int(d), int(hr), round(float(v), 2)] for (d, hr), v in hm.items()]
        out["night_share"] = round(float(h[h.index.hour < 5].sum() / max(h.sum(), 1e-9)), 3)
    return out


# ---------------- demo data ----------------
# Average litres per clock hour for a 4-person Indian household (~600 L/day, ~150 L/person).
PROFILE = [0.5, 0.4, 0.4, 0.5, 2, 20, 70, 90, 60, 30, 22, 20, 18, 25, 10, 10, 12, 20, 40, 55, 45, 30, 15, 5]


def generate_demo(days=60, seed=11, now: datetime | None = None):
    """Hourly demo readings ending at the current hour, with three labelled events (see README).
    Returned rows are clearly demo data: callers store them with source='demo'."""
    rng = np.random.default_rng(seed)
    now = (now or datetime.now()).replace(minute=0, second=0, microsecond=0)
    start = datetime.combine((now - timedelta(days=days)).date(), datetime.min.time())
    idx = pd.date_range(start, now, freq="h", inclusive="left")
    prof = np.array(PROFILE)[idx.hour]
    weekend = np.where(idx.day_of_week >= 5, 1.12, 1.0)
    vals = prof * weekend * rng.lognormal(0, 0.25, len(idx))
    vals[(idx.hour < 5) & (rng.random(len(idx)) < 0.15)] += 6  # occasional night-time flush
    today = pd.Timestamp(now.date())
    spike_day, leak_from, night_day = today - pd.Timedelta(days=18), today - pd.Timedelta(days=9), today - pd.Timedelta(days=3)
    vals[(idx.normalize() == spike_day) & (idx.hour >= 10) & (idx.hour <= 12)] += 240  # tank overflow
    leak = (idx.normalize() >= leak_from) & (idx.normalize() < leak_from + pd.Timedelta(days=3))
    vals[leak] += 4.5  # steady leak
    vals[(idx.normalize() == night_day) & (idx.hour >= 1) & (idx.hour <= 3)] += 30  # overnight flow
    return [(t.strftime("%Y-%m-%dT%H:00:00"), "hour", round(float(v), 2)) for t, v in zip(idx, vals, strict=True)]


def parse_day(value) -> date:
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise DataError("Date must be in YYYY-MM-DD format.") from None
