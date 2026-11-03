// Monthly Reports: a compact configuration bar, the generated report at full width below it, and every earlier
// report. Generate only builds and shows a report; PDF and CSV are separate download buttons. Previews, PDFs and
// CSVs all come from the report's stored figures, so what you download is what you see.
import * as charts from "../charts.js";
import { state, api, post, del } from "../store.js";
import { icon } from "../icons.js";
import { esc, fmtDay, inr, num } from "../format.js";
import { toast } from "../ui.js";
import { cardHead, emptyState, sevTag } from "../components.js";

const monthLabel = (p) => new Date(p + "-01T00:00:00Z").toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const KIND = { combined: "Combined (electricity + water)", electricity: "Electricity", water: "Water" };
const today = () => new Date().toISOString().slice(0, 10);
const monthBounds = (p) => {
  const [y, m] = p.split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return [`${p}-01`, end > today() ? today() : end];
};
const kindOf = (d) => d.kind || (d.electricity && d.water ? "combined" : d.electricity ? "electricity" : "water");

const stat = (k, v, foot = "") => `<div class="fact"><span>${k}</span><b class="num">${v}</b>${foot ? `<small>${foot}</small>` : ""}</div>`;

function electricitySection(d, e) {
  const rows = (d.daily || []).filter((r) => r.kwh != null), hasExp = rows.some((r) => r.kwh_expected != null);
  return `<section class="rep-sec rep-util elec"><h3>${icon("zap")} Electricity <span class="subtle">${esc(e.dataset)} · ${e.days_with_data} of ${d.days_in_month} days with data</span></h3>
    <div class="facts rep-facts">${stat("Total", `${num(e.total_kwh, 1)} kWh`)}${stat("Average per day", `${num(e.avg_daily_kwh, 2)} kWh`)}
      ${stat("Highest day", `${num(e.highest_day.value, 1)} kWh`, fmtDay(e.highest_day.day))}${stat("Anomalies", e.anomalies)}
      ${stat("Estimated bill", inr(e.estimated_bill_inr))}${stat("Limit violations", e.limit ? `${e.limit_violations} day${e.limit_violations === 1 ? "" : "s"}` : "No limit set")}
      ${stat("Anomaly cost", inr(e.anomaly_cost_inr), "extra energy in anomalies")}${stat("Savings potential", `${inr(e.potential_savings_month_inr)}/mo`)}</div>
    <div class="rep-charts ${rows.length >= 28 ? "two" : ""}">
      <div><h4>Daily consumption vs limit${hasExp ? " and expected" : ""}</h4><div class="chart" data-rep-chart="electricity" role="img" aria-label="Daily electricity in this report against the limit"></div></div>
      ${rows.length >= 28 ? '<div><h4>Weekly totals</h4><div class="chart" data-rep-weekly="electricity" role="img" aria-label="Weekly electricity totals in this report"></div></div>' : ""}</div>
    ${e.top_anomalies.length ? `<h4>Anomalies in this period</h4><ul class="rep-list">${e.top_anomalies.map((a) => `<li>${sevTag(a.severity)}<span>${esc(a.title)}</span>
      <span class="subtle">${fmtDay(a.start)} · +${num(a.excess_kwh, 1)} kWh</span></li>`).join("")}</ul>` : ""}
    ${e.violation_days?.length ? `<p class="subtle rep-viol">Over the limit on ${e.violation_days.slice(0, 10).map((v) => `${fmtDay(v.day)} (+${num(v.excess, 1)} kWh)`).join(", ")}${e.violation_days.length > 10 ? "…" : ""}.</p>` : ""}
  </section>`;
}

function waterSection(d, w) {
  const rows = (d.daily || []).filter((r) => r.litres != null);
  return `<section class="rep-sec rep-util water"><h3>${icon("droplet")} Water <span class="subtle">${w.days_with_data} of ${d.days_in_month} days with data</span></h3>
    <div class="facts rep-facts">${stat("Total", `${num(w.total_kl, 2)} kL`, `${num(w.total_litres, 0)} L`)}${stat("Average per day", `${num(w.avg_daily_litres, 0)} L`)}
      ${stat("Highest day", `${num(w.highest_day.value, 0)} L`, fmtDay(w.highest_day.day))}${stat("Unusual events", w.anomalies)}
      ${stat("Estimated bill", inr(w.estimated_bill_inr))}${stat("Limit violations", w.limit ? `${w.limit_violations} day${w.limit_violations === 1 ? "" : "s"}` : "No limit set")}
      ${stat("Excess water", `${num(w.excess_litres, 0)} L`, "above normal in unusual events")}${stat("Excess cost", inr(w.excess_cost_inr))}</div>
    <div class="rep-charts ${rows.length >= 28 ? "two" : ""}">
      <div><h4>Daily consumption vs limit</h4><div class="chart" data-rep-chart="water" role="img" aria-label="Daily water in this report against the limit"></div></div>
      ${rows.length >= 28 ? '<div><h4>Weekly totals</h4><div class="chart" data-rep-weekly="water" role="img" aria-label="Weekly water totals in this report"></div></div>' : ""}</div>
    ${w.top_anomalies?.length ? `<h4>Unusual water use in this period</h4><ul class="rep-list">${w.top_anomalies.map((a) => `<li>${sevTag(a.severity)}<span>${esc(a.title)}</span>
      <span class="subtle">${fmtDay(a.start)}${a.deviation_pct != null ? ` · ${a.deviation_pct > 0 ? "+" : ""}${num(a.deviation_pct, 0)}%` : ""}</span></li>`).join("")}</ul>` : ""}
    ${w.checks.length ? `<h4>Suggested checks</h4><ul class="checks-list">${w.checks.map((c) => `<li>${icon("checkCircle")}<span>${esc(c)}</span></li>`).join("")}</ul>` : ""}
  </section>`;
}

function reportBody(d) {
  const e = d.electricity, w = d.water, inc = d.included || { electricity: true, water: true };
  const none = (ic, name) => `<section class="rep-sec rep-util"><h3>${icon(ic)} ${name}</h3><p class="subtle">No ${name.toLowerCase()} readings were recorded for ${esc(d.label)}.</p></section>`;
  const recs = d.recommendations || [];
  return `${e ? electricitySection(d, e) : inc.electricity && w ? none("zap", "Electricity") : ""}
    ${w ? waterSection(d, w) : inc.water && e ? none("droplet", "Water") : ""}
    <section class="rep-sec"><h3>${icon("piggy")} Savings & recommendations</h3>
      ${d.savings_month_inr ? `<p class="good-text rep-save">About <b>${inr(d.savings_month_inr)}</b> a month could be saved.</p>` : ""}
      ${recs.length ? `<ul class="rep-recs">${recs.map((r) => `<li><b>${esc(r.title)}</b>${r.inr_month ? `<span class="tag good">${inr(r.inr_month)}/month</span>` : ""}
        ${r.detail ? `<p>${esc(r.detail)}</p>` : ""}</li>`).join("")}</ul>`
        : '<p class="subtle">No specific savings recommendations for this period: nothing in these readings points to avoidable use.</p>'}</section>`;
}

/** Charts from the report's own stored daily figures (the same numbers the PDF and CSV contain). */
function drawReportCharts(root, d) {
  const rows = d.daily || [];
  root.querySelectorAll("[data-rep-chart]").forEach((el) => {
    const water = el.dataset.repChart === "water", have = rows.filter((r) => (water ? r.litres : r.kwh) != null);
    charts.utilityDailyChart(el, { t: have.map((r) => r.day), v: have.map((r) => (water ? r.litres : r.kwh)), limit: have.map((r) => (water ? r.litres_limit : r.kwh_limit)),
      expected: water ? null : have.map((r) => r.kwh_expected ?? null) }, { utility: water ? "water" : "electricity", unit: water ? "L" : "kWh" });
  });
  root.querySelectorAll("[data-rep-weekly]").forEach((el) => {
    const water = el.dataset.repWeekly === "water", weeks = new Map();
    rows.forEach((r) => {
      const v = water ? r.litres : r.kwh;
      if (v == null) return;
      const dt = new Date(r.day + "T00:00:00Z"), monday = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
      weeks.set(monday, (weeks.get(monday) || 0) + v);
    });
    charts.weeklyTotalsChart(el, [...weeks].map(([wk, v]) => ({ week: wk, value: water ? v : +v.toFixed(1) })), { unit: water ? "L" : "kWh" });
  });
}

/** Every report, newest first: on-request ones (any range) and the automatic monthly ones. */
function allReports(o) {
  return [
    ...o.custom.map((r) => ({ src: "custom", key: String(r.id), name: r.label, kind: r.kind, start: r.start, end: r.end, generated: r.generated_at, origin: "On request", csv: true })),
    ...o.reports.map((r) => ({ src: "monthly", key: r.period, name: monthLabel(r.period), kind: r.kind, start: r.start, end: r.end, generated: r.generated_at,
      origin: r.trigger === "scheduled" ? "Automatic" : "Monthly", csv: r.has_csv, status: r.status })),
  ].sort((a, b) => (a.generated < b.generated ? 1 : -1));
}
const urlOf = (r, fmt) => (r.src === "custom" ? `/api/reports/custom/${r.key}/${fmt}` : `/api/reports/${r.key}/${fmt}`);

/** Download a file without leaving the page: fetch it, then save it under the server's filename. */
async function download(btn, url) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add("loading");
  try {
    const r = await fetch(url, { credentials: "same-origin" });
    if (r.status === 401) { location.replace("/login?next=" + encodeURIComponent(location.pathname + location.hash)); return; }
    if (!r.ok) {
      let msg = `Download failed (HTTP ${r.status}).`;
      try { msg = (await r.json()).detail || msg; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    const blob = await r.blob();
    if (!blob.size) throw new Error("The server returned an empty file.");
    const name = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "")?.[1] || url.split("/").pop();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`Downloaded ${name}`, "success");
  } catch (err) {
    toast(err.message === "Failed to fetch" ? "Download failed: can't reach the PowerPulse server." : err.message, "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.innerHTML = label;
  }
}

export default async function reports(el, ctx) {
  const o = await api("/api/reports");
  const s = o.settings, list = allReports(o);
  const cfg = state.repCfg || (state.repCfg = { kind: "combined", period: o.periods_available[0] || "custom", start: "", end: "", format: "pdf" });
  if (cfg.period !== "custom" && o.periods_available.includes(cfg.period)) [cfg.start, cfg.end] = monthBounds(cfg.period);
  const seg = (name, opts, cur) => `<div class="seg full" role="radiogroup" aria-label="${name}">${opts.map(([v, l]) =>
    `<button type="button" data-${name}="${v}" class="${cur === v ? "on" : ""}" role="radio" aria-checked="${cur === v}">${l}</button>`).join("")}</div>`;
  const noData = !o.periods_available.length;
  el.innerHTML = `
    <div class="card reveal rep-config" id="rep-config">
      ${noData ? `${cardHead("Generate a report")}${emptyState("No data yet", "Add electricity or water data first - reports are built only from real readings.",
        `<button class="btn primary" data-goto="electricity/analytics">${icon("plus")}Add data</button>`, "file")}` : `
      <form id="gen" class="rep-form" novalidate>
        <div class="rep-row">
          <div class="field"><span>Report type</span>${seg("kind", [["combined", "Combined"], ["electricity", "Electricity"], ["water", "Water"]], cfg.kind)}</div>
          <label class="field"><span>Reporting period</span><select name="period">
            ${o.periods_available.map((p) => `<option value="${p}" ${cfg.period === p ? "selected" : ""}>${monthLabel(p)}</option>`).join("")}
            <option value="custom" ${cfg.period === "custom" ? "selected" : ""}>Custom range…</option></select></label>
          <label class="field"><span>Start date</span><input type="date" name="start" value="${cfg.start}" max="${today()}" required></label>
          <label class="field"><span>End date</span><input type="date" name="end" value="${cfg.end}" max="${today()}" required></label>
        </div>
        <div class="rep-row two">
          <div class="field"><span>Download format</span>${seg("format", [["pdf", "PDF"], ["csv", "CSV (daily figures)"]], cfg.format)}</div>
          <button class="btn primary" type="submit" id="gen-btn">${icon("fileCheck")}Generate report</button>
          <p class="rep-auto">${icon("calendar")}<span>Automatic monthly reports <b>${s.enabled ? `on · day ${s.day}` : "off"}</b>${o.next_scheduled ? ` · next ${fmtDay(o.next_scheduled.date)}` : ""}</span>
            <a class="link" data-goto="settings" data-settings-tab="reports">Settings</a></p>
        </div>
        <div class="alert-box error" id="gen-err" role="alert" hidden></div>
      </form>`}
    </div>
    <div class="card mt reveal" id="rep-preview" aria-live="polite"></div>
    <div class="card mt flush reveal"><div class="pad">${cardHead("Recent reports", `${list.length} report${list.length === 1 ? "" : "s"}`)}</div>
      ${list.length ? `<div class="table-wrap"><table class="rep-table"><thead><tr><th>Report</th><th>Type</th><th>Period</th><th>Generated</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.map((r) => `<tr class="${state.reportPreview?.src === r.src && state.reportPreview?.key === r.key ? "sel" : ""}">
          <td data-l="Report"><b>${esc(r.name)}</b></td><td data-l="Type">${KIND[r.kind] || "–"}</td>
          <td data-l="Period" class="subtle">${fmtDay(r.start)} – ${fmtDay(r.end)}</td>
          <td data-l="Generated" class="subtle">${fmtDay(r.generated)} · ${r.origin}</td>
          <td data-l="Status">${r.status === "no_data" ? '<span class="tag">No data</span>' : '<span class="tag good">Ready</span>'}</td>
          <td class="row-actions"><button class="btn sm" data-view="${r.src}:${r.key}">${icon("eye")}View</button>
            ${r.src === "custom" ? `<button class="icon-btn sm" data-del-rep="${r.key}" aria-label="Delete report ${esc(r.name)}">${icon("trash")}</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="pad">${emptyState("No reports yet", "Generate one above, or wait for the automatic monthly report.", "", "file")}</div>`}</div>`;

  const box = el.querySelector("#rep-preview");
  let shown = null;  // the report on screen: { r: list entry, data }
  const showEmpty = (title = "No report on screen", text = "Choose a type and period above, then Generate report - or open one from Recent reports.", ic = "file") => {
    shown = null;
    box.innerHTML = emptyState(title, text, "", ic);
  };
  const dlBtn = (fmt, primary) => `<button type="button" class="btn ${primary ? "primary" : ""}" data-dl="${fmt}">${icon("download")}${fmt.toUpperCase()}</button>`;
  const show = (r, data) => {
    shown = { r, data };
    const kind = kindOf(data);
    box.innerHTML = `<header class="rep-head"><div><span class="eyebrow-sm">${KIND[kind]} report</span><h2>${esc(data.label)}</h2>
        <p class="subtle">Period ${fmtDay(data.start || r.start)} – ${fmtDay(data.end || r.end)} · generated ${fmtDay(data.generated_at)} · ${esc(data.household)}</p></div>
      <div class="inline rep-dl">${dlBtn(cfg.format, true)}${r.csv === false ? "" : dlBtn(cfg.format === "pdf" ? "csv" : "pdf", false)}</div></header>
      ${r.csv === false ? '<p class="note">This older report has no daily figures stored, so only the PDF is available. Generate it again for CSV.</p>' : ""}
      <div class="report-doc">${reportBody(data)}</div><p class="note">All costs are estimates from your tariffs and readings.</p>`;
    drawReportCharts(box, data);
    box.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => download(b, urlOf(r, b.dataset.dl))));
  };
  const loading = (title) => { box.innerHTML = `<div class="rep-loading" role="status">${icon("refresh")}<b>${title}</b></div><div class="skel w40"></div><div class="skel chart-skel"></div>`; };
  const open = async (r) => {
    state.reportPreview = { src: r.src, key: r.key };
    loading("Loading report…");
    try {
      const got = await api(r.src === "custom" ? `/api/reports/custom/${r.key}` : `/api/reports/${r.key}`);
      show(r, got.data);
      el.querySelectorAll(".rep-table tr").forEach((tr) => tr.classList.toggle("sel", !!tr.querySelector(`[data-view="${r.src}:${r.key}"]`)));
    } catch (err) { showEmpty("Couldn't open this report", err.message, "alert"); }
  };
  const current = state.reportPreview && list.find((r) => r.src === state.reportPreview.src && r.key === state.reportPreview.key);
  if (current) open(current); else showEmpty();

  const f = el.querySelector("#gen");
  if (f) {
    const sync = () => { Object.assign(cfg, { start: f.elements.start.value, end: f.elements.end.value }); };
    f.elements.period.addEventListener("change", () => {
      cfg.period = f.elements.period.value;
      if (cfg.period !== "custom") { [cfg.start, cfg.end] = monthBounds(cfg.period); f.elements.start.value = cfg.start; f.elements.end.value = cfg.end; }
    });
    ["start", "end"].forEach((n) => f.elements[n].addEventListener("change", () => { sync(); cfg.period = "custom"; f.elements.period.value = "custom"; }));
    f.querySelectorAll("[data-kind],[data-format]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.kind ? "kind" : "format";
      cfg[k] = b.dataset[k];
      f.querySelectorAll(`[data-${k}]`).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
      if (k === "format" && shown) show(shown.r, shown.data);  // the chosen format becomes the main download button
    }));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      sync();
      const errBox = el.querySelector("#gen-err"), btn = el.querySelector("#gen-btn");
      const fail = (msg) => { errBox.innerHTML = `${icon("alert")}<span>${esc(msg)}</span>`; errBox.hidden = false; };
      errBox.hidden = true;
      if (!cfg.start || !cfg.end) return fail("Choose a start and an end date.");
      if (cfg.end < cfg.start) return fail("The end date must be on or after the start date.");
      if (cfg.end > today()) return fail("The end date can't be in the future.");
      btn.disabled = true;
      btn.classList.add("loading");
      const previous = shown;
      loading("Generating report…");
      try {
        const r = await post("/api/reports/custom", { kind: cfg.kind, start: cfg.start, end: cfg.end });
        state.reportPreview = { src: "custom", key: String(r.id) };
        toast(`${r.label} report is ready`, "success");
        ctx.rerender([ctx.state.view]);  // shows it below, adds it to Recent reports - no download, no navigation
      } catch (err) {
        fail(err.message);
        if (/no .*data/i.test(err.message)) showEmpty("No data for this period", err.message, "info");
        else if (previous) show(previous.r, previous.data);
        else showEmpty();
        btn.disabled = false;
        btn.classList.remove("loading");
      }
    });
  }
  el.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    const [src, key] = b.dataset.view.split(":");
    const r = list.find((x) => x.src === src && x.key === key);
    if (r) { open(r); box.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }));
  el.querySelectorAll("[data-del-rep]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await del(`/api/reports/custom/${b.dataset.delRep}`);
      if (state.reportPreview?.src === "custom" && state.reportPreview.key === b.dataset.delRep) state.reportPreview = null;
      toast("Report deleted", "success");
      ctx.rerender([ctx.state.view]);
    } catch (err) { toast(err.message, "error"); b.disabled = false; }
  }));
}
