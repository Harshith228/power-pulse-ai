"""Generated reports never show empty sections: a missing utility or an empty list is stated in words."""
import re
import zlib
from datetime import date, timedelta

from app import db, electricity, report


def d(n):
    return (date.today() - timedelta(days=n)).isoformat()


def pdf_text(content: bytes) -> str:
    out = []
    for m in re.finditer(rb"stream\n(.*?)\nendstream", content, re.S):
        try:
            out.append(zlib.decompress(m.group(1)).decode("cp1252", errors="replace"))
        except zlib.error:
            continue
    return "\n".join(out)


def test_monthly_report_states_missing_utility_and_empty_recommendations(client):
    for n in range(1, 6):
        client.post("/api/electricity/readings", json={"date": d(n), "kwh": 9})
    period = d(1)[:7]
    r = client.post("/api/reports/generate", json={"period": period}).json()["data"]
    assert r["electricity"] and r["water"] is None and r["included"] == {"electricity": True, "water": True}
    assert r["recommendations"] == [] and r["savings_month_inr"] == 0
    text = pdf_text(client.get(f"/api/reports/{period}/pdf").content)
    assert "No water readings were recorded" in text
    assert "No specific savings recommendations" in text
    assert "about Rs 0 a month" not in text
    assert "Total consumption" in text and "Electricity" in text


def test_monthly_report_without_water_in_settings_omits_it_silently(client):
    client.patch("/api/settings", json={"reports": {"include_water": False}})
    client.post("/api/electricity/readings", json={"date": d(1), "kwh": 9})
    period = d(1)[:7]
    client.post("/api/reports/generate", json={"period": period})
    assert "No water readings" not in pdf_text(client.get(f"/api/reports/{period}/pdf").content)


def test_html_report_has_no_header_only_tables(client):
    ds = client.post("/api/datasets/scenario", json={"scenario": "spike", "seed": 3}).json()["dataset"]
    full = client.get(f"/api/datasets/{ds['id']}/report.html").text
    assert "<th>Severity</th>" in full and "No anomalies" not in full
    uid = client.get("/api/auth/me").json()["id"]
    with db.connect() as conn:
        res = electricity.analysis(conn, uid)
    empty = report.events_html({**res, "events": [], "recommendations": []})
    assert "No anomalies" in empty and "No specific recommendations" in empty
    assert "<th>Severity</th>" not in empty and "<th>Action</th>" not in empty
