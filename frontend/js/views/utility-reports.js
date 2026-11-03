// Electricity Reports / Water Reports: monthly breakdown, downloads and that utility's monthly reports.
import * as charts from "../charts.js";
import { state, api } from "../store.js";
import { icon } from "../icons.js";
import { fmtDay, inr, num } from "../format.js";
import { cardHead, emptyState, dataSourceLine } from "../components.js";
import { waterSummary } from "./water-analytics.js";

const label = (p) => new Date(p + "-01T00:00:00Z").toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

export const utilityReports = (utility) => async function reports(el, ctx) {
  const isW = utility === "water";
  const [list, s] = await Promise.all([api("/api/reports"), isW ? waterSummary() : Promise.resolve(null)]);
  const res = state.res;
  const has = isW ? s.has_data : !!res;
  if (!has) {
    el.innerHTML = `${dataSourceLine(utility, null)}<div class="card">${emptyState(`No ${utility} data yet`, `Add ${utility} data to see monthly reports.`,
      `<button class="btn primary" data-goto="settings" data-settings-tab="data" data-data-tab="${utility}">${icon("plus")}Add ${utility} data</button>`, isW ? "droplet" : "zap")}</div>`;
    return;
  }
  // one row per month: usage, bill, anomaly part, limit violations
  const months = isW
    ? s.monthly_costs.map((m) => ({ month: m.month, usage: m.kl, unit: "kL", bill: m.bill, avoid: m.avoidable_inr, anomaly: m.anomaly_litres / 1000, days: m.days, complete: m.complete, viol: m.violations }))
    : res.cost.months.map((m) => ({ month: m.month, usage: m.kwh, unit: "kWh", bill: m.bill, avoid: m.avoidable_inr, anomaly: m.anomaly_kwh, complete: m.complete, viol: null }));
  const rows = months.slice(-24).reverse();
  const key = isW ? "water_kl" : "electricity_kwh";
  const reps = list.reports.filter((r) => r[key] != null);
  const downloads = isW
    ? `<a class="btn" href="/api/water/export.csv">${icon("table")}All water readings (CSV)</a>`
    : `<a class="btn" href="/api/datasets/${res.dataset.id}/report.html" target="_blank" rel="noopener">${icon("file")}Anomaly report (HTML / PDF)</a>
       <a class="btn" href="/api/datasets/${res.dataset.id}/report.csv">${icon("table")}Anomalies (CSV)</a>
       <a class="btn" href="/api/datasets/${res.dataset.id}/data.csv">${icon("database")}Cleaned hourly data (CSV)</a>`;
  el.innerHTML = `
    ${dataSourceLine(utility, isW ? s : res.dataset)}
    <div class="grid g-main">
      <div class="card reveal">${cardHead(`Monthly ${utility} consumption`, isW ? "Kilolitres per month" : "kWh per month")}
        <div class="chart" id="ch-ur" role="img" aria-label="Monthly ${utility} consumption"></div></div>
      <div class="card reveal">${cardHead("Downloads", "Your own data, ready to share or re-upload")}
        <div class="dl-list">${downloads}</div>
        <p class="note">Full monthly reports (electricity + water, PDF) are on <a data-goto="reports">Monthly Reports</a>.</p></div>
    </div>
    <div class="card mt flush reveal"><div class="pad">${cardHead(`Month by month`, `Estimated bills use your ${utility} tariff · partial months cover recorded days only`)}</div>
      <div class="table-wrap"><table class="rep-table"><thead><tr><th>Month</th><th class="n">${isW ? "Water" : "Energy"}</th><th class="n">Estimated bill</th>
        <th class="n">Unusual ${isW ? "water" : "energy"}</th><th class="n">Avoidable</th>${isW ? '<th class="n">Days over limit</th>' : ""}</tr></thead><tbody>
        ${rows.map((m) => `<tr><td data-l="Month"><b>${label(m.month)}</b>${m.complete ? "" : ' <span class="tag">partial</span>'}</td>
          <td class="n num" data-l="Usage">${num(m.usage, isW ? 2 : 0)} ${m.unit}</td><td class="n num" data-l="Bill">${inr(m.bill)}</td>
          <td class="n num" data-l="Unusual">${num(m.anomaly, isW ? 2 : 1)} ${m.unit}</td><td class="n num" data-l="Avoidable">${inr(m.avoid)}</td>
          ${isW ? `<td class="n num" data-l="Over limit">${m.viol}</td>` : ""}</tr>`).join("")}</tbody></table></div></div>
    <div class="card mt flush reveal"><div class="pad">${cardHead(`Generated monthly reports with ${utility}`, `${reps.length} report${reps.length === 1 ? "" : "s"}`, '<a class="link" data-goto="reports">Generate</a>')}</div>
      ${reps.length ? `<div class="table-wrap"><table class="rep-table"><thead><tr><th>Month</th><th class="n">${isW ? "Water" : "Electricity"}</th><th>Generated</th><th></th></tr></thead><tbody>
        ${reps.map((r) => `<tr><td data-l="Month"><b>${label(r.period)}</b></td><td class="n num" data-l="Usage">${isW ? `${num(r.water_kl, 2)} kL` : `${num(r.electricity_kwh, 0)} kWh`}</td>
          <td class="subtle" data-l="Generated">${fmtDay(r.generated_at)} · ${r.trigger}</td>
          <td class="row-actions"><a class="btn sm" href="/api/reports/${r.period}/pdf">${icon("download")}PDF</a>
            <button class="btn sm" data-open-r="${r.period}">${icon("eye")}View</button></td></tr>`).join("")}</tbody></table></div>`
        : `<div class="pad">${emptyState("No monthly reports yet", "Generate one on the Monthly Reports page, or wait for the automatic one.", '<button class="btn" data-goto="reports">Monthly Reports</button>', "file")}</div>`}</div>`;
  charts.monthlyTotalsChart(el.querySelector("#ch-ur"), months.slice(-24).map((m) => ({ month: m.month, value: m.usage })),
    { unit: isW ? "kL" : "kWh", color: isW ? charts.C.water : charts.C.s1, dec: isW ? 2 : 0 });
  el.querySelectorAll("[data-open-r]").forEach((b) => b.addEventListener("click", () => { state.reportOpen = b.dataset.openR; ctx.go("reports"); }));
};
