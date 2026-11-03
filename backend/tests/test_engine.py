import pytest

from app.engine import advisor
from app.engine.detector import detect, evaluate
from app.engine.loader import DataError, parse_csv
from app.engine.synthetic import generate_household, inject


def run(scenario, seed=7):
    det = detect(inject(generate_household(seed=seed), scenario, seed=seed))
    return det, evaluate(det)


@pytest.mark.parametrize("seed", [3, 7, 11, 21])
def test_normal_household_has_no_alerts(seed):
    det, _ = run("normal", seed)
    assert [e for e in det["events"] if e["severity"] in ("high", "critical")] == []
    assert len(det["events"]) <= 1


@pytest.mark.parametrize("scenario", ["spike", "sustained", "repeated", "mixed"])
@pytest.mark.parametrize("seed", [3, 7, 11, 21])
def test_injected_anomalies_are_found_with_right_type(scenario, seed):
    det, ev = run(scenario, seed)
    assert ev["segment_recall"] == 1.0
    assert ev["event_precision"] >= 0.75
    types = {e["type"] for e in det["events"] if e["origin"] == "injected"}
    assert types >= ({"spike", "sustained", "repeated"} if scenario == "mixed" else {scenario})


def test_explanations_and_circuit_attribution():
    det, _ = run("mixed")
    for e in det["events"]:
        assert e["factors"] and e["severity"] in ("low", "medium", "high", "critical")
    sustained = next(e for e in det["events"] if e["type"] == "sustained")
    assert sustained["circuit"]["label"].startswith("Air conditioner")


def test_slab_bill():
    t = advisor.validate_tariff(None)
    assert advisor.bill(0, t) == 50
    assert advisor.bill(150, t) == pytest.approx(50 + 100 * 3 + 50 * 4.5)
    assert advisor.bill(500, t) == pytest.approx(50 + 300 + 450 + 1200 + 750)
    with pytest.raises(ValueError):
        advisor.validate_tariff({"slabs": [{"upto": 100, "rate": 3}, {"upto": 50, "rate": 4}, {"rate": 5}]})


def test_loader_power_column_and_cleaning():
    rows = ["Date;Time;Global_active_power"]
    for i in range(20 * 24 * 4):  # 20 days of 15-minute power readings (UCI-like format)
        t = __import__("datetime").datetime(2024, 1, 1) + __import__("datetime").timedelta(minutes=15 * i)
        rows.append(f"{t:%d/%m/%Y};{t:%H:%M:%S};{'?' if i % 97 == 0 else ('-1' if i == 50 else '2.0')}")
    df, rep = parse_csv("\n".join(rows).encode(), "x.csv")
    assert rep["interpreted_as"].startswith("average power")
    assert df["kwh"].round(6).eq(2.0).all()  # 2 kW for an hour = 2 kWh
    assert rep["negative_values_removed"] == 1


@pytest.mark.parametrize("content,msg", [
    (b"", "empty"),
    (b"a,b\n1,2\n", "timestamp"),
    (b"timestamp,kwh\n2024-01-01 00:00,1\n2024-01-01 01:00,1\n", "days"),
    (b"timestamp,kwh\n2024-01-01,1\n2024-01-02,1\n2024-01-03,1\n", "hourly"),
])
def test_loader_rejects_bad_files(content, msg):
    with pytest.raises(DataError, match=msg):
        parse_csv(content)


def test_api_end_to_end(client):
    c = client
    r = c.post("/api/datasets/scenario", json={"scenario": "mixed"})
    assert r.status_code == 200
    res = r.json()
    ds = res["dataset"]["id"]
    assert res["validation"]["segment_recall"] == 1.0
    assert res["kpis"]["potential_savings_month"] > 0
    assert all(r["kwh_month"] > 0 for r in res["recommendations"])
    assert len(res["hourly"]["t"]) == len(res["hourly"]["kwh"])
    # tariff edit changes the money, not the detections
    t = {"name": "flat", "fixed_monthly": 0, "slabs": [{"upto": None, "rate": 10}]}
    r2 = c.put(f"/api/datasets/{ds}/tariff", json=t).json()
    assert r2["cost"]["effective_rate"] == 10 and len(r2["events"]) == len(res["events"])
    assert c.put(f"/api/datasets/{ds}/tariff", json={"slabs": [{"rate": -1}]}).status_code == 422
    # reports
    assert c.get(f"/api/datasets/{ds}/report.csv").text.startswith("id,type,severity")
    assert "Anomaly report" in c.get(f"/api/datasets/{ds}/report.html").text
    # exported data round-trips through upload with ground truth intact
    csv_bytes = c.get(f"/api/datasets/{ds}/data.csv").content
    up = c.post("/api/datasets/upload", files={"file": ("round.csv", csv_bytes, "text/csv")}).json()
    assert up["validation"]["segment_recall"] == 1.0
    assert set(up["dataset"]["circuits"]) == set(res["dataset"]["circuits"])
    # bad upload gives readable 422
    bad = c.post("/api/datasets/upload", files={"file": ("x.csv", b"foo,bar\n1,2\n", "text/csv")})
    assert bad.status_code == 422 and "timestamp" in bad.text
