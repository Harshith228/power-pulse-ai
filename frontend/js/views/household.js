// Unified household dashboard: electricity and water side by side.
import * as charts from "../charts.js";
import { state, api } from "../store.js";
import { icon } from "../icons.js";
import { esc, fmtDay, inr, num } from "../format.js";
import { cardHead, emptyState, fmtUse, limitCard, bindLimitForms, sevTag } from "../components.js";
import { timeAgo, notificationTarget, openNotification } from "../shell.js";
import { addUsageButton, bindAddUsage } from "../elec-manual.js";

const greet = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };

function change(v, inverse = true) {
  if (v == null) return '<span class="chg flat">–</span>';
  const up = v > 0, cls = Math.abs(v) < 2 ? "flat" : (up === inverse ? "bad" : "good");
  return `<span class="chg ${cls}">${icon(up ? "trendUp" : "trendDown")}${v > 0 ? "+" : ""}${num(v, 1)}%</span>`;
}

function utilitySection(u, utility, waterUnit) {
  const label = utility === "water" ? "Water" : "Electricity", ic = utility === "water" ? "droplet" : "zap";
  if (!u.has_data) {
    return `<section class="util-col ${utility}"><div class="util-h"><span class="util-ic ${utility}">${icon(ic)}</span><h2>${label}</h2></div>
      <div class="card">${emptyState(`No ${label.toLowerCase()} data yet`,
        utility === "water" ? "Enter daily readings, upload a CSV, connect a smart meter, or load clearly labelled demo data." : "Enter your daily units by hand, upload a meter CSV or analyse the public UCI dataset.",
        utility === "water" ? `<button class="btn primary" data-goto="settings" data-settings-tab="data" data-data-tab="water">${icon("plus")}Add water data</button>`
          : `<div class="inline" style="justify-content:center">${addUsageButton()}<button class="btn" data-goto="settings" data-settings-tab="data" data-data-tab="electricity">${icon("cloudUpload")}Upload a CSV</button></div>`, ic)}</div></section>`;
  }
  const today = new Date().toISOString().slice(0, 10);
  const isToday = u.latest_day === today;
  const fmt = (v) => fmtUse(v, utility, waterUnit);
  const monthLabel = new Date(u.month + "-01T00:00:00Z").toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return `<section class="util-col ${utility}">
    <div class="util-h"><span class="util-ic ${utility}">${icon(ic)}</span><h2>${label}</h2>
      ${u.dataset ? `<span class="tag" title="Active dataset">${esc(u.dataset.name)}</span>` : ""}<a class="link" data-goto="${utility}/analytics">Details ${icon("arrowRight")}</a></div>
    ${limitCard({ utility, st: u.limit_status, waterUnit, compact: true,
      dayLabel: `${isToday ? "Today" : "Latest day in data"} · ${fmtDay(u.latest_day)}`,
      note: u.latest_hours && u.latest_hours < 24 ? `${u.latest_hours} h recorded` : "" })}
    <div class="grid g2 mt stagger mini-kpis">
      <div class="card kpi"><div class="kpi-top"><span class="label">${isToday ? "Today" : "Latest day"}</span></div><div class="value num">${fmt(u.latest_value)}</div>
        <div class="foot">${change(u.comparisons.latest_vs_30d_avg_pct)} vs 30-day average</div></div>
      <div class="card kpi"><div class="kpi-top"><span class="label">${monthLabel}</span></div><div class="value num">${fmt(u.month_total)}</div>
        <div class="foot">${u.month_days} day${u.month_days === 1 ? "" : "s"} of data · avg ${fmt(u.month_total / Math.max(u.month_days, 1))}/day</div></div>
      <div class="card kpi"><div class="kpi-top"><span class="label">Estimated cost</span></div><div class="value num">${inr(u.month_cost_projected)}</div>
        <div class="foot">projected for ${monthLabel.split(" ")[0]} · ${inr(u.month_cost)} so far</div></div>
      <div class="card kpi ${u.anomalies_30d ? "danger" : ""}"><div class="kpi-top"><span class="label">Anomaly alerts</span></div><div class="value num">${u.anomalies_30d}<small>last 30 days</small></div>
        <div class="foot">${u.violations_30d} day${u.violations_30d === 1 ? "" : "s"} over the limit · ${u.anomalies_total} alerts in total</div></div>
    </div>
    <div class="card mt reveal">${cardHead("Recent anomalies", "", `<a class="link" data-goto="${utility}/anomalies">View all</a>`)}
      ${u.recent_anomalies.length ? `<div class="mini-list">${u.recent_anomalies.map((a) => `<a class="mini-row" data-goto="${utility}/anomalies">
        ${sevTag(a.severity)}<span class="mr-t">${esc(a.title)}</span><span class="subtle">${fmtDay(a.start)}</span></a>`).join("")}</div>`
        : `<p class="subtle">No unusual ${label.toLowerCase()} use detected.</p>`}</div>
  </section>`;
}

export default async function household(el, ctx) {
  if (!el.childElementCount) el.innerHTML = '<div class="card"><div class="skel w40"></div><div class="skel chart-skel"></div></div>';
  const h = await api("/api/household/summary");
  const e = h.electricity, w = h.water, wu = h.units.water_pref;
  const rows = [
    ["Latest day vs 30-day average", e.comparisons?.latest_vs_30d_avg_pct, w.comparisons?.latest_vs_30d_avg_pct],
    ["This month vs last month (avg/day)", e.comparisons?.month_vs_prev_month_avg_pct, w.comparisons?.month_vs_prev_month_avg_pct],
    ["Last 30 days vs previous 30", e.comparisons?.last30_vs_prev30_pct, w.comparisons?.last30_vs_prev30_pct],
  ];
  const n = h.notifications;
  el.innerHTML = `
    <div class="hello reveal"><div><h2>${greet()}, ${esc(state.user.name.split(" ")[0])}</h2>
      <p>Here's your household at a glance: electricity and water, against your own daily limits.</p></div>
      <div class="hello-chips">
        <span class="hchip">${icon("wallet")}<span><b>${inr(h.household.monthly_cost_projected)}</b> projected this month</span></span>
        <span class="hchip ${h.household.anomalies_30d ? "warn" : ""}">${icon("scan")}<span><b>${h.household.anomalies_30d}</b> anomalies in 30 days</span></span>
        <a class="hchip" data-goto="notifications">${icon("bell")}<span><b>${n.unread}</b> unread notification${n.unread === 1 ? "" : "s"}</span></a>
      </div></div>
    <div class="util-grid">${utilitySection(e, "electricity", wu)}${utilitySection(w, "water", wu)}</div>

    <div class="grid g2 mt">
      <div class="card reveal">${cardHead("Electricity trend", "Daily kWh, last 30 days of data · dashed line = your daily limit")}
        ${e.has_data ? '<div class="chart" id="ch-e" role="img" aria-label="Daily electricity use against the limit"></div>' : emptyState("No electricity data", "", "", "zap")}</div>
      <div class="card reveal">${cardHead("Water trend", `Daily ${wu === "kL" ? "kL" : "litres"}, last 30 days of data · dashed line = your daily limit`)}
        ${w.has_data ? '<div class="chart" id="ch-w" role="img" aria-label="Daily water use against the limit"></div>' : emptyState("No water data", "", "", "droplet")}</div>
    </div>

    <div class="grid g-main mt">
      <div class="card reveal">${cardHead("Daily & monthly comparisons", "Change in average daily use · red = using more, green = using less")}
        <div class="table-wrap"><table class="cmp"><thead><tr><th>Comparison</th><th class="n">${icon("zap")} Electricity</th><th class="n">${icon("droplet")} Water</th></tr></thead>
        <tbody>${rows.map(([l, a, b]) => `<tr><td>${l}</td><td class="n">${e.has_data ? change(a) : "–"}</td><td class="n">${w.has_data ? change(b) : "–"}</td></tr>`).join("")}</tbody></table></div>
        <div class="summary-strip">
          <div><span>Electricity this month</span><b>${e.has_data ? fmtUse(e.month_total, "electricity") : "–"}</b></div>
          <div><span>Water this month</span><b>${w.has_data ? fmtUse(w.month_total, "water", wu) : "–"}</b></div>
          <div><span>Projected utility cost</span><b>${inr(h.household.monthly_cost_projected)}</b></div>
          <div><span>Daily limits</span><b>${["electricity", "water"].filter((k) => h.household.limits_set[k]).length}/2 set</b></div>
        </div>
        ${e.has_data && w.has_data && e.month !== w.month ? `<p class="note">Electricity and water data cover different periods (latest ${fmtDay(e.latest_day)} vs ${fmtDay(w.latest_day)}), so each is compared with its own history.</p>` : ""}</div>
      <div class="card reveal">${cardHead("Recent notifications", "", '<a class="link" data-goto="notifications">All</a>')}
        ${n.recent.length ? `<div class="mini-list">${n.recent.map((x) => `<a class="mini-row notif-row ${x.read_at ? "" : "unread"}" data-open-notif="${x.id}" data-target="${notificationTarget(x)}" data-cat="${x.category}">
          <span class="n-ic ${x.category}">${icon({ electricity: "zap", water: "droplet", report: "file" }[x.category] || "bell")}</span>
          <span class="mr-t"><b>${esc(x.title)}</b><small>${timeAgo(x.created_at)}</small></span></a>`).join("")}</div>`
          : emptyState("All quiet", "Limit warnings, unusual consumption and monthly reports will appear here.", "", "bell")}</div>
    </div>`;
  if (e.has_data) charts.utilityDailyChart(el.querySelector("#ch-e"), e.daily, { utility: "electricity", unit: "kWh" });
  if (w.has_data) charts.utilityDailyChart(el.querySelector("#ch-w"), w.daily, { utility: "water", unit: wu, div: wu === "kL" ? 1000 : 1 });
  el.querySelectorAll("[data-open-notif]").forEach((a) => a.addEventListener("click", () => openNotification(+a.dataset.openNotif, a.dataset.target)));
  bindLimitForms(el, () => ctx.refreshSettings().then(() => ctx.rerender()));
  bindAddUsage(el, ctx);
}
