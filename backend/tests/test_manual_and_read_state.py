"""Manual electricity readings (validation, duplicates, source strategy, limits, detection) and per-user anomaly read state."""
import sqlite3
from datetime import date, datetime, timedelta

from app import db
from conftest import PASSWORD, make_client


def d(n):
    return (date.today() - timedelta(days=n)).isoformat()


def add(c, day, kwh, time=None, **extra):
    return c.post("/api/electricity/readings", json={"date": day, "kwh": kwh, "time": time, **extra})


# ---------------- manual entry ----------------
def test_valid_reading_is_saved_and_listed(client):
    r = add(client, d(1), 9.5, notes="guests", source="smart_meter")
    assert r.status_code == 201
    j = r.json()
    assert j["kwh"] == 9.5 and j["hour"] == -1 and j["time"] is None and j["source_label"] == "Smart meter" and j["counted"]
    h = add(client, d(2), 0.8, time="18:00").json()
    assert h["hour"] == 18 and h["time"] == "18:00"
    lst = client.get("/api/electricity/readings").json()
    assert lst["total"] == 2 and [i["day"] for i in lst["items"]] == [d(1), d(2)]


def test_invalid_readings_are_rejected(client):
    cases = [
        ({"date": d(1), "kwh": -2}, 422, "negative"),
        ({"date": (date.today() + timedelta(days=2)).isoformat(), "kwh": 5}, 422, "future"),
        ({"date": "03/11/2026", "kwh": 5}, 422, "YYYY-MM-DD"),
        ({"date": d(1), "kwh": 5, "time": "18:30"}, 422, "on the hour"),
        ({"date": d(1), "kwh": 5, "time": "25:00"}, 422, "HH:MM"),
        ({"date": d(1), "kwh": 900}, 422, "plausible"),
        ({"date": d(1), "kwh": 70, "time": "10:00"}, 422, "plausible"),
        ({"date": d(1), "kwh": 5, "source": "guess"}, 422, ""),
        ({"date": d(1), "kwh": "lots"}, 422, ""),
        ({"date": d(1), "kwh": 5, "notes": "x" * 501}, 422, "500"),
    ]
    for body, code, text in cases:
        r = client.post("/api/electricity/readings", json=body)
        assert r.status_code == code and text in r.text, (body, r.status_code, r.text)
    assert client.get("/api/electricity/readings").json()["total"] == 0


def test_duplicates_and_mixed_granularity_are_prevented(client):
    assert add(client, d(3), 8).status_code == 201
    dup = add(client, d(3), 8)
    assert dup.status_code == 409 and "already entered" in dup.text
    assert add(client, d(3), 1, time="09:00").status_code == 409            # day already has a total
    assert add(client, d(4), 1, time="09:00").status_code == 201
    assert add(client, d(4), 1, time="09:00").status_code == 409            # same hour twice
    assert add(client, d(4), 9).status_code == 409                          # hours already there
    assert add(client, d(4), 1.5, time="10:00").status_code == 201
    assert client.get("/api/electricity/readings").json()["total"] == 3


def test_edit_and_delete_are_owner_only(client):
    rid = add(client, d(5), 7).json()["id"]
    other = make_client()
    assert other.put(f"/api/electricity/readings/{rid}", json={"date": d(5), "kwh": 1}).status_code == 404
    assert other.delete(f"/api/electricity/readings/{rid}").status_code == 404
    e = client.put(f"/api/electricity/readings/{rid}", json={"date": d(6), "kwh": 7.25, "notes": "fixed"}).json()
    assert e["day"] == d(6) and e["kwh"] == 7.25 and e["notes"] == "fixed"
    add(client, d(5), 4)
    assert client.put(f"/api/electricity/readings/{rid}", json={"date": d(5), "kwh": 7}).status_code == 409  # would duplicate
    assert client.delete(f"/api/electricity/readings/{rid}").json() == {"deleted": 1}
    assert client.get("/api/electricity/readings").json()["total"] == 1
    assert other.get("/api/electricity/readings").json()["total"] == 0


def test_manual_only_household_drives_overview_limits_cost_and_reports(client):
    for n in range(1, 11):
        add(client, d(n), 10)
    client.put("/api/limits/electricity", json={"default": 9, "weekdays": {}})
    add(client, d(0), 12)
    e = client.get("/api/household/summary").json()["electricity"]
    assert e["has_data"] and "dataset" not in e
    assert client.get("/api/limits/electricity/history?days=30").json()["stats"]["days_over"] == 11
    u = client.get("/api/electricity/usage").json()
    assert u["has_data"] and u["window"]["total_kwh"] == 112 and u["window"]["manual_days"] == 11 and u["month"]["cost_inr"] > 0
    assert set(u["daily"]["source"]) == {"manual"}
    notes = client.get("/api/notifications?category=electricity").json()["items"]
    assert any("limit" in n["title"].lower() for n in notes)
    period = d(1)[:7]
    rep = client.post("/api/reports/generate", json={"period": period})
    assert rep.status_code in (200, 201), rep.text
    assert client.get(f"/api/reports/{period}").json()["data"]["electricity"]["dataset"] == "Manual readings"
    pdf = client.get(f"/api/reports/{period}/pdf")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")


def test_imported_data_wins_so_nothing_is_double_counted(client):
    ds = client.post("/api/datasets/scenario", json={"scenario": "spike", "seed": 4}).json()["dataset"]
    covered = (datetime.fromisoformat(ds["start"]) + timedelta(days=10)).date().isoformat()
    before = client.get("/api/electricity/usage?days=730").json()["window"]["total_kwh"]
    r = add(client, covered, 50).json()
    assert r["counted"] is False and "imported data" in r["status"]
    after = client.get("/api/electricity/usage?days=730").json()
    assert after["window"]["total_kwh"] == before                  # the manual 50 kWh is not added on top
    assert client.get("/api/datasets").json()[0]["active"]          # dataset untouched
    newer = add(client, d(1), 6).json()                              # a day the dataset doesn't cover
    assert newer["counted"] is True
    latest = client.get("/api/electricity/usage?days=730").json()
    assert latest["latest_day"] == d(1) and latest["daily"]["source"][-1] == "manual"


def test_detection_needs_history_and_then_flags_a_spike(client):
    add(client, d(1), 40)
    assert client.get("/api/anomalies/electricity").json()["events"] == []      # one reading is never enough
    for n in range(2, 22):
        add(client, d(n), 8 + (n % 3) * 0.5)
    res = client.get("/api/anomalies/electricity").json()
    assert [e["key"] for e in res["events"]] == [f"manual:spike:{d(1)}"]
    e = res["events"][0]
    assert e["data_source"] == "manual" and e["actual_kwh"] == 40 and e["expected_kwh"] < 10 and e["deviation_pct"] > 300
    assert e["severity"] == "critical" and e["checks"] and e["factors"] and e["read"] is False and e["detected_at"]
    assert res["manual"]["ready"] is True


# ---------------- read state ----------------
def _spiky_user():
    c = make_client()
    for n in range(2, 22):
        add(c, d(n), 8)
    add(c, d(1), 30)
    return c


def test_read_state_marking_and_counts():
    c = _spiky_user()
    c.post("/api/datasets/scenario", json={"scenario": "mixed", "seed": 6})
    counts = c.get("/api/anomalies/counts").json()
    total = counts["electricity"]["total"]
    assert total >= 2 and counts["electricity"]["unread"] == total and counts["water"]["total"] == 0
    for _ in range(3):  # loading the list (a background request) never marks anything read
        c.get("/api/anomalies/electricity")
    assert c.get("/api/anomalies/counts").json()["electricity"]["unread"] == total
    keys = [e["key"] for e in c.get("/api/anomalies/electricity").json()["events"]]
    r = c.post("/api/anomalies/electricity/read", json={"keys": keys[:2] + ["someone-else:spike:x"]}).json()
    assert r["updated"] == 2 and r["counts"]["electricity"] == {"total": total, "unread": total - 2, "read": 2}
    assert c.post("/api/anomalies/electricity/read", json={"keys": keys[:1], "read": False}).json()["counts"]["electricity"]["unread"] == total - 1
    assert c.post("/api/anomalies/electricity/read-all").json()["counts"]["electricity"]["unread"] == 0
    listed = c.get("/api/anomalies/electricity").json()
    assert all(e["read"] for e in listed["events"]) and listed["counts"]["read"] == total


def test_read_state_persists_survives_redetection_and_is_per_user():
    c = _spiky_user()
    key = c.get("/api/anomalies/electricity").json()["events"][0]["key"]
    c.post("/api/anomalies/electricity/read", json={"keys": [key]})
    from fastapi.testclient import TestClient

    from app.main import app
    again = TestClient(app, headers={"X-Requested-With": "PowerPulse"})  # a fresh sign-in on another device
    assert again.post("/api/auth/login", json={"email": c.email, "password": PASSWORD}).status_code == 200
    assert again.get("/api/anomalies/counts").json()["electricity"]["unread"] == 0
    add(c, d(23), 8)                                  # new data: detection re-runs and rows are re-created
    assert c.get("/api/anomalies/counts").json()["electricity"]["unread"] == 0
    add(c, d(0), 45)                                  # a new spike appears unread
    cnt = c.get("/api/anomalies/counts").json()["electricity"]
    assert cnt["unread"] == 1 and cnt["read"] == 1
    other = _spiky_user()                             # same data, independent state
    assert other.get("/api/anomalies/counts").json()["electricity"]["unread"] == 1
    assert other.post("/api/anomalies/electricity/read", json={"keys": [key]}).json()["updated"] == 1  # own key with same name
    assert c.get("/api/anomalies/counts").json()["electricity"]["unread"] == 1


def test_water_and_electricity_counts_are_independent(client):
    client.post("/api/water/demo")
    for n in range(2, 22):
        add(client, d(n), 8)
    add(client, d(1), 30)
    counts = client.get("/api/anomalies/counts").json()
    assert counts["water"]["unread"] > 0 and counts["electricity"]["unread"] == 1
    client.post("/api/anomalies/electricity/read-all")
    after = client.get("/api/anomalies/counts").json()
    assert after["electricity"]["unread"] == 0 and after["water"] == counts["water"]
    w = client.get("/api/water/summary").json()
    assert w["anomaly_counts"] == counts["water"] and all(a["read"] is False and a["detected_at"] for a in w["anomalies"])
    key = w["anomalies"][0]["key"]
    assert client.post("/api/anomalies/water/read", json={"keys": [key]}).json()["counts"]["water"]["unread"] == counts["water"]["unread"] - 1
    assert client.post("/api/anomalies/gas/read", json={"keys": [key]}).status_code == 422


def test_marking_requires_a_session():
    from fastapi.testclient import TestClient

    from app.main import app
    anon = TestClient(app, headers={"X-Requested-With": "PowerPulse"})
    assert anon.get("/api/anomalies/counts").status_code == 401
    assert anon.post("/api/anomalies/electricity/read-all").status_code == 401
    assert anon.post("/api/electricity/readings", json={"date": d(1), "kwh": 1}).status_code == 401


def test_migration_v4_keeps_existing_anomalies_and_seeds_state(tmp_path):
    conn = sqlite3.connect(tmp_path / "v3.db")
    conn.row_factory = sqlite3.Row
    for i, sql in enumerate(db.MIGRATIONS[:3], 1):
        conn.executescript("BEGIN;" + sql + f"; PRAGMA user_version = {i}; COMMIT;")
    conn.execute("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (1, 'a@x.io', 'A', 'h', 'x')")
    conn.execute("INSERT INTO anomalies (user_id, utility, dataset_id, event_key, type, severity, start_ts, end_ts, title, data, detected_at) "
                 "VALUES (1, 'water', NULL, 'spike:2026-10-01', 'spike', 'high', '2026-10-01', '2026-10-01', 't', '{}', '2026-10-02T00:00:00Z')")
    conn.commit()
    db.migrate(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(db.MIGRATIONS)
    st = conn.execute("SELECT * FROM anomaly_state").fetchall()
    assert len(st) == 1 and st[0]["read_at"] is None and st[0]["first_detected_at"] == "2026-10-02T00:00:00Z"
    assert conn.execute("SELECT COUNT(*) FROM anomalies").fetchone()[0] == 1
