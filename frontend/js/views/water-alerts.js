// Water > Alerts: event history, timing, feed, rules and alert preferences (water equivalent of Electricity > Alerts).
import * as charts from "../charts.js";
import { state } from "../store.js";
import { icon } from "../icons.js";
import { esc, fmtDay, num } from "../format.js";
import { kpiCard, countSpan, cardHead, emptyState, sevTag, dataSourceLine, SEVERITIES } from "../components.js";
import { waterSummary } from "./water-analytics.js";
import { WATER_TYPE } from "./water-anomalies.js";
import { alertSettingsCard, notificationFeed } from "./alert-common.js";

export default async function waterAlerts(el, ctx) {
  const [s, feedHtml] = await Promise.all([waterSummary(), notificationFeed("water")]);
  if (!s.has_data) {
    el.innerHTML = `${dataSourceLine("water", null)}<div class="grid g-main"><div class="card">${emptyState("No water data yet", "Water alerts start once readings arrive.",
      '<button class="btn primary" data-goto="water/analytics">Go to Water Usage</button>', "droplet")}</div>${alertSettingsCard("water")}</div>`;
    return;
  }
  const ev = s.anomalies, since = (d) => new Date(Date.parse(s.latest_day) - d * 864e5).toISOString().slice(0, 10);
  const recent = ev.filter((e) => e.start >= since(30));
  const months = Math.max(s.days / 30.44, 1), high = ev.filter((e) => e.severity === "critical" || e.severity === "high").length;
  const feed = ev.slice().sort((a, b) => (a.start < b.start ? 1 : -1));
  const lim = state.feedLimitW || 10;
  el.innerHTML = `
    ${dataSourceLine("water", s)}
    <div class="grid g4 stagger">
      ${kpiCard({ label: "Total water alerts", ic: "bellRing", value: countSpan(ev.length), foot: `across <b>${s.days} days</b> of readings` })}
      ${kpiCard({ label: "Last 30 days", ic: "calendar", value: countSpan(recent.length), foot: `${s.violations_30d.length} day${s.violations_30d.length === 1 ? "" : "s"} over the daily limit` })}
      ${kpiCard({ label: "Average alerts per month", ic: "gauge", value: countSpan(ev.length / months, { dec: 1 }), foot: "how often this home trips a water rule" })}
      ${kpiCard({ label: "High-priority alerts", ic: "alert", value: countSpan(high), tone: high ? "danger" : "good",
        foot: `<span class="sev-row">${SEVERITIES.map((x) => `<span class="sev ${x}">${ev.filter((e) => e.severity === x).length} ${x}</span>`).join("")}</span>` })}
    </div>
    <div class="grid g-main mt">
      <div class="card reveal">${cardHead("Water alerts per month", "Stacked by severity")}
        ${ev.length ? '<div class="chart" id="ch-wam" role="img" aria-label="Water alerts per month by severity"></div>' : emptyState("No alerts yet", "Nothing unusual has been detected.", "", "checkCircle")}</div>
      <div class="card reveal">${cardHead("When water alerts start", "Events by weekday")}
        ${ev.length ? '<div class="chart" id="ch-wawd" role="img" aria-label="Water alerts by weekday"></div>' : emptyState("No alerts yet", "", "", "calendar")}</div>
    </div>
    <div class="grid g-main mt">
      <div class="card reveal">${cardHead("Water alert feed", "Newest first · click to see explanations and checks", '<span class="live-pill"><span></span>Monitoring active</span>')}
        ${feed.length ? `<div class="alerts">${feed.slice(0, lim).map((a) => `<a class="alert ${a.severity}" data-goto="water/anomalies" tabindex="0">
          <div class="bar"></div><div class="alert-body"><h4>${esc(a.title)}</h4><p>${a.start === a.end ? fmtDay(a.start) : `${fmtDay(a.start)} – ${fmtDay(a.end)}`}</p>
          <div class="meta">${sevTag(a.severity)}<span class="tag">${WATER_TYPE[a.type]}</span></div></div>
          <div class="right"><b class="num">${a.deviation_pct == null ? "" : `${a.deviation_pct > 0 ? "+" : ""}${num(a.deviation_pct, 0)}%`}</b><span>vs expected</span></div></a>`).join("")}</div>
          ${feed.length > lim ? `<div class="more-row"><button class="btn sm" id="feed-more">Show more (${feed.length - lim} left)</button></div>` : ""}`
          : emptyState("All quiet", "No water alerts have been raised.", "", "checkCircle")}</div>
      <div class="stack">
        ${alertSettingsCard("water")}
        <div class="card reveal">${cardHead("Monitoring rules", "What PowerPulse watches for", `<span class="tag good">${icon("shield")}Active</span>`)}
          <ul class="rules">${[["activity", "Sudden spike", s.rules.spike], ["trendUp", "Sustained increase", s.rules.sustained], ["refresh", "Repeated pattern", s.rules.repeated],
            ["moon", "High overnight use", s.rules.overnight], ["droplet", "Continuous flow", s.rules.continuous]]
            .map(([ic, t, r]) => `<li><span class="r-ic">${icon(ic)}</span><div><b>${t}</b><p>${esc(r)}</p></div></li>`).join("")}</ul></div>
        ${feedHtml}
      </div>
    </div>`;
  if (ev.length) {
    charts.alertsByMonthChart(el.querySelector("#ch-wam"), ev);
    charts.eventsByWeekdayChart(el.querySelector("#ch-wawd"), ev);
  }
  el.querySelector("#feed-more")?.addEventListener("click", () => { state.feedLimitW = lim + 10; ctx.rerender([ctx.state.view]); });
}
