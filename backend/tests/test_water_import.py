"""Water CSV import: column mapping, row-level validation (nothing dropped silently), preview, electricity guard."""
from datetime import date, timedelta

import pytest

from app.engine import water
from app.engine.loader import DataError


def d(n):
    return (date.today() - timedelta(days=n)).isoformat()


def csv(*lines):
    return ("\n".join(lines) + "\n").encode()


def test_spec_column_names_litres_and_kl():
    recs, rep = water.parse_water_csv(csv("date,water_usage_litres", f"{d(3)},410", f"{d(2)},395"))
    assert [r[2] for r in recs] == [410, 395] and rep["unit_in_file"] == "L" and rep["unit_source"] == "header"
    recs, rep = water.parse_water_csv(csv("date,water_usage_kl", f"{d(2)},0.45"))
    assert recs == [(d(2), "day", 450.0)] and rep["unit_in_file"] == "kL"


def test_every_rejected_row_is_listed_with_its_line():
    content = csv("date,water_usage_litres",
                  f"{d(6)},400",        # line 2 ok
                  "not-a-date,410",     # 3 bad date
                  f"{d(5)},",           # 4 missing
                  f"{d(4)},lots",       # 5 non-numeric
                  f"{d(3)},-20",        # 6 negative
                  f"{d(3)},420",        # 7 ok
                  f"{d(3)},999",        # 8 duplicate of line 7
                  f"{(date.today() + timedelta(days=3)).isoformat()},300",  # 9 future
                  f"{d(2)},90000")      # 10 implausible
    recs, rep = water.parse_water_csv(content)
    assert [r[0] for r in recs] == [d(6), d(3)] and recs[1][2] == 420  # first of the duplicates kept
    by_line = {i["line"]: i["problem"] for i in rep["issues"]}
    assert set(by_line) == {3, 4, 5, 6, 8, 9, 10}
    assert "date" in by_line[3] and "Missing" in by_line[4] and "number" in by_line[5] and "Negative" in by_line[6]
    assert "Duplicate" in by_line[8] and "future" in by_line[9] and "Implausibly" in by_line[10]
    assert rep["rows_raw"] == 9 and rep["rows_valid"] == 2 and rep["rows_excluded"] == 7 and sum(rep["issue_counts"].values()) == 7


def test_electricity_file_is_refused_as_water():
    with pytest.raises(DataError, match="electricity"):
        water.parse_water_csv(csv("timestamp,kwh", f"{d(2)} 10:00,0.5"))
    with pytest.raises(DataError, match="electricity"):
        water.parse_water_csv(csv("timestamp,energy_consumption_kwh", f"{d(2)} 10:00,0.5"))
    with pytest.raises(DataError, match="electricity"):  # even when chosen explicitly
        water.parse_water_csv(csv("day,kwh,litres", f"{d(2)},3,400"), value_column="kwh")


def test_manual_column_mapping():
    content = csv("Reading Day,Household Meter,comment", f"{d(3)},0.38,x", f"{d(2)},0.405,y")
    with pytest.raises(DataError) as e:
        water.parse_water_csv(content)
    assert e.value.details["columns"] == ["Reading Day", "Household Meter", "comment"]  # UI can offer them
    recs, rep = water.parse_water_csv(content, "kL", date_column="Reading Day", value_column="Household Meter")
    assert recs == [(d(3), "day", 380.0), (d(2), "day", 405.0)] and rep["unit_source"] == "chosen"
    with pytest.raises(DataError, match="not in this file"):
        water.parse_water_csv(content, date_column="nope", value_column="Household Meter")


def test_preview_stores_nothing_and_counts_overlap(client):
    content = csv("date,water_usage_litres", f"{d(4)},400", f"{d(3)},410", f"{d(2)},bad")
    files = lambda: {"file": ("home.csv", content, "text/csv")}  # noqa: E731
    p = client.post("/api/water/upload/preview", files=files()).json()
    assert p["ok"] and p["rows_valid"] == 2 and p["new_records"] == 2 and p["already_saved"] == 0
    assert p["issues"][0]["line"] == 4 and len(p["preview"]) == 2 and p["preview_raw"][0] == [d(4), "400"]
    assert client.get("/api/water/readings").json()["total"] == 0
    r = client.post("/api/water/upload", files=files()).json()
    assert r["inserted"] == 2 and r["rows_excluded"] == 1
    assert client.post("/api/water/upload/preview", files=files()).json()["already_saved"] == 2
    bad = client.post("/api/water/upload/preview", files={"file": ("e.csv", csv("timestamp,kwh", f"{d(1)} 01:00,1"), "text/csv")}).json()
    assert not bad["ok"] and "electricity" in bad["error"] and bad["columns"] == ["timestamp", "kwh"]


def test_water_import_never_touches_electricity(client):
    client.post("/api/datasets/scenario", json={"scenario": "spike", "seed": 2})
    before = client.get("/api/datasets").json()
    client.post("/api/water/upload", files={"file": ("w.csv", csv("date,litres", f"{d(2)},400"), "text/csv")})
    assert client.get("/api/datasets").json() == before


def test_upload_rejects_non_csv(client):
    r = client.post("/api/water/upload/preview", files={"file": ("photo.png", b"\x89PNG", "image/png")})
    assert r.status_code == 422 and "csv" in r.text.lower()
