import * as charts from "../charts.js";
import { state, eventsInWindow } from "../store.js";
import { rangeLabel } from "../shell.js";
import { icon } from "../icons.js";
import { esc, fmtDay, inr, num } from "../format.js";
import { alertItem, kpiCard, countSpan, cardHead, emptyState, SEVERITIES, dataSourceLine } from "../components.js";
import { alertSettingsCard, notificationFeed } from "./alert-common.js";

export default async function elecAlerts(el, ctx) {
  const feedHtml = await notificationFeed("electricity");
  const res = state.res, { events, kpis: k, model: m, dataset: d } = res;
  const inWin = eventsInWindow();
  const months = Math.max(d.days / 30.44, 1);
  const feed = events.slice().sort((a, b) => (a.start < b.start ? 1 : -1));
  const high = k.by_severity.critical + k.by_severity.high;
  const circuits = new Map();
  events.forEach((e) => { if (e.circuit) { const n = e.circuit.label.split(" (")[0]; circuits.set(n, (circuits.get(n) || 0) + e.excess_kwh); } });
  const topCircuits = [...circuits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const rules = [
    ["activity", "Sudden spike", m.spike_rule], ["trendUp", "Sustained increase", m.sustained_rule],
    ["refresh", "Repeated pattern", m.repeated_rule], ["cpu", "Isolation Forest", m.isolation_forest],
  ];
  el.innerHTML = `
    ${dataSourceLine("electricity", d)}
    <div class="grid g4 stagger">
      ${kpiCard({ label: "Total alerts", ic: "bellRing", value: countSpan(k.anomalies), foot: `across <b>${num(d.days, 0)} days</b> of data` })}
      ${kpiCard({ label: "Alerts in selected period", ic: "calendar", value: countSpan(inWin.length), foot: `<b>${esc(rangeLabel())}</b> · set in the header` })}
      ${kpiCard({ label: "Average alerts per month", ic: "gauge", value: countSpan(k.anomalies / months, { dec: 1 }), foot: "how often this home trips a rule" })}
      ${kpiCard({ label: "High-priority alerts", ic: "alert", value: countSpan(high), tone: high ? "danger" : "good",
        foot: `<span class="sev-row">${SEVERITIES.map((s) => `<span class="sev ${s}">${k.by_severity[s]} ${s}</span>`).join("")}</span>` })}
    </div>
    <div class="grid g-main mt">
      <div class="card reveal">${cardHead("Alerts per month", "Stacked by severity · up to the last 24 months with alerts")}
        ${events.length ? '<div class="chart" id="ch-am" role="img" aria-label="Alerts per month by severity"></div>' : emptyState("No alerts yet", "Nothing has been flagged for this dataset.", "", "checkCircle")}</div>
      <div class="card reveal">${cardHead("When anomalies peak", "Alerts by clock hour of their peak")}
        ${events.length ? '<div class="chart" id="ch-ah" role="img" aria-label="Alerts by hour of day"></div>' : emptyState("No alerts yet", "Nothing to chart.", "", "clock")}</div>
    </div>
    <div class="grid g-main mt">
      <div class="card reveal">${cardHead("Alert feed", "Newest first · click an alert to investigate", '<span class="live-pill"><span></span>Monitoring active</span>')}
        <div class="alerts">${feed.slice(0, state.feedLimit).map(alertItem).join("") || emptyState("All quiet", "No alerts have been raised for this dataset.", "", "checkCircle")}</div>
        ${feed.length > state.feedLimit ? `<div class="more-row"><button class="btn sm" id="feed-more">Show more (${feed.length - state.feedLimit} left)</button></div>` : ""}</div>
      <div class="stack">
        ${alertSettingsCard("electricity")}
        <div class="card reveal">${cardHead("Monitoring rules", "What PowerPulse watches for", `<span class="tag good">${icon("shield")}Active</span>`)}
          <ul class="rules">${rules.map(([ic, t, r]) => `<li><span class="r-ic">${icon(ic)}</span><div><b>${t}</b><p>${esc(r)}</p></div></li>`).join("")}</ul>
          <p class="note">The first ${m.warmup_days} days are baseline warm-up. You are alerted about ${state.cfg?.settings.anomaly_min_severity || "high"}+ severity anomalies · <a data-goto="settings" data-settings-tab="notifications">change</a> · <a data-goto="settings" data-settings-tab="detection">tune thresholds</a></p></div>
        <div class="card reveal">${cardHead("Top contributing circuits", "Excess energy across all alerts")}
          ${topCircuits.length ? `<div class="peak-list">${topCircuits.map(([n, v]) => `<div class="peak-row"><span class="pk-label">${esc(n)}</span>
            <span class="pk-track"><span style="width:${(100 * v) / topCircuits[0][1]}%"></span></span><b class="num">${num(v, 1)} kWh</b></div>`).join("")}</div>
            <p class="note">≈ ${inr(topCircuits[0][1] * res.cost.marginal_rate)} of extra cost traced to ${esc(topCircuits[0][0])}.</p>`
            : emptyState("No circuit data", "Add circuit_&lt;name&gt;_kwh columns to attribute alerts to appliances.", "", "plug")}</div>
      </div>
    </div>
    <div class="mt">${feedHtml}</div>
    <p class="note">Alert dates come from the dataset (${fmtDay(d.start)} – ${fmtDay(d.end)}). PowerPulse analyses historical exports, so “newest” means the latest readings in the file.</p>`;
  if (events.length) {
    charts.alertsByMonthChart(el.querySelector("#ch-am"), res);
    charts.alertsByHourChart(el.querySelector("#ch-ah"), res);
  }
  el.querySelector("#feed-more")?.addEventListener("click", () => { state.feedLimit += 12; ctx.rerender([ctx.state.view]); });
}
