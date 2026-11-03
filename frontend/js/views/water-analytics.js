// Water > Water Usage Analytics.
import * as charts from "../charts.js";
import { state, api, post, del } from "../store.js";
import { icon } from "../icons.js";
import { esc, fmtDay, num, pct } from "../format.js";
import { toast } from "../ui.js";
import { cardHead, emptyState, fmtUse, kpiCard, dataSourceLine, countSpan } from "../components.js";
import { importButton, bindImport } from "../water-import.js";

export const waterSummary = () => api("/api/water/summary");

const manageCard = (sub) => `
  <div class="card mt reveal" id="w-manage">${cardHead("Manage water data", sub,
    `<a class="link" data-goto="settings" data-settings-tab="data" data-data-tab="water">All water records ${icon("arrowRight")}</a>`)}
    <div class="manage-grid">
      <div><h4 class="mini-h">Add a daily reading</h4>${entryForm()}</div>
      <div class="manage-csv"><h4 class="mini-h">Import a CSV file</h4>
        <p class="subtle">Columns such as <code>date</code> and <code>water_usage_litres</code> or <code>water_usage_kl</code>. You'll see a preview and every problem row before anything is saved.</p>
        <div class="inline">${importButton("wa-csv")}<a class="btn sm ghost" href="/api/samples/water_daily_sample.csv">${icon("download")}Sample CSV</a></div></div>
    </div></div>`;

export function entryForm(id = "w-entry") {
  const today = new Date().toISOString().slice(0, 10), wu = state.cfg.settings.water.unit;
  return `<form class="entry-form" id="${id}">
    <label class="field"><span>Date</span><input type="date" name="date" max="${today}" value="${today}" required></label>
    <label class="field"><span>Water used</span><input type="number" name="value" min="0" step="any" required placeholder="${wu === "kL" ? "e.g. 0.54" : "e.g. 540"}"></label>
    <label class="field"><span>Unit</span><select name="unit"><option value="L" ${wu === "L" ? "selected" : ""}>Litres</option><option value="kL" ${wu === "kL" ? "selected" : ""}>Kilolitres</option></select></label>
    <label class="field grow"><span>Notes (optional)</span><input type="text" name="notes" maxlength="500" placeholder="e.g. guests staying"></label>
    <button class="btn primary" type="submit">${icon("plus")}Add entry</button></form>`;
}

export function bindEntryForm(root, ctx, id = "w-entry") {
  root.querySelector("#" + id)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button");
    btn.disabled = true;
    try {
      await post("/api/water/readings", { date: f.date.value, value: +f.value.value, unit: f.unit.value, notes: f.notes.value });
      toast("Water reading added", "success");
      ctx.refreshNotifications();
      ctx.rerender([ctx.state.view, "overview"]);
    } catch (err) { toast(err.message, "error"); btn.disabled = false; }
  });
}

function insights(s) {
  const p = s.patterns, out = [];
  if (p.trend_30d?.change != null) {
    const ch = p.trend_30d.change;
    out.push({ ic: ch > 0 ? "trendUp" : "trendDown", tone: ch > 0.05 ? "warn" : ch < -0.05 ? "good" : "info",
      title: `Water use ${ch >= 0 ? "up" : "down"} ${pct(Math.abs(ch))} in the last 30 days`, text: `${num(p.trend_30d.last, 0)} L/day vs ${num(p.trend_30d.prev, 0)} L/day in the 30 days before.` });
  }
  if (p.weekend_vs_weekday != null) {
    const d = p.weekend_vs_weekday;
    out.push({ ic: "home", tone: "info", title: `Weekends use ${pct(Math.abs(d))} ${d >= 0 ? "more" : "less"} than weekdays`, text: "Laundry, cleaning and guests usually show up at weekends." });
  }
  if (p.night_share != null) {
    out.push({ ic: "moon", tone: p.night_share > 0.05 ? "warn" : "good", title: `${pct(p.night_share, 1)} of water is used between 00:00 and 05:00`,
      text: p.night_share > 0.05 ? "That's high for sleeping hours - a running cistern or tank overflow is worth checking." : "Night-time use is low, as expected while the household sleeps." });
  }
  const wd = p.weekday_avg, names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const vals = wd.filter((v) => v != null);
  if (vals.length) {
    const hi = wd.indexOf(Math.max(...vals));
    out.push({ ic: "calendar", tone: "info", title: `${names[hi]} is the heaviest day`, text: `${num(wd[hi], 0)} L on an average ${names[hi]}.` });
  }
  return out;
}

export default async function waterAnalytics(el, ctx) {
  const [s, recs] = await Promise.all([waterSummary(), api("/api/water/readings?limit=1")]);
  const wu = s.unit_pref, fmt = (v) => fmtUse(v, "water", wu), div = wu === "kL" ? 1000 : 1;
  const kpi = (v) => countSpan(v / div, { dec: wu === "kL" ? 2 : 0, suffix: ` ${wu}` });  // counts up like the electricity KPIs
  const demo = recs.by_source?.demo;
  if (!s.has_data) {
    el.innerHTML = `${dataSourceLine("water", null)}<div class="card">${emptyState("Start tracking water", "Add a daily reading below, upload a CSV, connect a smart meter, or try PowerPulse with clearly labelled demo data.",
      `<div class="inline" style="justify-content:center"><button class="btn primary" id="w-demo">${icon("sparkles")}Load demo water data</button>
       </div>`, "droplet")}</div>
      ${manageCard("Litres or kilolitres - stored internally in litres.")}`;
  } else {
    const month = new Date(s.month + "-01T00:00:00Z").toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    el.innerHTML = `
      ${dataSourceLine("water", s)}
      ${demo ? `<div class="banner amber reveal">${icon("info")}<div><b>Demo data.</b> ${num(demo, 0)} hourly readings are synthetic demo data with three planted events, labelled as demo everywhere.</div>
        <button class="btn sm" id="w-clear-demo">${icon("trash")}Clear demo data</button></div>` : ""}
      <div class="grid g4 stagger">
        ${kpiCard({ label: s.latest_is_today ? "Today's usage" : "Latest day", ic: "droplet", value: kpi(s.latest_litres),
          foot: `${fmtDay(s.latest_day)}${s.latest_hours && s.latest_hours < 24 ? ` · ${s.latest_hours} h recorded so far` : ""}` })}
        ${kpiCard({ label: "Average per day", ic: "activity", value: kpi(s.avg_daily), foot: "last 30 days of data" })}
        ${kpiCard({ label: "This week", ic: "calendar", value: kpi(s.week_litres), foot: "last 7 days of data" })}
        ${kpiCard({ label: month, ic: "bars", value: kpi(s.month_litres), foot: `${s.month_days} days · ${fmt(s.total_litres)} recorded in total` })}
      </div>
      <div class="card mt reveal">${cardHead("Daily water use", `Last 90 days of data · highest day ${fmt(s.highest_day.litres)} on ${fmtDay(s.highest_day.day)}`)}
        <div class="chart tall" id="ch-wd" role="img" aria-label="Daily water use"></div></div>
      <div class="grid g3 mt">
        <div class="card reveal">${cardHead("Water usage insights", "What this home's water data says")}
          <ul class="insights">${insights(s).map((x) => `<li class="${x.tone}"><span class="ins-ic">${icon(x.ic)}</span><div><b>${x.title}</b><p>${x.text}</p></div></li>`).join("")}</ul></div>
        <div class="card reveal">${cardHead("Average by weekday", "Litres on an average day · orange = weekend")}<div class="chart" id="ch-wwd" role="img" aria-label="Average water use by weekday"></div></div>
        <div class="card reveal">${cardHead("Monthly totals", "Litres per calendar month")}<div class="chart" id="ch-wm" role="img" aria-label="Monthly water totals"></div></div>
      </div>
      <div class="grid g2 mt">
        <div class="card reveal">${cardHead("When water is used", s.has_hourly ? "Average litres by hour of day, last 30 days" : "Needs hourly readings")}
          ${s.has_hourly ? '<div class="chart" id="ch-wp" role="img" aria-label="Average water use by hour"></div>'
            : emptyState("No hourly data", "Daily totals can't show the time of day. Connect a smart meter or upload hourly readings for time-of-day patterns and overnight / continuous-flow checks.", "", "clock")}</div>
        <div class="card reveal">${cardHead("Weekly heatmap", s.has_hourly ? "Average litres by weekday and hour, last 60 days" : "Needs hourly readings")}
          ${s.has_hourly ? '<div class="scroll-x"><div class="chart" id="ch-wh" role="img" aria-label="Water use by weekday and hour"></div></div>' : emptyState("No hourly data", "", "", "calendar")}</div>
      </div>
      <div class="card mt flush reveal"><div class="pad">${cardHead("Weekly totals", "Last 12 weeks (weeks end on Sunday)")}</div>
        <div class="table-wrap"><table class="mini"><thead><tr><th>Week ending</th><th class="n">Total</th><th class="n">Per day</th></tr></thead><tbody>
          ${s.weekly.slice().reverse().map((w) => `<tr><td>${fmtDay(w.week_end)}</td><td class="n num">${fmt(w.litres)}</td><td class="n num">${fmt(w.litres / 7)}</td></tr>`).join("")}</tbody></table></div></div>
      ${manageCard("Manual entries are daily totals; CSV files can be daily or hourly. Edit or delete records under All water records.")}`;
    charts.utilityDailyChart(el.querySelector("#ch-wd"), { t: s.daily.t, v: s.daily.litres, limit: s.daily.limit }, { utility: "water", unit: wu, div });
    charts.weekdayChart(el.querySelector("#ch-wwd"), s.patterns.weekday_avg.map((v) => (v == null ? null : v / div)), { unit: wu, dec: wu === "kL" ? 2 : 0 });
    charts.monthlyTotalsChart(el.querySelector("#ch-wm"), s.monthly.map((m) => ({ month: m.month, value: m.litres / div })), { unit: wu, dec: wu === "kL" ? 2 : 0 });
    if (s.has_hourly) {
      charts.waterProfileChart(el.querySelector("#ch-wp"), s.hourly_profile);
      charts.heatmapChart(el.querySelector("#ch-wh"), null, { heatmap: s.patterns.heatmap, unit: "L" });
    }
  }
  bindEntryForm(el, ctx);
  bindImport(el, () => { ctx.refreshNotifications(); ctx.rerender([ctx.state.view, "overview"]); });
  el.querySelector("#w-demo")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try { await post("/api/water/demo"); toast("Demo water data loaded (clearly labelled as demo)", "success"); ctx.refreshNotifications(); ctx.rerender([ctx.state.view, "overview"]); }
    catch (err) { toast(err.message, "error"); e.target.disabled = false; }
  });
  el.querySelector("#w-clear-demo")?.addEventListener("click", async () => {
    try { const r = await del("/api/water/readings?source=demo"); toast(`Removed ${num(r.deleted, 0)} demo readings`, "success"); ctx.rerender([ctx.state.view, "overview"]); }
    catch (err) { toast(err.message, "error"); }
  });
}
export { esc };
