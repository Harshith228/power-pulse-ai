"""Write demo upload files to data/samples/.

sample_meter_export.csv - messy 15-minute smart-meter export (average kW, no labels): has '?' gaps,
  a negative glitch, duplicate rows and an impossible reading, to show the cleaning step.
labelled_mixed_scenario.csv - hourly synthetic data with injected anomalies + ground-truth columns.
edge_*.csv - validation edge cases: incomplete data with bad rows, too few readings, constant readings, wrong columns.
water_daily_sample.csv - 60 days of daily water use (litres) with a spike and a sustained rise.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.engine.loader import CIRCUIT_LABELS  # noqa: E402
from app.engine.synthetic import generate_household, inject  # noqa: E402

OUT = ROOT / "data" / "samples"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(5)

    df = inject(generate_household(days=60, start="2026-04-01", seed=5), "mixed", seed=5)
    quarters = pd.date_range(df.index[0], df.index[-1] + pd.Timedelta(minutes=45), freq="15min")
    q = df["kwh"].reindex(quarters, method="ffill")  # hourly kWh == average kW for each quarter-hour
    kw = (q * rng.uniform(0.85, 1.15, len(q))).round(3).astype(object)
    kw.iloc[rng.choice(len(kw), 40, replace=False)] = "?"
    kw.iloc[500] = -0.4
    kw.iloc[2100] = 999.0
    lines = ["Timestamp,Power (kW)"] + [f"{t:%Y-%m-%d %H:%M},{v}" for t, v in kw.items()]
    lines[3000:3000] = lines[2998:3000]  # duplicated rows
    (OUT / "sample_meter_export.csv").write_text("\n".join(lines) + "\n")

    keys = {label: key for key, label in CIRCUIT_LABELS.items()}
    lab = inject(generate_household(days=75, seed=21), "mixed", seed=21)
    lab.columns = [f"circuit_{keys[c[8:]]}_kwh" if c.startswith("circuit:") else c for c in lab.columns]
    lab.round(4).to_csv(OUT / "labelled_mixed_scenario.csv")
    edge_cases(rng)
    water_sample(np.random.default_rng(9))
    print("Wrote", *sorted(p.name for p in OUT.iterdir()))


def _hourly(days, start, rng):
    idx = pd.date_range(start, periods=days * 24, freq="h")
    base = 0.25 + 0.35 * np.isin(idx.hour, [7, 8, 19, 20, 21]) + 0.15 * np.isin(idx.hour, [12, 13, 18, 22])
    return pd.Series((base * rng.uniform(0.85, 1.15, len(idx))).round(3), index=idx)


def edge_cases(rng):
    """Validation edge cases (row-level report, 'not enough data', constant readings, wrong columns)."""
    s = _hourly(20, "2026-10-01", rng)
    rows = [[f"{t:%Y-%m-%d %H:%M}", f"{v}"] for t, v in s.items()]
    del rows[100:112]                       # a 12-hour gap
    rows[30][1] = "N/A"                     # missing value
    rows[45][1] = "-0.4"                    # negative reading
    rows[60][0] = "2026-02-30 10:00"        # impossible date
    rows[75][0] = ""                        # empty timestamp
    rows.insert(91, list(rows[90]))         # duplicate timestamp
    rows[150], rows[151] = rows[151], rows[150]  # unsorted rows (sorted on load)
    (OUT / "edge_incomplete_data.csv").write_text("timestamp,kwh\n" + "\n".join(",".join(r) for r in rows) + "\n")
    short = _hourly(2, "2026-10-01", rng).iloc[:30]
    (OUT / "edge_insufficient_data.csv").write_text("timestamp,kwh\n" + "\n".join(f"{t:%Y-%m-%d %H:%M},{v}" for t, v in short.items()) + "\n")
    flat = pd.date_range("2026-10-01", periods=20 * 24, freq="h")
    (OUT / "edge_constant_readings.csv").write_text("timestamp,kwh\n" + "\n".join(f"{t:%Y-%m-%d %H:%M},0.50" for t in flat) + "\n")
    (OUT / "edge_invalid_columns.csv").write_text("meter_id,status\nM-104,ok\nM-104,ok\nM-104,check\n")


def water_sample(rng):
    """60 days of daily water totals (litres) with a one-day spike and a week-long rise, for the Water page."""
    idx = pd.date_range("2026-08-01", periods=60, freq="D")
    litres = 560 * np.where(idx.day_of_week >= 5, 1.12, 1.0) * rng.lognormal(0, 0.08, len(idx))
    litres[25] += 900                       # e.g. tank overflow
    litres[48:55] *= 1.55                   # a sustained rise (guests, or a slow leak)
    pd.DataFrame({"date": idx.strftime("%Y-%m-%d"), "litres": litres.round(0).astype(int)}).to_csv(OUT / "water_daily_sample.csv", index=False)


if __name__ == "__main__":
    main()
