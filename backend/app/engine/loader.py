"""CSV parsing, validation and cleaning -> a clean hourly kWh frame.

Output frame: DatetimeIndex (hourly), column `kwh`, optional `circuit:<name>` kWh
columns, optional ground-truth columns `injected` (bool) / `injected_type` (str).
"""
import io
import re

import numpy as np
import pandas as pd

MIN_DAYS = 14
MAX_BYTES = 60 * 1024 * 1024
MAX_HOURLY_KWH = 60.0  # above this a single home reading is a meter/sensor error

TIME_NAMES = ["timestamp", "datetime", "date_time", "time_stamp", "time", "date", "ts"]
# UCI sub-meter circuits; https://archive.ics.uci.edu/dataset/235
UCI_CIRCUITS = {
    "sub_metering_1": "Kitchen (dishwasher, oven, microwave)",
    "sub_metering_2": "Laundry (washer, dryer, fridge, light)",
    "sub_metering_3": "Water heater & air conditioner",
}
# friendly labels for circuit_<name>_kwh columns (UCI export + synthetic generator)
CIRCUIT_LABELS = {
    "kitchen": UCI_CIRCUITS["sub_metering_1"],
    "laundry": UCI_CIRCUITS["sub_metering_2"],
    "water_heater_ac": UCI_CIRCUITS["sub_metering_3"],
    "always_on": "Always-on (fridge, router, standby)",
    "cooling": "Air conditioner / cooling",
    "water_heater": "Water heater (geyser)",
    "lighting": "Lighting & entertainment",
    "pump": "Water pump & misc",
}


MAX_ISSUES = 200   # row-level problems listed in the validation report (all are counted)
PREVIEW_ROWS = 12


class DataError(ValueError):
    """A problem with the user's file, safe to show in the UI. `details` may carry row-level issues/preview."""

    def __init__(self, msg, details=None):
        super().__init__(msg)
        self.details = details or {}


def _norm(name):
    return re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower()).strip("_")


def _find_value_column(cols):
    """Return (column, kind, scale): kind 'energy' (per interval) or 'power' (average)."""
    for c in cols:
        if "kwh" in c or c in ("energy", "consumption", "usage", "units") or "consumption" in c:
            return c, "energy", 1.0
    for c in cols:
        if c.endswith("wh") or "_wh" in c:
            return c, "energy", 0.001
    for c in cols:
        if "kw" in c or "active_power" in c or c in ("power", "load", "demand"):
            return c, "power", 1.0
    for c in cols:
        if "watt" in c or c in ("w", "power_w"):
            return c, "power", 0.001
    return None, None, None


def parse_csv(content: bytes, filename: str = "upload.csv"):
    """Parse raw CSV bytes. Returns (hourly_df, cleaning_report). Raises DataError (with row-level details
    attached whenever the file got far enough to be read)."""
    details: dict = {}
    try:
        return _parse(content, filename, details)
    except DataError as e:
        if not e.details:
            e.details = details
        raise


def _row_issues(raw, ts, vcol, time_cols):
    """Line-numbered problems (line 1 = header) and their counts, like a spreadsheet would show them."""
    vals = pd.to_numeric(raw[vcol], errors="coerce")
    raw_val = raw[vcol].astype(object).where(raw[vcol].notna(), "").astype(str)
    raw_ts = raw[time_cols].astype(object).where(raw[time_cols].notna(), "").astype(str).agg(" ".join, axis=1).str.strip()
    checks = [
        ("timestamp", "Missing or unrecognised timestamp - row excluded", ts.isna().to_numpy(), raw_ts),
        ("value", "Missing or non-numeric reading - treated as a gap", (vals.isna() & ts.notna()).to_numpy(), raw_val),
        ("value", "Negative reading - removed", (vals < 0).to_numpy(), raw_val),
        ("timestamp", "Duplicate timestamp - merged with the earlier row", (ts.duplicated(keep="first") & ts.notna()).to_numpy(), raw_ts),
    ]
    issues, counts = [], {}
    for field, problem, mask, shown in checks:
        idx = np.flatnonzero(mask)
        if len(idx):
            counts[problem] = int(len(idx))
            issues += [{"line": int(i) + 2, "field": field, "problem": problem, "value": str(shown.iloc[i])[:40]} for i in idx[:MAX_ISSUES]]
    issues.sort(key=lambda x: x["line"])
    return issues[:MAX_ISSUES], counts


def _parse(content: bytes, filename: str, details: dict):
    if not content or not content.strip():
        raise DataError("The file is empty.")
    if len(content) > MAX_BYTES:
        raise DataError(f"File is larger than {MAX_BYTES // 2**20} MB. Resample to hourly or 15-minute data first.")
    text = content.decode("utf-8-sig", errors="replace")
    first = text.split("\n", 1)[0]
    sep = max([",", ";", "\t", "|"], key=first.count)
    try:
        raw = pd.read_csv(io.StringIO(text), sep=sep, na_values=["?", "", "NA", "null", "-"], low_memory=False)
    except Exception as e:  # pandas raises many types for malformed text
        raise DataError(f"Could not read the file as CSV: {e}") from e
    if raw.shape[1] < 2:
        raise DataError("Need at least two columns: a timestamp and a consumption value (e.g. 'timestamp,kwh').")

    original_cols = [str(c) for c in raw.columns]
    details["columns"] = original_cols
    details["preview"] = raw.head(PREVIEW_ROWS).astype(object).where(raw.head(PREVIEW_ROWS).notna(), "").astype(str).values.tolist()
    raw.columns = [_norm(c) for c in raw.columns]
    cols = list(raw.columns)
    rows_raw = len(raw)
    if rows_raw == 0:
        raise DataError("The file has a header but no data rows.")

    # timestamp: either a single column, or separate Date + Time (UCI style)
    if "date" in cols and "time" in cols:
        ts = pd.to_datetime(raw["date"].astype(str) + " " + raw["time"].astype(str), errors="coerce", dayfirst=True)
        time_cols = ["date", "time"]
    else:
        tcol = next((c for c in TIME_NAMES if c in cols), None) or next(
            (c for c in cols if "time" in c or "date" in c), None)
        if tcol is None:
            raise DataError(f"No timestamp column found. Columns seen: {', '.join(cols[:10])}. "
                            "Name it 'timestamp' (e.g. 2024-01-31 14:00).")
        ts = pd.to_datetime(raw[tcol], errors="coerce", format="mixed")
        time_cols = [tcol]
    bad_ts = int(ts.isna().sum())
    if getattr(ts.dt, "tz", None) is not None:
        ts = ts.dt.tz_localize(None)

    value_cols = [c for c in cols if c not in time_cols]
    vcol, kind, scale = _find_value_column(value_cols)
    if vcol is None:
        numeric = [c for c in value_cols if pd.to_numeric(raw[c], errors="coerce").notna().mean() > 0.8]
        if len(numeric) != 1:
            raise DataError("Could not tell which column holds consumption. Name it 'kwh' (energy per row) "
                            "or 'power_kw' (average power).")
        vcol, kind, scale = numeric[0], "energy", 1.0
    issues, issue_counts = _row_issues(raw, ts, vcol, time_cols)
    details.update({"issues": issues, "issue_counts": issue_counts, "rows_raw": rows_raw})

    if bad_ts > 0.2 * rows_raw:
        raise DataError(f"{bad_ts} of {rows_raw} timestamps could not be parsed. Use a format like 2024-01-31 14:00.")
    df = pd.DataFrame(index=ts)
    df["kwh"] = pd.to_numeric(raw[vcol], errors="coerce").to_numpy() * scale
    circuits = {}
    for c in value_cols:
        if c in UCI_CIRCUITS:
            df[f"circuit:{UCI_CIRCUITS[c]}"] = pd.to_numeric(raw[c], errors="coerce").to_numpy() / 1000
            circuits[c] = "Wh"
        elif c.startswith("circuit_") and c != vcol:
            key = c.removeprefix("circuit_").removesuffix("_kwh")
            label = CIRCUIT_LABELS.get(key, key.replace("_", " ").capitalize())
            df[f"circuit:{label}"] = pd.to_numeric(raw[c], errors="coerce").to_numpy()
    has_truth = "injected" in cols
    if has_truth:
        df["injected"] = raw["injected"].astype(str).str.lower().isin(["1", "true", "yes"]).to_numpy()
        df["injected_type"] = raw["injected_type"].fillna("").astype(str).to_numpy() if "injected_type" in cols else ""

    df = df[df.index.notna()].sort_index()
    dupes = int(df.index.duplicated().sum())
    negatives = int((df["kwh"] < 0).sum())
    df.loc[df["kwh"] < 0, "kwh"] = np.nan

    if len(df) < 2:
        raise DataError("Not enough valid rows.")
    step = df.index.to_series().diff().median()
    if step > pd.Timedelta(hours=1):
        # shortcut: hourly-or-finer only; daily meter reads would need a separate daily-only detector
        raise DataError(f"Readings are every {step}; PowerPulse needs hourly or finer data to detect spikes.")
    per_hour = pd.Timedelta(hours=1) / step

    # aggregate to hourly
    num = df.drop(columns=[c for c in ("injected", "injected_type") if c in df.columns])
    grouped = num.resample("h")
    if kind == "power":
        hourly = grouped.mean()  # mean kW over an hour == kWh
    else:
        hourly = grouped.sum(min_count=1)
        hourly = hourly.mul(np.clip(per_hour / grouped["kwh"].count().replace(0, np.nan), 1, None), axis=0)
    coverage = grouped["kwh"].count() / per_hour
    hourly.loc[coverage < 0.5] = np.nan
    if has_truth:
        hourly["injected"] = df["injected"].resample("h").max().astype(bool)
        hourly["injected_type"] = df["injected_type"].resample("h").agg(lambda s: next((v for v in s if v), "")) \
            if isinstance(df["injected_type"], pd.Series) else ""

    outliers = int((hourly["kwh"] > MAX_HOURLY_KWH).sum())
    hourly.loc[hourly["kwh"] > MAX_HOURLY_KWH, "kwh"] = np.nan

    missing_before = int(hourly["kwh"].isna().sum())
    hourly["kwh"] = hourly["kwh"].interpolate(limit=3, limit_area="inside")
    for c in [c for c in hourly.columns if c.startswith("circuit:")]:
        hourly[c] = hourly[c].interpolate(limit=3, limit_area="inside")
    filled = missing_before - int(hourly["kwh"].isna().sum())
    dropped = int(hourly["kwh"].isna().sum())
    hourly = hourly.dropna(subset=["kwh"])

    days = (hourly.index.max() - hourly.index.min()) / pd.Timedelta(days=1) if len(hourly) else 0
    if days < MIN_DAYS:
        raise DataError(f"Only {days:.1f} days of usable data. At least {MIN_DAYS} days are needed to learn a baseline.")

    known = set(time_cols) | {vcol, "injected", "injected_type"} | set(UCI_CIRCUITS) | {c for c in cols if c.startswith("circuit_")}
    ignored = [c for c in cols if c not in known]
    warnings = []
    if hourly["kwh"].std() < 1e-6:
        warnings.append("Every reading is the same value. The file was accepted, but with no variation there is nothing to compare against, so no anomalies can be found.")
    if ignored:
        warnings.append(f"Ignored columns: {', '.join(ignored[:8])}.")
    if dropped:
        warnings.append(f"{dropped} hours fall inside gaps longer than 3 hours and were left out (gaps are never invented).")
    report = {
        "file": filename,
        "rows_raw": rows_raw,
        "rows_hourly": len(hourly),
        "value_column": vcol,
        "interpreted_as": "average power (kW)" if kind == "power" else "energy per reading (kWh)",
        "source_interval": str(step).replace("0 days ", ""),
        "unparseable_timestamps": bad_ts,
        "duplicate_timestamps": dupes,
        "negative_values_removed": negatives,
        "outliers_removed": outliers,
        "short_gaps_interpolated": filled,
        "long_gap_hours_dropped": dropped,
        "circuits": [c.removeprefix("circuit:") for c in hourly.columns if c.startswith("circuit:")],
        "has_ground_truth": has_truth,
        "start": hourly.index.min().isoformat(),
        "end": hourly.index.max().isoformat(),
        "days": round(days, 1),
        "warnings": warnings,
        "issues": details.get("issues", []),
        "issue_counts": details.get("issue_counts", {}),
        "issues_total": int(sum(details.get("issue_counts", {}).values())),
        "columns": details.get("columns", []),
        "preview": details.get("preview", []),
    }
    return hourly, report
