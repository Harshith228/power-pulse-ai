// Electricity > Consumption Analytics.
import * as charts from "../charts.js";
import { state, rangeWindow } from "../store.js";
import { setRange, rangeLabel } from "../shell.js";
import { icon } from "../icons.js";
import { esc, fmtDay, hourLabel, inr, num, pct, sum } from "../format.js";
import { kpiCard, countSpan, cardHead, dataSourceLine, emptyState } from "../components.js";
import { addUsageButton, bindReadings, readingsCard, usageSection, drawUsageCharts, fetchUsage } from "../elec-manual.js";

/** Plain-language insights computed from the analysis result (no invented numbers). */
export function insights(res) {
  const { profile: p, kpis: k, daily: d, cost: c } = res;
  const day = p.weekday.map((v, i) => (5 * (v ?? 0) + 2 * (p.weekend[i] ?? 0)) / 7);
  const total = sum(day) || 1;
  const peakH = day.indexOf(Math.max(...day));
  const evening = sum(day.slice(18, 23)) / total;
  const baseShare = (k.baseload_w * 24) / 1000 / (k.avg_daily_kwh || 1);
  const weDelta = sum(p.weekend) / (sum(p.weekday) || 1) - 1;
  const out = [];
  const vals = d.kwh.filter((v) => v != null);
  if (vals.length >= 60) {
    const a = sum(vals.slice(-30)) / 30, b = sum(vals.slice(-60, -30)) / 30, ch = a / b - 1;
    out.push({ ic: ch > 0 ? "trendUp" : "trendDown", tone: ch > 0.05 ? "warn" : ch < -0.05 ? "good" : "info",
      title: `Usage ${ch >= 0 ? "up" : "down"} ${pct(Math.abs(ch))} in the last 30 days`, text: `${num(a)} kWh/day vs ${num(b)} kWh/day in the 30 days before.` });
  }
  out.push({ ic: "sunset", tone: "info", title: `Evenings drive ${pct(evening)} of daily energy`,
    text: `18:00–23:00 is the busiest window; the single busiest hour is ${hourLabel(peakH)}.` });
  out.push({ ic: "plug", tone: baseShare > 0.25 ? "warn" : "good", title: `Always-on load is ${pct(baseShare)} of daily use`,
    text: `${k.baseload_w} W runs around the clock${baseShare > 0.25 ? " – standby devices are worth checking" : ", a healthy level"}.` });
  out.push({ ic: "home", tone: "info", title: `Weekends use ${pct(Math.abs(weDelta))} ${weDelta >= 0 ? "more" : "less"} than weekdays`,
    text: `${num(sum(p.weekend))} kWh on a typical weekend day vs ${num(sum(p.weekday))} kWh on a weekday.` });
  if (k.anomalies) out.push({ ic: "alert", tone: k.anomaly_share > 0.03 ? "warn" : "info", title: `Anomalies account for ${pct(k.anomaly_share, 1)} of energy`,
    text: `About ${inr(c.anomaly_inr_month)} a month is spent on consumption above the learned baseline.` });
  return out;
}

function datasetAnalytics(el, ctx) {
  const res = state.res, { kpis: k, dataset: d, cost: c, profile: p } = res;
  const wk = p.weekday, we = p.weekend;
  const day = wk.map((v, i) => (5 * (v ?? 0) + 2 * (we[i] ?? 0)) / 7);
  const peakHour = day.indexOf(Math.max(...day));
  const topHours = day.map((v, h) => [h, v]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topDays = res.daily.t.map((t, i) => [t, res.daily.kwh[i], res.daily.flag[i]]).filter((x) => x[1] != null).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const presets = [[7, "7D"], [30, "30D"], [90, "90D"], [0, "All"]];
  el.innerHTML = `
    ${dataSourceLine("electricity", d)}
    ${d.source === "scenario" ? `<div class="banner violet reveal">${icon("flask")}<div><b>Demo / validation data.</b> ${esc(d.description || "Synthetic data with ground-truth labels")}.</div>
      <a class="btn sm" data-goto="lab">Validation Lab ${icon("arrowRight")}</a></div>` : ""}
    <div class="grid g4 stagger">
      ${kpiCard({ label: "Average daily use", ic: "activity", value: countSpan(k.avg_daily_kwh, { dec: 1 }), unit: "kWh", foot: `Peak <b>${num(k.peak_kwh, 2)} kWh</b> in one hour on ${fmtDay(k.peak_time)}` })}
      ${kpiCard({ label: "Total energy", ic: "zap", value: countSpan(k.total_kwh), unit: "kWh", foot: `over <b>${num(d.days, 0)} days</b> · typical month ${num(c.typical_month_kwh, 0)} kWh` })}
      ${kpiCard({ label: "Typical peak hour", ic: "clock", value: hourLabel(peakHour), foot: `average <b>${num(day[peakHour], 2)} kWh</b> in that hour` })}
      ${kpiCard({ label: "Always-on base load", ic: "plug", value: countSpan(k.baseload_w), unit: "W", foot: `≈ <b>${num(k.baseload_w * 24 * 30.44 / 1000, 0)} kWh</b> a month, even when idle`,
        tip: "5th percentile of hourly use: the power drawn even when nothing is switched on" })}
    </div>
    <div class="card mt reveal">${cardHead("Hourly consumption vs. learned baseline",
      `<b>${rangeLabel()}</b> · <span class="red-text">red</span> = anomalous hours, dots = detected anomalies (click for details). Scroll or drag to zoom.`,
      `<div class="seg" role="group" aria-label="Chart range">${presets.map(([v, l]) => `<button data-v="${v}" class="${state.range === v ? "on" : ""}" aria-pressed="${state.range === v}">${l}</button>`).join("")}</div>`)}
      <div class="chart tall" id="ch-hourly" role="img" aria-label="Hourly consumption against expected baseline"></div></div>
    <div class="grid g3 mt">
      <div class="card reveal">${cardHead("Energy usage insights", "What this home's data says")}
        <ul class="insights">${insights(res).map((x) => `<li class="${x.tone}"><span class="ins-ic">${icon(x.ic)}</span><div><b>${x.title}</b><p>${x.text}</p></div></li>`).join("")}</ul></div>
      <div class="card reveal">${cardHead("Peak consumption periods", "Busiest hours of a typical day and the highest days")}
        <div class="peak-list">${topHours.map(([h, v]) => `<div class="peak-row"><span class="pk-label">${hourLabel(h)}–${hourLabel((h + 1) % 24)}</span>
          <span class="pk-track"><span style="width:${(100 * v) / topHours[0][1]}%"></span></span><b class="num">${num(v, 2)} kWh</b></div>`).join("")}</div>
        <div class="section-title">Highest-use days</div>
        <div class="peak-days">${topDays.map(([t, v, f]) => `<div><span>${fmtDay(t)}</span>${f ? '<span class="tag" style="color:var(--critical)">sustained anomaly</span>' : ""}<b class="num">${num(v, 1)} kWh</b></div>`).join("")}</div></div>
      <div class="card reveal">${cardHead("Consumption summary", esc(d.name))}
        <dl class="summary">
          <div><dt>Total energy</dt><dd class="num">${num(k.total_kwh, 0)} kWh</dd></div><div><dt>Period</dt><dd>${num(d.days, 0)} days</dd></div>
          <div><dt>Average day</dt><dd class="num">${num(k.avg_daily_kwh, 2)} kWh</dd></div><div><dt>Typical month</dt><dd class="num">${num(c.typical_month_kwh, 0)} kWh</dd></div>
          <div><dt>Highest hour</dt><dd class="num">${num(k.peak_kwh, 2)} kWh</dd></div><div><dt>Weekend vs weekday</dt><dd class="num">${pct(sum(we) / sum(wk) - 1)}</dd></div>
          <div><dt>Anomalous energy</dt><dd class="num">${pct(k.anomaly_share, 1)}</dd></div><div><dt>Hourly readings</dt><dd class="num">${num(d.rows_hourly, 0)}</dd></div>
        </dl></div>
    </div>
    <div class="grid g2 mt">
      <div class="card reveal">${cardHead("Average daily profile", "Mean kWh by hour of day, weekday vs weekend")}<div class="chart" id="ch-profile" role="img" aria-label="Average daily load profile"></div></div>
      <div class="card reveal">${cardHead("Weekly heatmap", "Average kWh by weekday and hour")}<div class="scroll-x"><div class="chart" id="ch-heat" role="img" aria-label="Average consumption by weekday and hour"></div></div></div>
    </div>
    <div class="card mt reveal">${cardHead("Daily totals", `<span class="red-text">Red</span> days belong to a sustained anomaly · expected = median of the previous 4 weeks, lagged one week`)}
      <div class="chart" id="ch-daily" role="img" aria-label="Daily energy totals"></div></div>`;
  charts.consumptionChart(el.querySelector("#ch-hourly"), res, { win: rangeWindow(), onPick: ctx.openEvent });
  charts.profileChart(el.querySelector("#ch-profile"), res);
  charts.heatmapChart(el.querySelector("#ch-heat"), res);
  charts.dailyChart(el.querySelector("#ch-daily"), res, { win: rangeWindow() });
  el.querySelectorAll(".seg button[data-v]").forEach((b) => b.addEventListener("click", () => setRange(+b.dataset.v)));
}

/** Consumption Analytics: the active dataset's hourly analysis (when there is one), plus usage from every source -
 *  imported data and manual readings - and the Add Electricity Usage action. */
export default async function elecAnalytics(el, ctx) {
  const [u, readings] = await fetchUsage();
  const actions = `<div class="page-actions">${addUsageButton()}<span class="subtle">Enter a day's units (or one hour's) from your meter or bill${state.res ? "" : " - or upload a CSV"}.</span>
    <a class="link" data-goto="settings" data-settings-tab="data" data-data-tab="electricity">Manage electricity data ${icon("arrowRight")}</a></div>`;
  if (state.res) {
    datasetAnalytics(el, ctx);
    el.insertAdjacentHTML("afterbegin", actions);
    if (readings.total) {
      el.insertAdjacentHTML("beforeend", usageSection(u, { title: "All recorded usage - imported data and manual readings" }) + `<div class="mt">${readingsCard(readings, { compact: true })}</div>`);
      drawUsageCharts(el, u);
    } else {
      el.insertAdjacentHTML("beforeend", `<div class="mt">${readingsCard(readings, { compact: true })}</div>`);
    }
  } else if (u.has_data) {
    el.innerHTML = `${actions}<div class="banner reveal">${icon("info")}<div><b>Built from your manual readings.</b> Hour-by-hour charts and the machine-learning model need hourly data
      (a meter CSV or smart-meter export). Daily totals still drive your limits, costs, monthly reports and daily spike checks.</div></div>
      ${usageSection(u)}<div class="mt">${readingsCard(readings, { compact: true })}</div>`;
    drawUsageCharts(el, u);
  } else {
    el.innerHTML = `<div class="card">${emptyState("No electricity data yet", "Add your daily units by hand, or upload a meter CSV / analyse the public UCI household for full hour-by-hour analysis.",
      `<div class="inline" style="justify-content:center">${addUsageButton()}<button class="btn" data-goto="settings" data-settings-tab="data" data-data-tab="electricity">${icon("cloudUpload")}Upload a CSV</button></div>`, "zap")}</div>`;
  }
  bindReadings(el, ctx, () => ctx.go("settings"));
}
