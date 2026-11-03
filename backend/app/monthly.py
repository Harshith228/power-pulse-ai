"""Household utility reports: calculation, PDF / CSV, the monthly scheduler and the API.

Automatic reports cover one calendar month (YYYY-MM) and are UNIQUE(user_id, period): the scheduler inserts with
INSERT OR IGNORE so it never generates the same month twice. Reports made on request cover any date range (up to a
year) for electricity, water or both and are kept in custom_reports. Every report stores its own daily figures, so
its preview, PDF and CSV always show the same numbers.
"""
import csv
import io
import logging
from datetime import date

import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import Response

from . import db, limits, notify, pdf, user_settings
from .auth import current_user
from .engine import advisor

log = logging.getLogger("powerpulse.reports")
router = APIRouter(prefix="/api/reports", tags=["reports"])


def _period(p):
    try:
        return pd.Period(str(p), "M")
    except (ValueError, TypeError):
        raise HTTPException(422, "Period must look like 2026-10.") from None


def periods_available(conn, user_id):
    from . import electricity, water_api
    es, _ = electricity.daily_series(conn, user_id)
    wd, _ = water_api.series(conn, user_id)
    ps = set(es.index.to_period("M").astype(str)) | set(wd.index.to_period("M").astype(str))
    return sorted(ps, reverse=True)


def _top_days(s, n=1):
    return [{"day": d.strftime("%Y-%m-%d"), "value": round(float(v), 2)} for d, v in s.nlargest(n).items()]


KINDS = ("combined", "electricity", "water")


def _slice(s, start, end):
    return s[(s.index >= pd.Timestamp(start)) & (s.index <= pd.Timestamp(end))] if not s.empty else s


def _bill(series, tariff, div=1.0):
    """Slab tariffs are monthly: bill each calendar month's part of the range separately and add them up."""
    return sum(advisor.bill(float(v) / div, tariff) for v in series.groupby(series.index.to_period("M")).sum())


def build(conn, user, period: str):
    """A calendar month's report, with the utilities chosen in the user's report settings."""
    p = _period(period)
    rp = user_settings.get(conn, user["id"])["reports"]
    kind = "combined" if rp["include_electricity"] and rp["include_water"] else "electricity" if rp["include_electricity"] else "water"
    return build_range(conn, user, p.start_time.date(), p.end_time.date(), kind, p.strftime("%B %Y"), period=str(p),
                       included={"electricity": bool(rp["include_electricity"]), "water": bool(rp["include_water"])})


def build_range(conn, user, start: date, end: date, kind: str, label: str, period: str | None = None, included=None):
    """Compute a report for [start, end] from the user's own data. Returns the JSON document that is stored."""
    from . import electricity, electricity_manual, water_api
    s = user_settings.get(conn, user["id"])
    lims = user_settings.limits(conn, user["id"])
    included = included or {"electricity": kind in ("combined", "electricity"), "water": kind in ("combined", "water")}
    days_total = (end - start).days + 1
    one_month = start.month == end.month and start.year == end.year
    out = {"period": period, "kind": kind, "start": start.isoformat(), "end": end.isoformat(), "label": label,
           "days_in_month": days_total, "generated_at": db.now(),
           "household": user["name"], "electricity": None, "water": None, "recommendations": [], "savings_month_inr": 0,
           "included": included, "daily": []}
    in_range = lambda iso: start.isoformat() <= iso[:10] <= end.isoformat()  # noqa: E731
    daily: dict[str, dict] = {}

    if included["electricity"]:
        es, ds = electricity.daily_series(conn, user["id"])
        em = _slice(es, start, end)
        if not em.empty:
            tariff = s["electricity"]["tariff"]
            res = electricity.analysis(conn, user["id"], ds) if ds else None
            month_events = [e for e in (res["events"] if res else []) + electricity_manual.stored_events(conn, user["id"]) if in_range(e["start"])]
            total = float(em.sum())
            viol = limits.violations(em, lims["electricity"])
            rate = advisor.marginal_rate(total, tariff)
            anomaly_inr = sum(e["excess_kwh"] for e in month_events) * advisor.AVOIDABLE_SHARE * rate
            recs = res["recommendations"] if res else []
            expected = {}
            if res:
                for ms_, exp in zip(res["daily"]["t"], res["daily"]["expected"], strict=True):
                    if exp is not None:
                        expected[pd.Timestamp(ms_, unit="ms").strftime("%Y-%m-%d")] = exp
            for d, v in em.items():
                day = d.strftime("%Y-%m-%d")
                daily.setdefault(day, {})["kwh"] = round(float(v), 2)
                if es.attrs.get("sources", {}).get(day) == "imported" and day in expected:
                    daily[day]["kwh_expected"] = expected[day]
            out["electricity"] = {
                "dataset": ds["name"] if ds else "Manual readings", "days_with_data": int(len(em)), "complete": len(em) >= days_total,
                "total_kwh": round(total, 1), "avg_daily_kwh": round(total / len(em), 2),
                "highest_day": _top_days(em)[0], "anomalies": len(month_events),
                "anomalies_by_severity": {k: sum(e["severity"] == k for e in month_events) for k in user_settings.SEVERITY_ORDER},
                "top_anomalies": [{"title": e["title"], "start": e["start"], "severity": e["severity"], "excess_kwh": e["excess_kwh"]}
                                  for e in month_events[:5]],
                "estimated_bill_inr": round(_bill(em, tariff), 0),
                "projected_bill_inr": round(advisor.bill(total / len(em) * pd.Timestamp(start).days_in_month, tariff), 0) if one_month else round(_bill(em, tariff), 0),
                "anomaly_cost_inr": round(anomaly_inr, 0),
                "limit": lims["electricity"]["default"], "limit_violations": len(viol), "violation_days": viol[:31],
                "potential_savings_month_inr": round(sum(r["inr_month"] for r in recs), 0),
            }
            out["recommendations"] += [{"utility": "electricity", "title": r["title"], "detail": r["detail"], "inr_month": r["inr_month"]} for r in recs[:3]]
            out["savings_month_inr"] += out["electricity"]["potential_savings_month_inr"]

    if included["water"]:
        wd, _ = water_api.series(conn, user["id"])
        wm = _slice(wd, start, end)
        if not wm.empty:
            tariff = s["water"]["tariff"]
            events = [db.loads(r["data"], {}) for r in conn.execute(
                "SELECT data FROM anomalies WHERE user_id = ? AND utility = 'water' AND substr(start_ts, 1, 10) BETWEEN ? AND ? ORDER BY start_ts",
                (user["id"], start.isoformat(), end.isoformat()))]
            for d, v in wm.items():
                daily.setdefault(d.strftime("%Y-%m-%d"), {})["litres"] = round(float(v), 1)
            total = float(wm.sum())
            viol = limits.violations(wm, lims["water"])
            excess = sum(e.get("excess_litres", 0) for e in events if e.get("type") != "continuous")
            excess += sum(e.get("excess_litres", 0) * 24 for e in events if e.get("type") == "continuous")  # per-hour basis
            rate = advisor.marginal_rate(total / 1000, tariff)
            checks = []
            for e in events:
                for c in e.get("checks", []):
                    if c not in checks:
                        checks.append(c)
            out["water"] = {
                "days_with_data": int(len(wm)), "complete": len(wm) >= days_total,
                "total_litres": round(total, 0), "total_kl": round(total / 1000, 2), "avg_daily_litres": round(total / len(wm), 0),
                "highest_day": _top_days(wm)[0], "anomalies": len(events),
                "top_anomalies": [{"title": e["title"], "start": e["start"], "severity": e["severity"], "deviation_pct": e.get("deviation_pct")}
                                  for e in events[:5]],
                "estimated_bill_inr": round(_bill(wm, tariff, 1000), 0),
                "excess_litres": round(excess, 0), "excess_cost_inr": round(excess / 1000 * rate, 0),
                "limit": lims["water"]["default"], "limit_violations": len(viol), "violation_days": viol[:31],
                "checks": checks[:4],
            }
            out["recommendations"] += [{"utility": "water", "title": "Check for water wastage", "detail": c, "inr_month": None} for c in checks[:2]]
            out["savings_month_inr"] += out["water"]["excess_cost_inr"]
    out["savings_month_inr"] = round(out["savings_month_inr"], 0)
    lim_e, lim_w = lims["electricity"], lims["water"]
    out["daily"] = [{"day": d, "kwh": v.get("kwh"), "kwh_expected": v.get("kwh_expected"), "litres": v.get("litres"),
                     "kwh_limit": limits.limit_for(lim_e, pd.Timestamp(d)) if "kwh" in v else None,
                     "litres_limit": limits.limit_for(lim_w, pd.Timestamp(d)) if "litres" in v else None}
                    for d, v in sorted(daily.items())]
    return out


def _kind_of(d):
    return "combined" if d.get("electricity") and d.get("water") else "electricity" if d.get("electricity") else "water"


def filename(d, ext):
    """e.g. PowerPulse_Combined_Report_November_2026.pdf"""
    import re
    label = re.sub(r"[^A-Za-z0-9_-]+", "", re.sub(r"\s+-\s+", "-", d.get("label", "report")).replace(" ", "_"))
    return f"PowerPulse_{(d.get('kind') or _kind_of(d)).title()}_Report_{label}.{ext}"


def _download(content, d, ext, media):
    return Response(content, media_type=media, headers={"Content-Disposition": f'attachment; filename="{filename(d, ext)}"'})


def csv_bytes(d) -> bytes:
    """The report's own daily figures as CSV (the same numbers as its preview and PDF)."""
    from .water_api import safe_cell
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    kind = (d.get("kind") or _kind_of(d)).title()
    w.writerow([f"PowerPulse {kind} report - {d['label']} - period {d.get('start', '')} to {d.get('end', '')}"])
    has_exp = any(r.get("kwh_expected") is not None for r in d.get("daily", []))
    cols = ["date"] + (["electricity_kwh"] + (["electricity_expected_kwh"] if has_exp else []) + ["electricity_limit_kwh", "electricity_over_limit"]
                       if d.get("electricity") else []) + \
           (["water_litres", "water_limit_litres", "water_over_limit"] if d.get("water") else [])
    w.writerow(cols)
    for r in d.get("daily", []):
        row = [r["day"]]
        if d.get("electricity"):
            row += [r["kwh"]] + ([r.get("kwh_expected")] if has_exp else []) + \
                   [r["kwh_limit"], "" if r["kwh"] is None or r["kwh_limit"] is None else ("yes" if r["kwh"] > r["kwh_limit"] else "no")]
        if d.get("water"):
            row += [r["litres"], r["litres_limit"], "" if r["litres"] is None or r["litres_limit"] is None else ("yes" if r["litres"] > r["litres_limit"] else "no")]
        w.writerow(["" if c is None else safe_cell(c) if isinstance(c, str) else c for c in row])  # only text can carry a formula
    return buf.getvalue().encode("utf-8-sig")


def _kind(data):
    e, w = data.get("electricity"), data.get("water")
    return "report_combined" if e and w else "report_electricity" if e else "report_water"


def pdf_bytes(d, user) -> bytes:
    doc = pdf.Doc()
    doc.rect(0, pdf.H - 92, pdf.W, 92, "#0a1324")
    doc.text(48, pdf.H - 42, "PowerPulse", 20, True, "#ffffff")
    title = "Monthly household utility report" if d.get("period") else "Household utility report"
    doc.text(48, pdf.H - 64, f"{title} - {d['label']}", 12, False, "#93c5fd")
    doc.text(48, pdf.H - 80, f"{d['household']} - generated {pd.Timestamp(d['generated_at']):%d %b %Y %H:%M} UTC", 8.5, False, "#94a3b8")
    doc.y = pdf.H - 110
    e, w = d.get("electricity"), d.get("water")
    inc = d.get("included", {"electricity": True, "water": True})
    if not e and not w:
        doc.para("No electricity or water data was recorded for this month.", 11)
    elif not e and inc.get("electricity"):
        doc.heading("Electricity")
        doc.para(f"No electricity readings were recorded for {d['label']}.", 9)
    if e:
        doc.heading("Electricity")
        doc.para(f"Dataset: {e['dataset']}. {e['days_with_data']} of {d['days_in_month']} days have readings"
                 + ("." if e["complete"] else " - totals cover recorded days only."), 9)
        doc.kv_grid([("Total consumption", f"{e['total_kwh']:,.1f} kWh"), ("Average per day", f"{e['avg_daily_kwh']:,.2f} kWh"),
                     ("Highest day", f"{pd.Timestamp(e['highest_day']['day']):%d %b} - {e['highest_day']['value']:,.1f} kWh"),
                     ("Anomalies detected", str(e["anomalies"])), ("Estimated bill", f"Rs {e['estimated_bill_inr']:,.0f}"),
                     ("Daily limit violations", str(e["limit_violations"]) if e["limit"] else "No limit set")])
        if e["top_anomalies"]:
            doc.table(["Anomaly", "Start", "Severity", "Extra kWh"],
                      [[a["title"], pd.Timestamp(a["start"]).strftime("%d %b %H:%M"), a["severity"].title(), f"{a['excess_kwh']:.1f}"] for a in e["top_anomalies"]],
                      [250, 100, 70, 79])
        if e["violation_days"]:
            doc.para("Days over the limit: " + ", ".join(f"{pd.Timestamp(v['day']):%d %b} (+{v['excess']:.1f} kWh)" for v in e["violation_days"][:12]), 9)
    if not w and e and inc.get("water"):
        doc.heading("Water")
        doc.para(f"No water readings were recorded for {d['label']}.", 9)
    if w:
        doc.heading("Water")
        doc.para(f"{w['days_with_data']} of {d['days_in_month']} days have readings" + ("." if w["complete"] else " - totals cover recorded days only."), 9)
        doc.kv_grid([("Total consumption", f"{w['total_kl']:,.2f} kL"), ("Average per day", f"{w['avg_daily_litres']:,.0f} L"),
                     ("Highest day", f"{pd.Timestamp(w['highest_day']['day']):%d %b} - {w['highest_day']['value']:,.0f} L"),
                     ("Unusual water use", f"{w['anomalies']} event(s)"), ("Estimated water bill", f"Rs {w['estimated_bill_inr']:,.0f}"),
                     ("Daily limit violations", str(w["limit_violations"]) if w["limit"] else "No limit set")])
        if w["top_anomalies"]:
            doc.table(["Event", "Date", "Severity", "Deviation"],
                      [[a["title"], pd.Timestamp(a["start"]).strftime("%d %b"), a["severity"].title(),
                        f"{a['deviation_pct']:+.0f}%" if a.get("deviation_pct") is not None else "-"] for a in w["top_anomalies"]],
                      [250, 100, 70, 79])
        if w["checks"]:
            doc.para("Suggested checks:", 10, "#0f172a", True, 2)
            for c in w["checks"]:
                doc.para(f"- {c}", 9, indent=8, gap=1)
    doc.heading("Savings & recommendations")
    recs = d.get("recommendations", [])
    if d["savings_month_inr"]:
        doc.para(f"Estimated potential savings: about Rs {d['savings_month_inr']:,.0f} a month.", 11, "#047857", True)
    if not recs:
        doc.para("No specific savings recommendations this month: nothing in these readings points to avoidable use.", 10)
    for r in recs:
        doc.para(f"{r['title']}" + (f" - about Rs {r['inr_month']:,.0f}/month" if r.get("inr_month") else ""), 10, "#0f172a", True, 1)
        doc.para(r["detail"], 9, indent=0, gap=5)
    doc.para("All costs are estimates based on your configured tariffs and your own readings. Anomaly detection shows when "
             "usage changed; it cannot confirm which appliance or pipe is responsible.", 8, "#64748b")
    return doc.render()


def save(conn, user_id, period, data, trigger, overwrite):
    status = "ready" if (data.get("electricity") or data.get("water")) else "no_data"
    if overwrite:
        conn.execute("INSERT INTO monthly_reports (user_id, period, status, data, trigger, generated_at) VALUES (?, ?, ?, ?, ?, ?) "
                     "ON CONFLICT(user_id, period) DO UPDATE SET status = excluded.status, data = excluded.data, "
                     "trigger = excluded.trigger, generated_at = excluded.generated_at",
                     (user_id, period, status, db.dumps(data), trigger, db.now()))
        return True
    return conn.execute("INSERT OR IGNORE INTO monthly_reports (user_id, period, status, data, trigger, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (user_id, period, status, db.dumps(data), trigger, db.now())).rowcount == 1


def announce(conn, user, data, settings):
    """In-app notification for a ready report, once per period."""
    e, w = data.get("electricity"), data.get("water")
    parts = ([f"{e['total_kwh']:,.0f} kWh electricity (est. Rs {e['estimated_bill_inr']:,.0f})"] if e else []) + \
            ([f"{w['total_kl']:,.1f} kL water (est. Rs {w['estimated_bill_inr']:,.0f})"] if w else [])
    return notify.create(conn, user, _kind(data), f"Your {data['label']} report is ready", "; ".join(parts) + ".",
                         f"report:{data['period']}", "info", {"period": data["period"]}, settings)


def run_scheduler(today: date | None = None):
    """Generate last month's report for every user whose delivery day has arrived (catches up after downtime)."""
    today = today or date.today()
    period = str(pd.Period(today, "M") - 1)
    done = 0
    with db.connect() as conn:
        users = [db.row(r) for r in conn.execute("SELECT * FROM users")]
        for u in users:
            try:
                s = user_settings.get(conn, u["id"])
                if not s["reports"]["enabled"] or today.day < s["reports"]["day"]:
                    continue
                if conn.execute("SELECT 1 FROM monthly_reports WHERE user_id = ? AND period = ?", (u["id"], period)).fetchone():
                    continue
                data = build(conn, u, period)
                if save(conn, u["id"], period, data, "scheduled", overwrite=False) and (data["electricity"] or data["water"]):
                    announce(conn, u, data, s)
                    done += 1
            except Exception:  # noqa: BLE001 - one user's bad data must not stop everyone else's report
                log.exception("monthly report failed for user %s", u["id"])
    return done


# ---------------- API ----------------
def _row(conn, user_id, period):
    r = conn.execute("SELECT * FROM monthly_reports WHERE user_id = ? AND period = ?", (user_id, period)).fetchone()
    if not r:
        raise HTTPException(404, "No report for that month yet. Generate it first.")
    return db.row(r)


@router.get("")
def overview(user=Depends(current_user)):
    with db.connect() as conn:
        rows = conn.execute("SELECT period, status, data, trigger, generated_at FROM monthly_reports WHERE user_id = ? ORDER BY period DESC",
                            (user["id"],)).fetchall()
        s = user_settings.get(conn, user["id"])["reports"]
        avail = periods_available(conn, user["id"])
    t = date.today()
    nxt = date(t.year, t.month, s["day"]) if t.day < s["day"] else (pd.Timestamp(t.year, t.month, 1) + pd.offsets.MonthBegin(1) + pd.Timedelta(days=s["day"] - 1)).date()
    reports = []
    for r in rows:
        d = db.loads(r["data"], {})
        e, w = d.get("electricity") or {}, d.get("water") or {}
        reports.append({"period": r["period"], "label": d.get("label"), "status": r["status"], "trigger": r["trigger"],
                        "generated_at": r["generated_at"], "electricity_kwh": e.get("total_kwh"), "water_kl": w.get("total_kl"),
                        "bill_inr": (e.get("estimated_bill_inr") or 0) + (w.get("estimated_bill_inr") or 0), "savings_inr": d.get("savings_month_inr")})
    with db.connect() as conn:
        custom = [{"id": r["id"], "kind": r["kind"], "label": r["label"], "start": r["start"], "end": r["end"], "generated_at": r["created_at"]}
                  for r in conn.execute('SELECT id, kind, label, start, "end", created_at FROM custom_reports WHERE user_id = ? '
                                        "ORDER BY created_at DESC, id DESC LIMIT 50", (user["id"],))]
    for r, row in zip(reports, rows, strict=True):
        d = db.loads(row["data"], {})
        r["kind"] = d.get("kind") or ("combined" if d.get("electricity") and d.get("water") else "electricity" if d.get("electricity") else "water")
        r["start"], r["end"] = d.get("start") or f"{r['period']}-01", d.get("end") or (pd.Period(r["period"], "M").end_time.date().isoformat())
        r["has_csv"] = "daily" in d
    first = (max(avail) if avail else None)
    return {"settings": s, "periods_available": avail, "reports": reports, "custom": custom,
            "data_range": {"latest_month": first},
            "next_scheduled": {"date": nxt.isoformat(), "period": str(pd.Period(nxt, "M") - 1)} if s["enabled"] else None}


def _date(v, name):
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise HTTPException(422, f"{name} must be a date like 2026-10-01.") from None


def _custom(conn, user_id, rid):
    r = conn.execute("SELECT * FROM custom_reports WHERE id = ? AND user_id = ?", (rid, user_id)).fetchone()
    if not r:
        raise HTTPException(404, "Report not found.")
    return db.row(r)


@router.post("/custom", status_code=201)
def create_custom(kind: str = Body("combined", embed=True), start: str = Body(..., embed=True), end: str = Body(..., embed=True),
                  user=Depends(current_user)):
    """Generate and keep a report for any date range (up to a year) for electricity, water or both."""
    if kind not in KINDS:
        raise HTTPException(422, "Report type must be combined, electricity or water.")
    a, b = _date(start, "Start date"), _date(end, "End date")
    if b < a:
        raise HTTPException(422, "The end date must be on or after the start date.")
    if b > date.today():
        raise HTTPException(422, "The end date can't be in the future.")
    if (b - a).days > 365:
        raise HTTPException(422, "Choose a range of one year or less.")
    whole_month = a.day == 1 and b == (pd.Timestamp(a) + pd.offsets.MonthEnd(0)).date()
    label = a.strftime("%B %Y") if whole_month else f"{a:%d %b %Y} - {b:%d %b %Y}"
    with db.connect() as conn:
        data = build_range(conn, user, a, b, kind, label)
        if not (data["electricity"] or data["water"]):
            what = {"combined": "electricity or water", "electricity": "electricity", "water": "water"}[kind]
            raise HTTPException(422, f"There is no {what} data between {a:%d %b %Y} and {b:%d %b %Y}.")
        rid = conn.execute('INSERT INTO custom_reports (user_id, kind, start, "end", label, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                           (user["id"], kind, a.isoformat(), b.isoformat(), label, db.dumps(data), db.now())).lastrowid
    return {"id": rid, "kind": kind, "start": a.isoformat(), "end": b.isoformat(), "label": label, "created_at": data["generated_at"], "data": data}


@router.get("/custom/{rid}")
def get_custom(rid: int, user=Depends(current_user)):
    with db.connect() as conn:
        r = _custom(conn, user["id"], rid)
    return {**{k: r[k] for k in ("id", "kind", "start", "end", "label", "created_at")}, "data": db.loads(r["data"], {})}


@router.get("/custom/{rid}/pdf")
def custom_pdf(rid: int, user=Depends(current_user)):
    with db.connect() as conn:
        r = _custom(conn, user["id"], rid)
    d = db.loads(r["data"], {})
    return _download(pdf_bytes(d, user), d, "pdf", "application/pdf")


@router.get("/custom/{rid}/csv")
def custom_csv(rid: int, user=Depends(current_user)):
    with db.connect() as conn:
        r = _custom(conn, user["id"], rid)
    d = db.loads(r["data"], {})
    return _download(csv_bytes(d), d, "csv", "text/csv; charset=utf-8")


@router.delete("/custom/{rid}")
def delete_custom(rid: int, user=Depends(current_user)):
    with db.connect() as conn:
        _custom(conn, user["id"], rid)
        conn.execute("DELETE FROM custom_reports WHERE id = ? AND user_id = ?", (rid, user["id"]))
    return {"deleted": 1}


@router.post("/generate")
def generate(period: str = Body(..., embed=True), user=Depends(current_user)):
    p = str(_period(period))
    with db.connect() as conn:
        data = build(conn, user, p)
        if not (data["electricity"] or data["water"]):
            raise HTTPException(422, f"There is no electricity or water data for {data['label']}.")
        save(conn, user["id"], p, data, "manual", overwrite=True)
        return {**_row(conn, user["id"], p), "data": data}


@router.get("/{period}")
def get_report(period: str, user=Depends(current_user)):
    with db.connect() as conn:
        r = _row(conn, user["id"], str(_period(period)))
    return {**r, "data": db.loads(r["data"], {})}


@router.get("/{period}/pdf")
def get_pdf(period: str, user=Depends(current_user)):
    p = str(_period(period))
    with db.connect() as conn:
        r = _row(conn, user["id"], p)
    d = db.loads(r["data"], {})
    return _download(pdf_bytes(d, user), d, "pdf", "application/pdf")


@router.get("/{period}/csv")
def get_csv(period: str, user=Depends(current_user)):
    p = str(_period(period))
    with db.connect() as conn:
        r = _row(conn, user["id"], p)
    d = db.loads(r["data"], {})
    if "daily" not in d:
        raise HTTPException(409, "This report was made before CSV export existed. Generate it again to download a CSV.")
    return _download(csv_bytes(d), d, "csv", "text/csv; charset=utf-8")
