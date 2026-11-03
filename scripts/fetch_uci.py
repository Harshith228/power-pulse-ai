"""Download the UCI 'Individual household electric power consumption' dataset and
convert it to an hourly kWh CSV the app can load (data/uci_household_hourly.csv).

Source: https://archive.ics.uci.edu/dataset/235 (Hebrail & Berard, CC BY 4.0)
One house near Paris, 1-minute readings, Dec 2006 - Nov 2010.
"""
import urllib.request
import zipfile
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
URL = "https://archive.ics.uci.edu/static/public/235/individual+household+electric+power+consumption.zip"
ZIP = ROOT / "data" / "raw" / "uci.zip"
OUT = ROOT / "data" / "uci_household_hourly.csv"


def main():
    ZIP.parent.mkdir(parents=True, exist_ok=True)
    if not ZIP.exists():
        print("Downloading", URL)
        urllib.request.urlretrieve(URL, ZIP)
    with zipfile.ZipFile(ZIP) as z:
        with z.open("household_power_consumption.txt") as f:
            raw = pd.read_csv(f, sep=";", na_values="?", low_memory=False)
    raw.index = pd.to_datetime(raw["Date"] + " " + raw["Time"], format="%d/%m/%Y %H:%M:%S")
    minutes = raw.resample("h")["Global_active_power"].count()
    hourly = pd.DataFrame({
        # mean kW over an hour == kWh in that hour
        "kwh": raw["Global_active_power"].resample("h").mean(),
        # sub-meters are Wh per minute -> kWh per hour
        "circuit_kitchen_kwh": raw["Sub_metering_1"].resample("h").sum(min_count=1) / 1000,
        "circuit_laundry_kwh": raw["Sub_metering_2"].resample("h").sum(min_count=1) / 1000,
        "circuit_water_heater_ac_kwh": raw["Sub_metering_3"].resample("h").sum(min_count=1) / 1000,
    })
    hourly[minutes < 30] = float("nan")  # under half an hour of readings: treat as missing
    hourly.index.name = "timestamp"
    hourly.round(4).to_csv(OUT)
    print(f"Wrote {OUT} ({len(hourly)} hourly rows, {hourly['kwh'].isna().sum()} missing)")


if __name__ == "__main__":
    main()
