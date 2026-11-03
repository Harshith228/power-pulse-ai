// Manual electricity readings: the Add Electricity Usage form (also used to edit), the records table and the
// "recorded usage" section built from every source. The server decides what counts: imported data wins for days it
// covers, manual readings fill the rest - shown on every record so nobody wonders why a number isn't added twice.
import * as charts from "./charts.js";
import { api, post, put, del } from "./store.js";
import { icon } from "./icons.js";
import { esc, fmtDay, inr, num } from "./format.js";
import { toast, openModal, closeModal } from "./ui.js";
import { cardHead, emptyState, kpiCard, countSpan } from "./components.js";

const SOURCES = [["manual", "Manual entry"], ["smart_meter", "Smart meter"], ["other", "Other"]];
const today = () => new Date().toISOString().slice(0, 10);
// views whose numbers include manual readings
export const AFFECTED = ["overview", "electricity/analytics", "electricity/anomalies", "electricity/alerts", "electricity/limit",
  "electricity/savings", "electricity/reports", "reports", "settings"];

export const addUsageButton = (cls = "btn primary") => `<button type="button" class="${cls}" data-add-usage>${icon("plus")}Add Electricity Usage</button>`;

export function bindAddUsage(root, ctx) {
  root.querySelectorAll("[data-add-usage]").forEach((b) => b.addEventListener("click", () => openUsageForm(ctx)));
}

function afterChange(ctx) {
  ctx.refreshNotifications();  // also refreshes the unread-anomaly badges
  ctx.rerender(AFFECTED);
}

/** Add (rec = null) or edit a reading. Inline, labelled validation; the server re-validates everything. */
export function openUsageForm(ctx, rec = null) {
  const w = openModal({
    title: rec ? "Edit electricity reading" : "Add electricity usage",
    body: `<form class="usage-form" id="usage-form" novalidate>
      <p class="subtle" style="margin:0">Enter what the meter shows you used - a whole day's units, or one hour's. Not the meter's running total.</p>
      <div class="usage-grid">
        <label class="field"><span>Date <i class="req" aria-hidden="true">*</i></span>
          <input type="date" name="date" required max="${today()}" value="${rec?.day ?? today()}" aria-describedby="err-date"><small class="err" id="err-date"></small></label>
        <label class="field"><span>Time (optional)</span>
          <input type="time" name="time" step="3600" value="${rec?.time ?? ""}" aria-describedby="hint-time err-time">
          <small class="hint" id="hint-time">Leave empty for a whole-day total</small><small class="err" id="err-time"></small></label>
        <label class="field"><span>Electricity used (kWh) <i class="req" aria-hidden="true">*</i></span>
          <input type="number" name="kwh" required min="0" step="0.01" inputmode="decimal" value="${rec?.kwh ?? ""}" placeholder="e.g. 12.5" aria-describedby="err-kwh"><small class="err" id="err-kwh"></small></label>
        <label class="field"><span>Source</span><select name="source">${SOURCES.map(([v, l]) => `<option value="${v}" ${(rec?.source ?? "manual") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field span2"><span>Notes (optional)</span><input type="text" name="notes" maxlength="500" value="${esc(rec?.notes ?? "")}" placeholder="e.g. guests staying, AC on all day"></label>
      </div>
      <div class="alert-box error" id="usage-err" role="alert" hidden></div>
      <div class="imp-actions"><button type="button" class="btn" data-modal-close>Cancel</button>
        <button type="submit" class="btn primary" id="usage-save">${icon("check")}${rec ? "Save changes" : "Save reading"}</button></div>
    </form>`,
  });
  const f = w.querySelector("#usage-form");
  const setErr = (name, msg) => {
    const input = f.elements[name];
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    w.querySelector(`#err-${name}`).textContent = msg || "";
    return !msg;
  };
  const check = () => {
    const v = f.elements, kwh = v.kwh.value.trim() === "" ? NaN : +v.kwh.value;
    const ok = [
      setErr("date", !v.date.value ? "Choose a date." : v.date.value > today() ? "The date can't be in the future." : ""),
      setErr("time", v.time.value && !/^\d\d:00$/.test(v.time.value.slice(0, 5)) ? "Use a time on the hour, e.g. 18:00." : ""),
      setErr("kwh", Number.isNaN(kwh) ? "Enter the kWh used." : kwh < 0 ? "Electricity used can't be negative."
        : kwh > (v.time.value ? 60 : 500) ? `That's more than a home uses in ${v.time.value ? "an hour" : "a day"} - enter the units used, not the meter total.` : ""),
    ];
    return ok.every(Boolean);
  };
  ["date", "time", "kwh"].forEach((n) => f.elements[n].addEventListener("change", check));
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const box = w.querySelector("#usage-err");
    box.hidden = true;
    if (!check()) { f.querySelector("[aria-invalid=true]")?.focus(); return; }
    const btn = w.querySelector("#usage-save"), v = f.elements;
    btn.disabled = true;
    btn.classList.add("loading");
    const body = { date: v.date.value, time: v.time.value ? v.time.value.slice(0, 5) : null, kwh: +v.kwh.value, source: v.source.value, notes: v.notes.value };
    try {
      const r = rec ? await put(`/api/electricity/readings/${rec.id}`, body) : await post("/api/electricity/readings", body);
      closeModal();
      toast(r.counted ? `${rec ? "Updated" : "Saved"} ${num(r.kwh, 2)} kWh for ${fmtDay(r.day)}${r.time ? " " + r.time : ""}`
        : `Saved for ${fmtDay(r.day)}, but not counted: imported data already covers that day`, r.counted ? "success" : "info");
      afterChange(ctx);
    } catch (err) {
      box.innerHTML = `${icon("alert")}<span>${esc(err.message)}</span>`;
      box.hidden = false;
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  });
  return w;
}

/** Records table. compact = latest few with a link to the full list. */
export function readingsCard(r, { compact = false } = {}) {
  const head = cardHead("Manual electricity readings",
    `${num(r.total, 0)} reading${r.total === 1 ? "" : "s"} on ${num(r.days, 0)} day${r.days === 1 ? "" : "s"}` +
    (r.not_counted_days ? ` · ${num(r.not_counted_days, 0)} day${r.not_counted_days === 1 ? "" : "s"} not counted (imported data covers them)` : ""),
    compact ? `<a class="link" data-goto="settings" data-settings-tab="data" data-data-tab="electricity">All readings ${icon("arrowRight")}</a>` : addUsageButton("btn sm primary"));
  if (!r.items.length) {
    return `<div class="card flush reveal" id="manual-readings"><div class="pad">${head}</div><div class="pad">${emptyState("No manual readings yet",
      "Add a day's units from your meter or bill, or one hour at a time. They're stored separately from imported data and never overwrite it.", addUsageButton(), "edit")}</div></div>`;
  }
  return `<div class="card flush reveal" id="manual-readings"><div class="pad">${head}</div>
    <div class="table-wrap"><table class="w-table manual-table"><thead><tr><th>Date</th><th>Time</th><th class="n">kWh</th><th>Source</th><th>Status</th><th>Notes</th><th></th></tr></thead><tbody>
    ${r.items.map((x) => `<tr class="${x.counted ? "" : "muted-row"}"><td data-l="Date">${fmtDay(x.day)}</td><td data-l="Time">${x.time ?? '<span class="subtle">Whole day</span>'}</td>
      <td class="n num" data-l="kWh"><b>${num(x.kwh, 2)}</b></td><td data-l="Source"><span class="tag manual">${esc(x.source_label)}</span></td>
      <td data-l="Status">${x.counted ? `<span class="tag good">${icon("check")}Counted</span>` : `<span class="tag warn" title="${esc(x.status)}">Not counted</span>`}</td>
      <td data-l="Notes" class="subtle">${esc(x.notes || "")}</td>
      <td class="row-actions"><button class="btn sm ghost" data-edit-er='${esc(JSON.stringify(x))}' aria-label="Edit reading for ${fmtDay(x.day)}">${icon("edit")}</button>
        <button class="btn sm ghost" data-del-er="${x.id}" data-label="${fmtDay(x.day)}${x.time ? " " + x.time : ""}" aria-label="Delete reading for ${fmtDay(x.day)}">${icon("trash")}</button></td></tr>`).join("")}
    </tbody></table></div>
    ${r.total > r.items.length && !compact ? `<div class="more-row"><button class="btn sm" id="er-more">Show more (${num(r.total - r.items.length, 0)} left)</button></div>` : ""}
    <p class="note pad" style="margin:0">Imported data (CSV, UCI, smart-meter exports) is used for every day it covers; a manual reading for such a day is kept here but not added on top, so nothing is counted twice.</p></div>`;
}

export function bindReadings(root, ctx, onMore) {
  bindAddUsage(root, ctx);
  root.querySelectorAll("[data-edit-er]").forEach((b) => b.addEventListener("click", () => openUsageForm(ctx, JSON.parse(b.dataset.editEr))));
  root.querySelectorAll("[data-del-er]").forEach((b) => b.addEventListener("click", () => openModal({
    title: "Delete this reading?",
    body: `<p>The ${esc(b.dataset.label)} reading will be removed and every total, limit and chart updated. Imported data isn't affected.</p>
      <div class="imp-actions"><button class="btn" data-modal-close>Cancel</button><button class="btn danger" id="yes">${icon("trash")}Delete</button></div>`,
    onMount: (w) => w.querySelector("#yes").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { await del(`/api/electricity/readings/${b.dataset.delEr}`); closeModal(); toast("Reading deleted", "success"); afterChange(ctx); }
      catch (err) { closeModal(); toast(err.message, "error"); }
    }),
  })));
  root.querySelector("#er-more")?.addEventListener("click", onMore);
}

/** Daily / weekly / monthly usage and cost from every source (GET /api/electricity/usage). */
export function usageSection(u, { title = "Your recorded usage" } = {}) {
  if (!u.has_data) return "";
  const w = u.window, m = u.month;
  const monthName = new Date(m.month + "-01T00:00:00Z").toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return `<div class="section-title mt">${icon("activity")} ${title}</div>
    <div class="grid g4 stagger">
      ${kpiCard({ label: "Total, latest 90 days", ic: "zap", value: countSpan(w.total_kwh, { dec: 1 }), unit: "kWh", foot: `${num(w.days, 0)} days with data` })}
      ${kpiCard({ label: "Average per day", ic: "activity", value: countSpan(w.avg_daily_kwh, { dec: 1 }), unit: "kWh", foot: `${num(w.manual_days, 0)} of these days from manual readings` })}
      ${kpiCard({ label: monthName, ic: "calendar", value: countSpan(m.kwh, { dec: 1 }), unit: "kWh", foot: `${num(m.days, 0)} days recorded` })}
      ${kpiCard({ label: "Estimated cost", ic: "wallet", value: countSpan(m.cost_inr, { prefix: "₹" }), foot: `${monthName} so far · ${inr(m.projected_cost_inr)} projected` })}
    </div>
    <div class="card mt reveal">${cardHead("Daily consumption", `All sources · latest 90 days to ${fmtDay(u.latest_day)} · orange = manual readings`)}
      <div class="chart tall" id="ch-usage-daily" role="img" aria-label="Daily electricity use by source"></div></div>
    <div class="grid g2 mt">
      <div class="card reveal">${cardHead("Monthly consumption", "kWh per calendar month, with the estimated bill")}
        <div class="chart" id="ch-usage-monthly" role="img" aria-label="Monthly electricity totals"></div>
        <div class="table-wrap"><table class="mini"><thead><tr><th>Month</th><th class="n">kWh</th><th class="n">Est. cost</th></tr></thead><tbody>
          ${u.monthly.slice().reverse().slice(0, 6).map((r) => `<tr><td>${new Date(r.month + "-01T00:00:00Z").toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })}</td>
            <td class="n num">${num(r.kwh, 1)}</td><td class="n num">${inr(r.cost_inr)}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="card flush reveal"><div class="pad">${cardHead("Weekly totals", "Latest 12 weeks (weeks end on Sunday)")}</div>
        <div class="table-wrap"><table class="mini"><thead><tr><th>Week ending</th><th class="n">kWh</th><th class="n">Per day</th></tr></thead><tbody>
          ${u.weekly.slice().reverse().map((x) => `<tr><td>${fmtDay(x.week_end)}</td><td class="n num">${num(x.kwh, 1)}</td><td class="n num">${num(x.kwh / 7, 1)}</td></tr>`).join("")}
        </tbody></table></div></div>
    </div>`;
}

export function drawUsageCharts(root, u) {
  if (!u.has_data) return;
  charts.sourceDailyChart(root.querySelector("#ch-usage-daily"), u.daily);
  charts.monthlyTotalsChart(root.querySelector("#ch-usage-monthly"), u.monthly.map((r) => ({ month: r.month, value: r.kwh })), { unit: "kWh", color: charts.C.s1, dec: 0 });
}

export const fetchUsage = () => Promise.all([api("/api/electricity/usage?days=90"), api("/api/electricity/readings?limit=8")]);
