"""Reports on request: any date range and type, stored; preview, PDF and CSV come from the same stored figures."""
import csv
import io
from datetime import date, timedelta

from app import db
from conftest import make_client
from test_reports_content import pdf_text


def d(n):
    return (date.today() - timedelta(days=n)).isoformat()


def seeded():
    c = make_client()
    for n in range(1, 11):
        c.post("/api/electricity/readings", json={"date": d(n), "kwh": 8 + n})
    for n in range(3, 8):
        c.post("/api/water/readings", json={"date": d(n), "value": 400 + n})
    c.put("/api/limits/electricity", json={"default": 15, "weekdays": {}})
    return c


def test_types_ranges_and_matching_downloads():
    c = seeded()
    e = c.post("/api/reports/custom", json={"kind": "electricity", "start": d(10), "end": d(1)})
    assert e.status_code == 201
    j = e.json()
    data = j["data"]
    assert data["electricity"] and data["water"] is None and data["kind"] == "electricity"
    assert data["electricity"]["total_kwh"] == sum(8 + n for n in range(1, 11)) and data["electricity"]["days_with_data"] == 10
    assert data["electricity"]["limit_violations"] == 3          # the 16, 17 and 18 kWh days are over 15
    rows = list(csv.reader(io.StringIO(c.get(f"/api/reports/custom/{j['id']}/csv").content.decode("utf-8-sig"))))
    assert rows[1] == ["date", "electricity_kwh", "electricity_limit_kwh", "electricity_over_limit"]
    assert len(rows) - 2 == 10 and sum(float(r[1]) for r in rows[2:]) == data["electricity"]["total_kwh"]
    assert sum(r[3] == "yes" for r in rows[2:]) == data["electricity"]["limit_violations"]
    text = pdf_text(c.get(f"/api/reports/custom/{j['id']}/pdf").content)
    assert "Household utility report" in text and f"{data['electricity']['total_kwh']:,.1f} kWh" in text
    w = c.post("/api/reports/custom", json={"kind": "water", "start": d(10), "end": d(1)}).json()["data"]
    assert w["water"]["total_litres"] == sum(400 + n for n in range(3, 8)) and w["electricity"] is None
    both = c.post("/api/reports/custom", json={"kind": "combined", "start": d(10), "end": d(1)}).json()
    assert both["data"]["electricity"] and both["data"]["water"]
    ov = c.get("/api/reports").json()
    assert [r["kind"] for r in ov["custom"]][:3] == ["combined", "water", "electricity"]
    assert c.get(f"/api/reports/custom/{both['id']}").json()["data"] == both["data"]


def test_validation_and_missing_data():
    c = seeded()
    bad = [({"kind": "gas", "start": d(5), "end": d(1)}, "type"),
           ({"kind": "water", "start": d(1), "end": d(5)}, "on or after"),
           ({"kind": "water", "start": d(5), "end": (date.today() + timedelta(days=3)).isoformat()}, "future"),
           ({"kind": "water", "start": d(500), "end": d(1)}, "one year"),
           ({"kind": "water", "start": "yesterday", "end": d(1)}, "date like"),
           ({"kind": "water", "start": d(2), "end": d(1)}, "no water data")]
    for body, msg in bad:
        r = c.post("/api/reports/custom", json=body)
        assert r.status_code == 422 and msg in r.text, (body, r.text)
    assert c.get("/api/reports").json()["custom"] == []


def test_reports_are_private_and_deletable():
    c = seeded()
    rid = c.post("/api/reports/custom", json={"kind": "combined", "start": d(10), "end": d(1)}).json()["id"]
    other = make_client()
    for path in (f"/api/reports/custom/{rid}", f"/api/reports/custom/{rid}/pdf", f"/api/reports/custom/{rid}/csv"):
        assert other.get(path).status_code == 404
    assert other.delete(f"/api/reports/custom/{rid}").status_code == 404
    assert c.delete(f"/api/reports/custom/{rid}").json() == {"deleted": 1}
    assert c.get(f"/api/reports/custom/{rid}").status_code == 404


def test_monthly_report_csv_and_old_reports():
    c = seeded()
    period = d(1)[:7]
    c.post("/api/reports/generate", json={"period": period})
    r = c.get(f"/api/reports/{period}/csv")
    assert r.status_code == 200 and "electricity_kwh" in r.text
    uid = c.get("/api/auth/me").json()["id"]
    with db.connect() as conn:  # a report saved before daily figures were stored
        conn.execute("INSERT INTO monthly_reports (user_id, period, status, data, trigger, generated_at) VALUES (?, '2020-01', 'ready', ?, 'manual', ?)",
                     (uid, db.dumps({"label": "January 2020", "electricity": None, "water": None}), db.now()))
    old = c.get("/api/reports/2020-01/csv")
    assert old.status_code == 409 and "Generate it again" in old.text


def test_downloads_have_meaningful_names_and_labelled_columns():
    c = seeded()
    j = c.post("/api/reports/custom", json={"kind": "combined", "start": d(10), "end": d(1)}).json()
    pdf = c.get(f"/api/reports/custom/{j['id']}/pdf")
    assert pdf.headers["content-disposition"].startswith('attachment; filename="PowerPulse_Combined_Report_') and pdf.content.startswith(b"%PDF")
    csv_r = c.get(f"/api/reports/custom/{j['id']}/csv")
    assert csv_r.headers["content-disposition"].endswith('.csv"')
    rows = list(csv.reader(io.StringIO(csv_r.content.decode("utf-8-sig"))))
    assert rows[0][0].startswith("PowerPulse Combined report") and d(10) in rows[0][0] and d(1) in rows[0][0]
    assert rows[1] == ["date", "electricity_kwh", "electricity_limit_kwh", "electricity_over_limit", "water_litres", "water_limit_litres", "water_over_limit"]


def test_expected_baseline_is_stored_for_imported_days():
    c = make_client()
    ds = c.post("/api/datasets/scenario", json={"scenario": "spike", "seed": 3}).json()["dataset"]
    start, end = ds["start"][:10], (date.fromisoformat(ds["start"][:10]) + timedelta(days=40)).isoformat()
    data = c.post("/api/reports/custom", json={"kind": "electricity", "start": start, "end": end}).json()["data"]
    assert any(r["kwh_expected"] is not None for r in data["daily"])
    rows = list(csv.reader(io.StringIO(c.get(f"/api/reports/custom/{c.get('/api/reports').json()['custom'][0]['id']}/csv").content.decode("utf-8-sig"))))
    assert "electricity_expected_kwh" in rows[1]
