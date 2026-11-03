"""Auth, isolation, limits, water, notifications, monthly reports, detection settings."""
import json
import re
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app import db, mailer, monthly
from app.engine import water
from app.main import app
from conftest import PASSWORD, make_client

ROOT_SAMPLES = __import__("pathlib").Path(__file__).resolve().parents[2] / "data" / "samples"


def days_ago(n):
    return (date.today() - timedelta(days=n)).isoformat()


# ---------------- authentication ----------------
def test_register_login_logout_and_protected_routes():
    anon = TestClient(app, headers={"X-Requested-With": "PowerPulse"})
    assert anon.get("/api/auth/me").status_code == 401
    assert anon.get("/api/water/summary").status_code == 401
    r = anon.get("/dashboard", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].startswith("/login")
    assert anon.post("/api/auth/register", json={"name": "A", "email": "not-an-email", "password": PASSWORD}).status_code == 422
    assert "at least 8" in anon.post("/api/auth/register", json={"name": "A", "email": "a@x.io", "password": "short1"}).text
    assert "letter and one number" in anon.post("/api/auth/register", json={"name": "A", "email": "a@x.io", "password": "onlyletters"}).text

    c = make_client(email="Owner@Example.com")
    assert c.get("/api/auth/me").json()["email"] == "owner@example.com"
    assert c.get("/dashboard", follow_redirects=False).status_code == 200
    assert c.get("/login", follow_redirects=False).status_code == 303  # signed in -> straight to the dashboard
    assert c.get("/register", follow_redirects=False).status_code == 303  # no second account
    dup = anon.post("/api/auth/register", json={"name": "B", "email": "OWNER@example.com", "password": PASSWORD})
    assert dup.status_code == 409
    assert anon.post("/api/auth/login", json={"email": "owner@example.com", "password": "Wrong1234"}).status_code == 401
    assert c.post("/api/auth/logout").status_code == 200
    assert c.get("/api/auth/me").status_code == 401
    assert anon.post("/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD}).status_code == 200
    # no plaintext password is stored
    with db.connect() as conn:
        h = conn.execute("SELECT password_hash FROM users WHERE email = 'owner@example.com'").fetchone()[0]
    assert h.startswith("scrypt$") and PASSWORD not in h


def test_csrf_header_required():
    c = make_client()
    raw = TestClient(app)
    raw.cookies = c.cookies
    assert raw.post("/api/water/demo").status_code == 403
    assert raw.get("/api/auth/me").status_code == 200  # reads are fine


def test_login_rate_limit():
    c = make_client()
    anon = TestClient(app, headers={"X-Requested-With": "PowerPulse"})
    codes = [anon.post("/api/auth/login", json={"email": c.email, "password": "Nope12345"}).status_code for _ in range(9)]
    assert codes[-1] == 429 and 401 in codes


def test_password_change_and_reset(monkeypatch):
    c = make_client()
    other = TestClient(app, headers={"X-Requested-With": "PowerPulse"})
    assert other.post("/api/auth/login", json={"email": c.email, "password": PASSWORD}).status_code == 200
    assert c.post("/api/auth/password", json={"current_password": "Wrong1234", "new_password": "Moonlight77"}).status_code == 400
    assert c.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "Moonlight77"}).status_code == 200
    assert c.get("/api/auth/me").status_code == 200        # this session stays
    assert other.get("/api/auth/me").status_code == 401    # other sessions are signed out

    sent = []
    monkeypatch.setattr(mailer, "send", lambda to, subject, text: sent.append(text) or "test_mode")
    anon = TestClient(app, headers={"X-Requested-With": "PowerPulse"})
    generic = anon.post("/api/auth/forgot", json={"email": c.email}).json()
    assert anon.post("/api/auth/forgot", json={"email": "nobody@example.com"}).json() == generic  # no account enumeration
    assert len(sent) == 1
    token = re.search(r"token=([\w-]+)", sent[0]).group(1)
    assert anon.post("/api/auth/reset", json={"token": token, "password": "weak"}).status_code == 422
    assert anon.post("/api/auth/reset", json={"token": token, "password": "Starlight99"}).status_code == 200
    assert anon.post("/api/auth/reset", json={"token": token, "password": "Starlight98"}).status_code == 400  # single use
    assert c.get("/api/auth/me").status_code == 401  # reset signs out everywhere
    assert anon.post("/api/auth/login", json={"email": c.email, "password": "Starlight99"}).status_code == 200


# ---------------- data isolation ----------------
def test_users_cannot_access_each_others_data(client_factory):
    a, b = client_factory("Alice"), client_factory("Bob")
    ds = a.post("/api/datasets/scenario", json={"scenario": "spike"}).json()["dataset"]["id"]
    rid = a.post("/api/water/readings", json={"date": days_ago(1), "value": 500}).json()["id"]
    for method, url in [("get", f"/api/datasets/{ds}"), ("get", f"/api/datasets/{ds}/report.csv"), ("get", f"/api/datasets/{ds}/data.csv"),
                        ("post", f"/api/datasets/{ds}/activate"), ("delete", f"/api/datasets/{ds}"), ("delete", f"/api/water/readings/{rid}")]:
        assert getattr(b, method)(url).status_code == 404, url
    assert b.put(f"/api/water/readings/{rid}", json={"date": days_ago(1), "value": 1}).status_code == 404
    assert b.get("/api/datasets").json() == []
    assert b.get("/api/water/readings").json()["total"] == 0
    assert b.get("/api/notifications").json()["total"] == 0
    assert b.put("/api/checklists", json={"dataset_id": ds, "key": "standby", "done": [0]}).status_code == 404
    assert a.get(f"/api/datasets/{ds}").status_code == 200


# ---------------- limits & threshold notifications ----------------
def test_limits_status_warnings_and_dedupe(client):
    c = client
    c.put("/api/limits/water", json={"default": 500, "weekdays": {}})
    for i in range(10, 1, -1):
        c.post("/api/water/readings", json={"date": days_ago(i), "value": 300})
    c.post("/api/water/readings", json={"date": days_ago(1), "value": 420})  # 84% -> warning
    st = c.get("/api/water/summary").json()["limit_status"]
    assert st["state"] == "warning" and st["remaining"] == 80 and st["pct"] == 84
    kinds = [n["kind"] for n in c.get("/api/notifications").json()["items"]]
    assert kinds.count("water_limit_warning") == 1
    # editing the same day over the limit -> one 'reached' notification with the excess
    rid = c.get("/api/water/readings").json()["items"][0]["id"]
    c.put(f"/api/water/readings/{rid}", json={"date": days_ago(1), "value": 0.56, "unit": "kL"})
    st = c.get("/api/water/summary").json()["limit_status"]
    assert st["state"] == "exceeded" and st["excess"] == 60
    c.post("/api/notifications/evaluate")
    c.post("/api/notifications/evaluate")
    items = c.get("/api/notifications").json()["items"]
    assert [n["kind"] for n in items].count("water_limit_reached") == 1  # no duplicates
    assert "60 L over" in next(n for n in items if n["kind"] == "water_limit_reached")["body"]
    # per-weekday override + changing the limit
    wd = date.fromisoformat(days_ago(1)).weekday()
    c.put("/api/limits/water", json={"default": 500, "weekdays": {str(wd): 1000}})
    assert c.get("/api/water/summary").json()["limit_status"]["state"] == "ok"
    assert c.put("/api/limits/water", json={"default": -5}).status_code == 422
    # warning threshold is configurable and notifications can be switched off
    assert c.patch("/api/settings", json={"water": {"warn_pct": 120}}).status_code == 422
    c.patch("/api/settings", json={"water": {"warn_pct": 50, "notify_limits": False}})
    c.put("/api/limits/water", json={"default": 600})
    assert c.get("/api/water/summary").json()["limit_status"]["state"] == "warning"
    assert [n["kind"] for n in c.get("/api/notifications").json()["items"]].count("water_limit_warning") == 1


def test_electricity_limit_and_anomaly_notifications(client):
    c = client
    res = c.post("/api/datasets/scenario", json={"scenario": "mixed"}).json()
    assert len(res["events"]) > 0
    c.put("/api/limits/electricity", json={"default": 5})
    hh = c.get("/api/household/summary").json()
    st = hh["electricity"]["limit_status"]
    assert st["limit"] == 5 and st["state"] in ("reached", "exceeded")
    items = c.get("/api/notifications", params={"category": "electricity"}).json()["items"]
    assert any(n["kind"] == "elec_limit_reached" for n in items)
    # unread filter + mark read
    unread = c.get("/api/notifications", params={"status": "unread"}).json()
    assert unread["unread"] >= 1
    c.post("/api/notifications/read", json={"all": True})
    assert c.get("/api/notifications").json()["unread"] == 0
    assert c.get("/api/notifications", params={"status": "read"}).json()["total"] >= 1


# ---------------- water data ----------------
def test_water_manual_entries_validation_and_units(client):
    c = client
    r = c.post("/api/water/readings", json={"date": days_ago(2), "value": 0.75, "unit": "kL", "notes": "guests"})
    assert r.status_code == 201 and r.json()["litres"] == 750 and r.json()["notes"] == "guests"
    assert c.post("/api/water/readings", json={"date": days_ago(2), "value": 100}).status_code == 409  # duplicate date
    assert c.post("/api/water/readings", json={"date": (date.today() + timedelta(days=2)).isoformat(), "value": 1}).status_code == 422
    assert c.post("/api/water/readings", json={"date": days_ago(3), "value": -1}).status_code == 422
    assert c.post("/api/water/readings", json={"date": days_ago(3), "value": 5, "unit": "gallons"}).status_code == 422
    assert c.post("/api/water/readings", json={"date": "03/11/2026", "value": 5}).status_code == 422
    rid = r.json()["id"]
    assert c.put(f"/api/water/readings/{rid}", json={"date": days_ago(2), "value": 600, "unit": "L"}).json()["litres"] == 600
    assert c.delete(f"/api/water/readings/{rid}").status_code == 200
    assert c.get("/api/water/readings").json()["total"] == 0


def test_water_csv_upload_duplicates_and_detection(client):
    c = client
    content = (ROOT_SAMPLES / "water_daily_sample.csv").read_bytes()
    r = c.post("/api/water/upload", files={"file": ("w.csv", content, "text/csv")}, data={"unit": "L"}).json()
    assert r["inserted"] == 60 and r["granularity"] == "day"
    again = c.post("/api/water/upload", files={"file": ("w.csv", content, "text/csv")}, data={"on_duplicate": "skip"}).json()
    assert again["inserted"] == 0 and again["skipped_duplicates"] == 60
    rep = c.post("/api/water/upload", files={"file": ("w.csv", content, "text/csv")}, data={"on_duplicate": "replace"}).json()
    assert rep["updated"] == 60
    types = {a["type"] for a in c.get("/api/water/anomalies").json()}
    assert types == {"spike", "sustained"}
    a = c.get("/api/water/anomalies").json()[0]
    assert a["expected_litres"] > 0 and a["deviation_pct"] and a["checks"] and "possible causes" in a["disclaimer"]
    bad = c.post("/api/water/upload", files={"file": ("x.csv", b"foo,bar\n1,2\n", "text/csv")})
    assert bad.status_code == 422 and "column" in bad.text


def test_water_demo_detects_planted_events(client):
    c = client
    assert c.post("/api/water/demo").json()["inserted"] > 1000
    s = c.get("/api/water/summary").json()
    assert s["has_data"] and s["latest_is_today"] and s["has_hourly"]
    assert {a["type"] for a in s["anomalies"]} == {"spike", "continuous", "overnight"}
    assert c.get("/api/water/readings", params={"source": "demo"}).json()["total"] > 1000
    assert c.delete("/api/water/readings", params={"source": "demo"}).json()["deleted"] > 1000


def test_device_ingest(client):
    c = client
    key = c.post("/api/water/devices", json={"name": "Main meter"}).json()["key"]
    dev = TestClient(app)
    hour = (date.today() - timedelta(days=1)).isoformat() + "T08:00:00"
    r = dev.post("/api/water/ingest", headers={"X-Device-Key": key}, json={"readings": [{"ts": hour, "litres": 42}, {"ts": hour, "value": 9e9}]})
    assert r.status_code == 200 and r.json()["inserted"] == 1 and len(r.json()["rejected"]) == 1
    r = dev.post("/api/water/ingest", headers={"X-Device-Key": key}, json={"readings": [{"ts": hour, "value": 0.05, "unit": "kL"}]})
    assert r.json()["updated"] == 1  # same hour replaces -> retries are safe
    assert c.get("/api/water/readings").json()["items"][0]["litres"] == 50
    assert dev.post("/api/water/ingest", headers={"X-Device-Key": "ppw_wrong"}, json={"readings": []}).status_code == 401


# ---------------- monthly reports ----------------
def test_monthly_report_calculations_pdf_and_scheduler(client):
    c = client
    c.put("/api/limits/water", json={"default": 500})
    c.put("/api/limits/electricity", json={"default": 10})
    for d in range(1, 11):
        c.post("/api/water/readings", json={"date": f"2026-04-{d:02d}", "value": 400 if d != 5 else 650})
    c.post("/api/datasets/scenario", json={"scenario": "spike"})  # synthetic data covers Mar-May 2026
    rep = c.post("/api/reports/generate", json={"period": "2026-04"}).json()["data"]
    w, e = rep["water"], rep["electricity"]
    assert w["total_litres"] == 9 * 400 + 650 and w["avg_daily_litres"] == 425 and w["limit_violations"] == 1
    assert w["highest_day"] == {"day": "2026-04-05", "value": 650.0} and not w["complete"]
    assert e["days_with_data"] == 30 and e["total_kwh"] > 0 and e["estimated_bill_inr"] > 0
    assert e["limit_violations"] == sum(1 for v in e["violation_days"]) and rep["savings_month_inr"] >= 0
    pdf = c.get("/api/reports/2026-04/pdf")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF-1.4") and pdf.content.rstrip().endswith(b"%%EOF")
    assert c.post("/api/reports/generate", json={"period": "1999-01"}).status_code == 422
    # scheduler: generates last month once, even when run repeatedly
    me = c.get("/api/auth/me").json()
    c.patch("/api/settings", json={"reports": {"day": 3}})
    with db.connect() as conn:  # scheduler must not touch an existing (manual) report
        before = conn.execute("SELECT generated_at FROM monthly_reports WHERE user_id = ? AND period = '2026-04'", (me["id"],)).fetchone()[0]
    monthly.run_scheduler(date(2026, 5, 2))  # before this user's delivery day
    monthly.run_scheduler(date(2026, 5, 4))
    monthly.run_scheduler(date(2026, 5, 9))
    with db.connect() as conn:
        rows = conn.execute("SELECT trigger FROM monthly_reports WHERE user_id = ? AND period = '2026-04'", (me["id"],)).fetchall()
        notes = conn.execute("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND dedupe_key = 'report:2026-04'", (me["id"],)).fetchone()[0]
        after = conn.execute("SELECT generated_at FROM monthly_reports WHERE user_id = ? AND period = '2026-04'", (me["id"],)).fetchone()[0]
    assert len(rows) == 1 and rows[0]["trigger"] == "manual" and before == after  # existing report is not regenerated
    monthly.run_scheduler(date(2026, 6, 5))
    with db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND dedupe_key = 'report:2026-05'", (me["id"],)).fetchone()[0]
    monthly.run_scheduler(date(2026, 6, 6))
    with db.connect() as conn:
        n2 = conn.execute("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND dedupe_key = 'report:2026-05'", (me["id"],)).fetchone()[0]
    assert notes == 0 and n == 1 and n2 == 1


def test_whatsapp_feature_is_removed(client):
    """WhatsApp was removed: no endpoints, no settings, and the profile carries no WhatsApp fields."""
    for method, path in (("get", "/api/whatsapp/status"), ("post", "/api/whatsapp/test"), ("get", "/api/whatsapp/webhook"),
                         ("post", "/api/whatsapp/webhook"), ("post", "/api/reports/2026-04/send")):
        assert getattr(client, method)(path).status_code in (404, 405), path
    s = client.get("/api/settings").json()["settings"]
    assert "whatsapp" not in s and "whatsapp" not in s["reports"] and all(set(v) == {"in_app"} for v in s["notifications"].values())
    assert "whatsapp" not in client.get("/api/auth/me").json()
    assert "whatsapp_mode" not in client.get("/api/health").json()
    # notifications the removed feature created stay stored but are never shown, so the word never reaches the page
    uid = client.get("/api/auth/me").json()["id"]
    with db.connect() as conn:
        for key, kind, title in (("whatsapp-test:abc", "whatsapp_test", "WhatsApp test message"),
                                 ("report-send:2026-04:x", "report_combined", "April 2026 report sent to WhatsApp")):
            conn.execute("INSERT INTO notifications (user_id, category, kind, severity, title, body, dedupe_key, data, created_at) "
                         "VALUES (?, 'account', ?, 'info', ?, 'x', ?, '{}', ?)", (uid, kind, title, key, db.now()))
    shown = client.get("/api/notifications").json()
    assert "whatsapp" not in str(shown).lower() and shown["unread"] == 0
    assert "whatsapp" not in str(client.get("/api/household/summary").json()["notifications"]).lower()
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM notifications WHERE user_id = ?", (uid,)).fetchone()[0] == 2  # kept, not deleted
def test_detection_settings_change_results(client):
    c = client
    base = c.post("/api/datasets/scenario", json={"scenario": "mixed"}).json()
    assert "night_rule" in base["model"]
    assert c.patch("/api/settings", json={"detection": {"spike_z": 99}}).status_code == 422
    assert c.patch("/api/settings", json={"detection": {"night_start": 6, "night_end": 6}}).status_code == 422
    c.patch("/api/settings", json={"detection": {"spike_z": 7.5, "night_enabled": False}})
    strict = c.get("/api/datasets/active").json()
    assert strict["model"]["config"]["spike_z"] == 7.5 and strict["model"]["night_rule"] == "off"
    assert strict["kpis"]["by_type"]["spike"] <= base["kpis"]["by_type"]["spike"]
    assert all(e["type"] != "night" for e in strict["events"])
    c.patch("/api/settings", json={"reset_detection": True})
    assert c.get("/api/datasets/active").json()["model"]["config"]["spike_z"] == 4.0


def test_night_time_rule_finds_overnight_load():
    from app.engine.detector import detect
    from app.engine.synthetic import generate_household
    df = generate_household(seed=3)
    nights = (df.index.normalize() >= "2026-04-20") & (df.index.normalize() <= "2026-04-22") & ((df.index.hour >= 23) | (df.index.hour < 5))
    df.loc[nights, "kwh"] += 0.9  # a heater left on overnight, three nights running
    ev = [e for e in detect(df)["events"] if e["type"] == "night"]
    assert len(ev) == 1 and ev[0]["nights"] >= 2 and ev[0]["ratio"] >= 2
    assert not [e for e in detect(df, {"night_enabled": False})["events"] if e["type"] == "night"]


@pytest.mark.parametrize("name,ok,needle", [
    ("edge_incomplete_data.csv", True, None),
    ("edge_insufficient_data.csv", False, "14 days"),
    ("edge_constant_readings.csv", True, None),
    ("edge_invalid_columns.csv", False, "timestamp"),
])
def test_validation_report_edge_cases(client, name, ok, needle):
    content = client.get(f"/api/samples/{name}").content
    r = client.post("/api/datasets/validate", files={"file": (name, content, "text/csv")}).json()
    assert r["ok"] is ok
    if ok:
        rep = r["report"]
        if name == "edge_incomplete_data.csv":
            assert rep["issues_total"] == 5 and {i["line"] for i in rep["issues"]} >= {32, 47}
        else:
            assert "same value" in rep["warnings"][0]
    else:
        assert needle in r["error"] and r["preview"]
    assert client.get("/api/samples/../../secrets").status_code == 404


def test_recommendation_checklists(client):
    c = client
    res = c.post("/api/datasets/scenario", json={"scenario": "mixed"}).json()
    rec = res["recommendations"][0]
    assert rec["steps"] and rec["done"] == [] and rec["assumption"]
    c.put("/api/checklists", json={"dataset_id": res["dataset"]["id"], "key": rec["key"], "done": [0, 1, 99]})
    again = next(r for r in c.get("/api/datasets/active").json()["recommendations"] if r["key"] == rec["key"])
    assert again["done"] == [0, 1]


def test_account_export_and_delete(client):
    c = client
    c.post("/api/water/readings", json={"date": days_ago(1), "value": 300})
    data = c.get("/api/auth/export").json()
    assert len(data["water_readings"]) == 1 and "password_hash" not in json.dumps(data)
    assert c.post("/api/auth/delete-account", json={"password": "wrong"}).status_code == 400
    assert c.post("/api/auth/delete-account", json={"password": PASSWORD}).status_code == 200
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM water_readings WHERE litres = 300 AND ts = ?", (days_ago(1),)).fetchone()[0] == 0


def test_water_engine_overnight_and_continuous_rules():
    d, h = water.series_from_rows(water.generate_demo())
    ev = {e["type"]: e for e in water.detect(d, h)}
    assert ev["continuous"]["expected_litres"] < ev["continuous"]["actual_litres"]
    assert ev["overnight"]["severity"] in ("high", "critical")
    assert all("faulty" not in " ".join(e["explanations"]).lower() for e in ev.values())


# ---------------- electricity / water parity ----------------
def test_limit_history_for_both_utilities_keeps_units_apart(client):
    c = client
    c.post("/api/datasets/scenario", json={"scenario": "spike"})
    c.put("/api/limits/electricity", json={"default": 15})
    for i in range(12, 0, -1):
        c.post("/api/water/readings", json={"date": days_ago(i), "value": 700 if i in (3, 5) else 400})
    c.put("/api/limits/water", json={"default": 0.6 * 1000})
    e = c.get("/api/limits/electricity/history?days=30").json()
    w = c.get("/api/limits/water/history?days=30").json()
    assert e["unit"] == "kWh" and w["unit"] == "L"
    assert w["stats"]["days_over"] == 2 and w["stats"]["total_excess"] == 200 and w["violations"][0]["day"] == days_ago(3)
    assert w["stats"]["streak_within"] == 2 and all(cap == 600 for cap in w["daily"]["limit"])
    assert max(e["daily"]["v"]) < 100 and e["stats"]["days"] == len(e["daily"]["t"])  # kWh scale, not litres
    assert c.get("/api/limits/gas/history").status_code == 404


def test_water_savings_reports_and_checklists(client):
    c = client
    c.post("/api/water/demo")
    s = c.get("/api/water/summary").json()
    keys = {r["key"] for r in s["recommendations"]}
    assert {"leak", "overflow", "fixtures"} <= keys
    leak = next(r for r in s["recommendations"] if r["key"] == "leak")
    assert leak["litres_month"] > 0 and leak["inr_month"] > 0 and leak["steps"] and leak["assumption"]
    m = s["monthly_costs"][-1]
    assert m["kl"] == round(m["litres"] / 1000, 2) and m["bill"] > 0
    assert s["patterns"]["night_share"] is not None and len(s["patterns"]["heatmap"]) == 7 * 24 and s["rules"]["continuous"]
    c.put("/api/checklists", json={"dataset_id": "water", "key": "leak", "done": [0, 2, 99]})
    leak2 = next(r for r in c.get("/api/water/summary").json()["recommendations"] if r["key"] == "leak")
    assert leak2["done"] == [0, 2]
    assert c.put("/api/checklists", json={"dataset_id": "water", "key": "standby", "done": [0]}).status_code == 422
    csv_text = c.get("/api/water/export.csv").text
    assert csv_text.startswith("timestamp,granularity,litres,source,notes") and csv_text.count("\n") > 1000


def test_theme_preference_is_saved(client):
    assert client.patch("/api/settings", json={"appearance": {"theme": "dark"}}).json()["settings"]["appearance"]["theme"] == "dark"
    assert client.patch("/api/settings", json={"appearance": {"theme": "neon"}}).status_code == 422
