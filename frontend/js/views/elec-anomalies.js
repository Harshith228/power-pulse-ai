// Electricity > Anomaly Detection: every anomaly (the active dataset's and those found in manual readings) with
// read/unread state, filters, totals and a detail panel. Rows are marked read only once the user has seen them.
import * as charts from "../charts.js";
import { state, api } from "../store.js";
import { icon } from "../icons.js";
import { esc, fmtTime, inr, num, pct } from "../format.js";
import { TYPE_LABEL, sevTag, typeTag, originTag, when, recItem, emptyState, dataSourceLine, kpiCard, countSpan } from "../components.js";
import { readTracker, setRead, markAllRead, READ_OPTS } from "../anomaly-read.js";
import { addUsageButton, bindAddUsage } from "../elec-manual.js";
import { setAnomalyCounts } from "../shell.js";
import { toast } from "../ui.js";

const CHECKS = {
  spike: ["Check what was switched on around that time: geyser, AC or heater, iron, oven, motor or pump.",
    "Make sure nothing was left running, and that a thermostat isn't stuck on.",
    "If it happens at the same time again, put that appliance on a timer or move it off-peak."],
  sustained: ["Something started using more power for days: a new appliance, more AC or heater use, a fridge with a failing seal or thermostat.",
    "Compare a normal day with one of these days hour by hour to see whether the extra load is all day or at set times.",
    "Check pumps and geysers that might be cycling more than usual."],
  repeated: ["The same extra load keeps returning at the same hour: look at timers and scheduled appliances.",
    "Note what runs at that hour for a few days to find the cause."],
  night: ["Something uses power while the house sleeps: AC or heater, geyser, water pump, chargers and standby loads.",
    "Switch non-essential loads off at the plug for a night and compare the next morning's reading."],
};
const actualOf = (e) => (e.type === "spike" && e.granularity !== "day" ? e.peak_kwh : e.actual_kwh ?? e.peak_kwh);
const actualLabel = (e) => (e.granularity === "day" ? "Daily use" : e.type === "spike" ? "Peak hour" : e.type === "sustained" ? "Avg daily use" : "Actual");
const deviation = (e) => (e.deviation_pct == null ? "–" : `+${num(e.deviation_pct, 0)}%`);

export default async function elecAnomalies(el, ctx) {
  const data = await api("/api/anomalies/electricity");
  setAnomalyCounts({ electricity: data.counts });
  const all = data.events, rate = data.marginal_rate || 0;
  const cost = (e) => (e.excess_kwh || 0) * rate;
  const f = state.filters;
  f.read ??= "all";
  const list = all.filter((e) => (f.type === "all" || e.type === f.type) && (f.severity === "all" || e.severity === f.severity)
    && (f.origin === "all" || e.origin === f.origin) && (f.read === "all" || (f.read === "unread" ? !e.read : e.read)));
  const hasTruth = !!state.res?.dataset?.has_ground_truth;
  const seg = (key, label, opts) => `<div class="seg" data-filter="${key}" role="group" aria-label="${label}">${opts.map(([v, l]) => `<button data-v="${v}" class="${f[key] === v ? "on" : ""}" aria-pressed="${f[key] === v}">${l}</button>`).join("")}</div>`;
  if (!list.find((e) => e.key === state.selectedKey)) state.selectedKey = list[0]?.key ?? null;

  if (!all.length) {
    const m = data.manual;
    el.innerHTML = `${data.has_dataset ? dataSourceLine("electricity", state.res?.dataset) : ""}<div class="card">${data.has_dataset
      ? emptyState("No anomalies found", "This household's consumption stayed within its learned normal range.", "", "checkCircle")
      : m.days ? emptyState("Not enough readings yet", `Checks on manual readings need at least ${m.min_days} earlier days of data before a day can be judged; you have ${m.days}. One reading on its own can't show what's unusual.`, addUsageButton(), "clock")
        : emptyState("No electricity data yet", "Add your daily units by hand, or upload a meter CSV, to start detecting unusual consumption.",
          `<div class="inline" style="justify-content:center">${addUsageButton()}<button class="btn" data-goto="settings" data-settings-tab="data" data-data-tab="electricity">${icon("cloudUpload")}Upload a CSV</button></div>`, "zap")}</div>`;
    bindAddUsage(el, ctx);
    return;
  }

  const c = data.counts;
  const crit = all.filter((e) => e.severity === "critical").length;
  el.innerHTML = `${data.has_dataset ? dataSourceLine("electricity", state.res?.dataset) : ""}
    <div class="grid g4 stagger">
      ${kpiCard({ label: "Anomalies detected", ic: "scan", value: countSpan(c.total), foot: data.has_dataset ? "active dataset and manual readings" : "from manual readings" })}
      ${kpiCard({ label: "Unread", ic: "bellRing", value: `<span id="k-unread">${num(c.unread, 0)}</span>`, tone: c.unread ? "accent" : "", foot: "marked read once you've seen them" })}
      ${kpiCard({ label: "Read", ic: "checkCheck", value: `<span id="k-read">${num(c.read, 0)}</span>`, foot: "kept for reference" })}
      ${kpiCard({ label: "Critical", ic: "alert", value: countSpan(crit), tone: crit ? "danger" : "", foot: `${num(all.filter((e) => e.severity === "high").length, 0)} high` })}
    </div>
    <div class="filters mt">
      ${seg("read", "Read status", READ_OPTS)}
      ${seg("severity", "Severity", [["all", "Any severity"], ["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]])}
      ${seg("type", "Anomaly type", [["all", "All types"], ["spike", "Spikes"], ["sustained", "Sustained"], ["repeated", "Repeated"], ["night", "Night-time"]])}
      ${hasTruth ? seg("origin", "Origin", [["all", "All"], ["injected", "Injected"], ["natural", "Natural"]]) : ""}
      <span class="count-note inline"><span class="subtle">${list.length} of ${all.length} anomalies</span>
        <button class="btn sm" id="read-all" ${c.unread ? "" : "disabled"}>${icon("checkCheck")}Mark all as read</button></span>
    </div>
    <div class="split">
      <div class="card flush">
        <div class="table-wrap"><table class="ev-table">
          <thead><tr><th>Severity</th><th>Anomaly</th><th>When</th><th class="n">Actual vs expected</th><th><span class="sr-only">Read</span></th></tr></thead>
          <tbody>${list.slice(0, state.limit).map((e) => `<tr class="click ${e.key === state.selectedKey ? "sel" : ""} ${e.read ? "" : "unread"}" data-row="${esc(e.key)}" data-key="${esc(e.key)}" data-read="${e.read}" tabindex="0" aria-selected="${e.key === state.selectedKey}"${e.detected_at ? ` title="Detected ${fmtTime(e.detected_at)}"` : ""}>
            <td data-l="Severity"><span class="sev-cell"><span class="unread-dot" aria-hidden="true"></span>${sevTag(e.severity)}${e.read ? "" : '<span class="sr-only">Unread</span>'}</span></td>
            <td data-l="Anomaly"><b>${esc(e.title)}</b><div class="subtle">${TYPE_LABEL[e.type]}${e.circuit ? " · " + esc(e.circuit.label.split(" (")[0]) : ""}${e.data_source === "manual" ? ' · <span class="tag manual">Manual readings</span>' : ""}</div></td>
            <td data-l="When" class="subtle">${when(e)}</td>
            <td data-l="Actual vs expected" class="n num"><b>${num(actualOf(e), 1)}</b> / ${num(e.expected_kwh, 1)} kWh
              <div class="dev">${deviation(e)}<span class="subtle"> · +${num(e.excess_kwh)} kWh · ${inr(cost(e))}</span></div></td>
            <td class="row-actions"><button class="icon-btn sm" data-toggle-read aria-label="${e.read ? "Mark as unread" : "Mark as read"}" data-tip="${e.read ? "Mark as unread" : "Mark as read"}">${icon(e.read ? "eyeOff" : "check")}</button></td></tr>`).join("")
            || `<tr><td colspan="5">${emptyState("No matches", f.read === "unread" ? "You've seen every anomaly that matches these filters." : "No anomalies match these filters.", "", "search")}</td></tr>`}</tbody></table></div>
        ${list.length > state.limit ? `<div class="more-row"><button class="btn sm" id="more">Show more (${list.length - state.limit} left)</button></div>` : ""}
      </div>
      <div class="card detail" id="detail" aria-live="polite"></div>
    </div>`;

  const byKey = new Map(all.map((e) => [e.key, e]));
  const refreshCounts = (counts) => {
    const k = counts.electricity;
    el.querySelector("#k-unread").textContent = num(k.unread, 0);
    el.querySelector("#k-read").textContent = num(k.read, 0);
    el.querySelector("#read-all").disabled = !k.unread;
  };
  const applyRead = (keys, read, counts) => {
    keys.forEach((k) => {
      const e = byKey.get(k);
      if (e) e.read = read;
      const r = el.querySelector(`[data-row="${CSS.escape(k)}"]`);
      if (!r) return;
      r.classList.toggle("unread", !read);
      r.dataset.read = String(read);
      const b = r.querySelector("[data-toggle-read]");
      b.setAttribute("aria-label", read ? "Mark as unread" : "Mark as read");
      b.dataset.tip = read ? "Mark as unread" : "Mark as read";
      b.innerHTML = icon(read ? "eyeOff" : "check");
    });
    if (counts) refreshCounts(counts);
  };
  const tracker = readTracker("electricity", applyRead);
  tracker.observe(el);

  el.querySelectorAll("[data-filter]").forEach((g) => g.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    state.filters[g.dataset.filter] = b.dataset.v;
    state.limit = 60;
    ctx.rerender([ctx.state.view]);
  })));
  el.querySelectorAll("[data-row]").forEach((r) => {
    const pick = () => {
      state.selectedKey = r.dataset.row;
      el.querySelectorAll("[data-row]").forEach((x) => { x.classList.toggle("sel", x === r); x.setAttribute("aria-selected", String(x === r)); });
      drawDetail(el, byKey, cost);
      if (r.dataset.read === "false") tracker.seen(r.dataset.row);  // opened = seen
      if (window.matchMedia("(max-width: 1100px)").matches) el.querySelector("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    r.addEventListener("click", (e) => { if (!e.target.closest("[data-toggle-read]")) pick(); });
    r.addEventListener("keydown", (e) => e.key === "Enter" && e.target === r && pick());
    r.querySelector("[data-toggle-read]").addEventListener("click", () => setRead("electricity", [r.dataset.row], r.dataset.read === "false", applyRead));
  });
  el.querySelector("#read-all").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const r = await markAllRead("electricity");
      applyRead(all.map((x) => x.key), true, r.counts);
      toast(`Marked ${num(r.updated, 0)} anomal${r.updated === 1 ? "y" : "ies"} as read`, "success");
    } catch (err) { toast(err.message, "error"); e.target.disabled = false; }
  });
  el.querySelector("#more")?.addEventListener("click", () => { state.limit += 60; ctx.rerender([ctx.state.view]); });
  drawDetail(el, byKey, cost);
}

function drawDetail(el, byKey, cost) {
  const box = el.querySelector("#detail");
  if (!box) return;
  const e = byKey.get(state.selectedKey);
  if (!e) { box.innerHTML = emptyState("Select an anomaly", "Pick a row to see why it was flagged.", "", "scan"); return; }
  const rec = e.data_source === "dataset" ? state.res?.recommendations.find((r) => r.key === e.recommendation) : null;
  const rows = [...el.querySelectorAll("[data-row]")].map((r) => r.dataset.row), pos = rows.indexOf(e.key);
  const checks = e.checks || CHECKS[e.type] || [];
  box.innerHTML = `
    <div class="inline">${sevTag(e.severity)}${typeTag(e.type)}${originTag(e.origin)}${e.data_source === "manual" ? '<span class="tag manual">Manual readings</span>' : ""}
      <span class="detail-nav"><button class="icon-btn sm" data-step="-1" ${pos <= 0 ? "disabled" : ""} aria-label="Previous anomaly">${icon("chevronRight", "flip")}</button>
      <span class="subtle">${pos + 1} / ${rows.length}</span><button class="icon-btn sm" data-step="1" ${pos < 0 || pos >= rows.length - 1 ? "disabled" : ""} aria-label="Next anomaly">${icon("chevronRight")}</button></span></div>
    <h3>${esc(e.title)}</h3><p class="subtle" style="margin:2px 0 0">${when(e)}${e.detected_at ? ` · detected ${fmtTime(e.detected_at)}` : ""}</p>
    ${e.data_source === "dataset" && state.res ? '<div class="chart short" id="ch-event" style="margin-top:12px" role="img" aria-label="Actual versus expected consumption around this anomaly"></div>' : ""}
    <div class="facts">
      <div class="fact"><span>${actualLabel(e)}</span><b class="num">${num(actualOf(e), 2)} kWh</b></div>
      <div class="fact"><span>Expected</span><b class="num">${num(e.expected_kwh, 2)} kWh</b></div>
      <div class="fact"><span>Deviation</span><b class="num">${deviation(e)}</b></div>
      <div class="fact"><span>Robust z-score</span><b class="num">${num(e.z, 1)}</b></div>
      ${e.if_pct != null ? `<div class="fact"><span>Model rarity</span><b class="num">${pct(Math.min(e.if_pct, 0.9999), 1)}</b></div>` : `<div class="fact"><span>vs. normal</span><b class="num">${num(e.ratio, 1)}×</b></div>`}
      <div class="fact"><span>Extra cost</span><b class="num">${inr(cost(e))}</b></div>
    </div>
    <div class="section-title" style="margin-top:0">${icon("sparkles")} Why it was flagged</div>
    <ul class="why">${(e.factors || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    ${e.circuit ? `<div class="share"><div class="inline" style="justify-content:space-between"><span class="subtle">Main contributor</span><b>${esc(e.circuit.label)} · ${pct(e.circuit.share)}</b></div><div class="track"><span style="width:${e.circuit.share * 100}%"></span></div></div>` : ""}
    ${checks.length ? `<div class="section-title">${icon("listChecks")} Suggested checks</div><ul class="why">${checks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${rec ? `<div class="section-title">${icon("lightbulb")} Recommended action</div>${recItem(rec)}` : ""}
    <p class="note" style="margin-top:12px">PowerPulse sees only household totals, so these are things to check - not a diagnosis of a specific appliance.</p>`;
  if (e.data_source === "dataset" && state.res) {
    const ev = state.res.events.find((x) => x.type === e.type && x.start === e.start) || e;
    charts.eventChart(box.querySelector("#ch-event"), state.res, ev);
  }
  box.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
    const k = rows[pos + +b.dataset.step];
    el.querySelector(`[data-row="${CSS.escape(k)}"]`)?.click();
  }));
}
