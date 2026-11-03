"""Synthetic Indian household + anomaly injection for validating the detector.

Every injected hour is labelled (`injected=True`, `injected_type=<scenario>`), so the
UI can tell planted anomalies apart from naturally occurring ones.
"""
import numpy as np
import pandas as pd

from .loader import CIRCUIT_LABELS

SCENARIOS = {
    "normal": "Normal household - no anomalies injected",
    "spike": "Sudden spikes - geyser / heater left on for 1-2 hours",
    "sustained": "Sustained increase - AC thermostat fault for 9 days",
    "repeated": "Repeated unusual use - a 02:00 load recurring on 6 nights",
    "mixed": "All of the above in one dataset",
}


def _c(key):
    return f"circuit:{CIRCUIT_LABELS[key]}"


def generate_household(days=75, start="2026-03-01", seed=7):
    """Hourly kWh for a 2-3 BHK home in a hot climate, split by circuit."""
    rng = np.random.default_rng(seed)
    idx = pd.date_range(start, periods=days * 24, freq="h")
    h = idx.hour.to_numpy()
    weekend = np.asarray(idx.day_of_week >= 5)
    day_no = np.arange(len(idx)) // 24
    heat = 0.75 + 0.35 * (day_no / days) + rng.normal(0, 0.08, days)[day_no]  # summer warms up

    always_on = 0.11 + 0.04 * (rng.random(len(idx)) < 0.45)  # fridge compressor cycling
    ac_hours = ((h >= 13) & (h <= 17)) | (h >= 22) | (h <= 1)
    cooling = np.where(ac_hours, 0.55 * heat * rng.uniform(0.7, 1.1, len(idx)), 0.0)
    cooling[weekend & (h >= 11) & (h <= 17)] *= 1.25
    geyser = np.where((h >= 6) & (h <= 7), rng.uniform(0.4, 0.9, len(idx)), 0.0)
    kitchen = np.select([(h >= 7) & (h <= 9), (h >= 12) & (h <= 13), (h >= 19) & (h <= 21)],
                        [0.30, 0.22, 0.35], 0.03) * rng.uniform(0.6, 1.4, len(idx))
    lighting = np.select([(h >= 18) & (h <= 23), (h >= 6) & (h <= 8)], [0.22, 0.08], 0.02) \
        * rng.uniform(0.8, 1.2, len(idx))
    parts = {"always_on": always_on, "cooling": cooling, "water_heater": geyser,
             "kitchen": kitchen, "lighting": lighting, "pump": np.zeros(len(idx))}
    df = pd.DataFrame({_c(k): np.round(v, 4) for k, v in parts.items()}, index=idx)
    df.index.name = "timestamp"
    df.insert(0, "kwh", df.sum(axis=1).round(4))
    df["injected"] = False
    df["injected_type"] = ""
    return df


def _add(df, mask, kwh, circuit, label):
    df.loc[mask, "kwh"] += kwh
    if circuit in df.columns:
        df.loc[mask, circuit] += kwh
    df.loc[mask, "injected"] = True
    df.loc[mask, "injected_type"] = label


def inject(df, scenario, seed=7):
    """Plant anomalies into a copy of an hourly frame. Works with or without circuit columns."""
    if scenario not in SCENARIOS:
        raise ValueError(f"Unknown scenario '{scenario}'")
    df = df.copy()
    if "injected" not in df.columns:
        df["injected"] = False
        df["injected_type"] = ""
    rng = np.random.default_rng(seed)
    days = pd.Series(df.index.normalize().unique())
    n = len(days)
    # keep the first 3 weeks clean so the trailing baseline has history to learn from
    zones = {"spike": (0.30, 0.45), "sustained": (0.50, 0.66), "repeated": (0.75, 0.92)}
    todo = ["spike", "sustained", "repeated"] if scenario == "mixed" else [scenario] if scenario != "normal" else []
    level = float(df["kwh"].median())

    for kind in todo:
        lo, hi = (int(n * zones[kind][0]), int(n * zones[kind][1]))
        if kind == "spike":
            for d in rng.choice(np.arange(lo, hi), size=2, replace=False):
                hour = int(rng.choice([10, 15, 20]))
                start = days[d] + pd.Timedelta(hours=hour)
                mask = (df.index >= start) & (df.index < start + pd.Timedelta(hours=int(rng.integers(1, 3))))
                _add(df, mask, max(2.5, 4 * level) * rng.uniform(1.0, 1.3), _c("water_heater"), "spike")
        elif kind == "sustained":
            start, end = days[lo], days[lo] + pd.Timedelta(days=9)
            mask = (df.index >= start) & (df.index < end) & (df.index.hour >= 11)
            _add(df, mask, df.loc[mask, "kwh"].to_numpy() * 0.45 + 0.15, _c("cooling"), "sustained")
        elif kind == "repeated":
            for d in range(lo, min(hi, lo + 12), 2):
                start = days[d] + pd.Timedelta(hours=2)
                mask = (df.index >= start) & (df.index < start + pd.Timedelta(hours=1))
                _add(df, mask, max(1.2, 2.5 * level), _c("pump"), "repeated")
    return df
