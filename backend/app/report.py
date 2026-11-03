"""Downloadable anomaly reports: CSV (events) and a self-contained printable HTML page."""
import csv
import io
from html import escape

import pandas as pd

FIELDS = ["id", "type", "severity", "origin", "title", "start", "end", "duration_hours", "peak_time", "peak_kwh",
          "expected_kwh", "excess_kwh", "ratio", "z", "if_pct", "circuit", "recommendation", "explanation"]


def events_csv(result):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=FIELDS, extrasaction="ignore")
    w.writeheader()
    for e in result["events"]:
        row = dict(e)
        row["circuit"] = (e.get("circuit") or {}).get("label", "")
        row["explanation"] = " | ".join(e["factors"])
        w.writerow(row)
    return buf.getvalue()


def _inr(v):
    return f"₹{v:,.0f}"


def events_html(result):
    d, k, c = result["dataset"], result["kpis"], result["cost"]
    sev_color = {"low": "#2563eb", "medium": "#b45309", "high": "#ea580c", "critical": "#dc2626"}
    rows = "".join(
        f"<tr><td>#{e['id']}</td><td><b style='color:{sev_color[e['severity']]}'>{e['severity'].upper()}</b></td>"
        f"<td>{escape(e['type'])}</td><td>{escape(e['title'])}<ul>"
        + "".join(f"<li>{escape(x)}</li>" for x in e["factors"]) +
        f"</ul></td><td>{pd.Timestamp(e['start']):%d %b %Y %H:%M}</td><td>{e['excess_kwh']:.2f}</td>"
        f"<td>{escape(e['origin'])}</td></tr>" for e in result["events"][:200])
    recs = "".join(
        f"<tr><td><b>{escape(r['title'])}</b><br><span class=m>{escape(r['detail'])}</span></td>"
        f"<td>{r['kwh_month']:.1f}</td><td>{_inr(r['inr_month'])}</td></tr>" for r in result["recommendations"])
    months = "".join(
        f"<tr><td>{m['month']}{'' if m['complete'] else ' (partial)'}</td><td>{m['kwh']:.0f}</td>"
        f"<td>{_inr(m['bill'])}</td><td>{m['anomaly_kwh']:.1f}</td><td>{_inr(m['avoidable_inr'])}</td></tr>"
        for m in c["months"][-24:])
    # an empty section says so instead of printing a header-only table
    recs_html = (f"<table><tr><th>Action</th><th>kWh / month</th><th>₹ / month</th></tr>{recs}</table>" if recs
                 else "<p class=m>No specific recommendations: nothing in this data points to avoidable use.</p>")
    rows_html = ("<table><tr><th>#</th><th>Severity</th><th>Type</th><th>What happened &amp; why it was flagged</th><th>Start</th>"
                 f"<th>Excess kWh</th><th>Origin</th></tr>{rows}</table>" if rows
                 else "<p class=m>No anomalies: consumption stayed within this home's learned normal range.</p>")
    months_html = (f"<table><tr><th>Month</th><th>kWh</th><th>Bill</th><th>Anomalous kWh</th><th>Avoidable</th></tr>{months}</table>" if months
                   else "<p class=m>No complete month of data yet.</p>")
    v = result.get("validation")
    val = ""
    if v:
        val = (f"<h2>Validation against injected anomalies</h2><p>Segments detected: "
               f"<b>{v['segment_recall']:.0%}</b> · event precision: <b>{(v['event_precision'] or 0):.0%}</b> · "
               f"injected events {v['injected_events']}, natural events {v['natural_events']}</p>")
    slabs = ", ".join(f"{'above' if s['upto'] is None else 'up to ' + format(s['upto'], 'g')} kWh @ ₹{s['rate']:g}"
                      for s in result["tariff"]["slabs"])
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>PowerPulse report - {escape(d['name'])}</title>
<style>body{{font:14px/1.5 system-ui,'Segoe UI',sans-serif;color:#0b0b0b;max-width:1000px;margin:32px auto;padding:0 16px}}
h1{{margin:0}}h2{{margin-top:32px;border-bottom:1px solid #e1e0d9;padding-bottom:4px}}.m{{color:#52514e}}
table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #e1e0d9;padding:6px 8px;text-align:left;vertical-align:top}}
th{{color:#52514e;font-weight:600}}ul{{margin:4px 0 0 16px;padding:0;color:#52514e}}
.k{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}}.k div{{border:1px solid #e1e0d9;border-radius:10px;padding:12px}}
.k b{{display:block;font-size:20px}}@media print{{button{{display:none}}}}</style></head><body>
<button onclick="print()" style="float:right">Print / save as PDF</button>
<h1><span style="color:#2563eb">Power</span>Pulse · Anomaly report</h1>
<p class=m>{escape(d['name'])} · {pd.Timestamp(d['start']):%d %b %Y} - {pd.Timestamp(d['end']):%d %b %Y}
 ({d['days']} days) · generated {pd.Timestamp.now():%d %b %Y %H:%M}</p>
<div class=k><div>Anomalies<b>{k['anomalies']}</b></div><div>Avg daily use<b>{k['avg_daily_kwh']} kWh</b></div>
<div>Typical monthly bill<b>{_inr(k['typical_month_bill'])}</b></div>
<div>Potential savings<b>{_inr(k['potential_savings_month'])}/mo</b></div></div>
{val}
<h2>Recommendations</h2>{recs_html}
<h2>Anomalies ({len(result['events'])}{', top 200 shown' if len(result['events']) > 200 else ''})</h2>
{rows_html}
<h2>Monthly cost</h2><p class=m>Tariff: {escape(result['tariff']['name'])} - {slabs}; fixed ₹{result['tariff']['fixed_monthly']:g}/month.</p>
{months_html}
</body></html>"""
