// Water > Anomaly Detection.
import * as charts from "../charts.js";
import { state } from "../store.js";
import { icon } from "../icons.js";
import { esc, fmtDay, fmtTime, num } from "../format.js";
import { cardHead, emptyState, kpiCard, sevTag, dataSourceLine, countSpan } from "../components.js";
import { waterSummary } from "./water-analytics.js";
import { readTracker, setRead, markAllRead, READ_OPTS } from "../anomaly-read.js";
import { setAnomalyCounts } from "../shell.js";
import { toast } from "../ui.js";

export const WATER_TYPE = { spike: "Sudden spike", overnight: "High overnight use", continuous: "Continuous flow", sustained: "Sustained increase", repeated: "Repeated pattern" };

/** Expandable explanation card for a water anomaly. */
export function waterAnomalyCard(a, open = false) {
  const perHour = a.type === "continuous";
  const dec = perHour ? 1 : 0;
  return `<details class="wa-card ${a.severity} ${a.read ? "" : "unread"}" id="wa-${a.id}" ${open ? "open" : ""}>
    <summary data-key="${esc(a.key)}" data-read="${!!a.read}"><span class="bar"></span><span class="unread-dot" aria-hidden="true"></span><span class="wa-main"><b>${esc(a.title)}</b>
      <span class="subtle">${a.start === a.end ? fmtDay(a.start) : `${fmtDay(a.start)} – ${fmtDay(a.end)}`} · ${WATER_TYPE[a.type] || a.type}</span></span>
      <span class="wa-right">${sevTag(a.severity)}<b class="num">${a.deviation_pct == null ? "" : `${a.deviation_pct > 0 ? "+" : ""}${num(a.deviation_pct, 0)}%`}</b></span>${icon("chevronDown", "chev")}</summary>
    <div class="wa-body">
      <div class="facts">
        <div class="fact"><span>Actual${perHour ? " (L per hour, quietest hour)" : ""}</span><b class="num">${num(a.actual_litres, dec)} L</b></div>
        <div class="fact"><span>Expected</span><b class="num">${num(a.expected_litres, dec)} L</b></div>
        <div class="fact"><span>Deviation</span><b class="num">${a.deviation_pct == null ? "–" : `${a.deviation_pct > 0 ? "+" : ""}${num(a.deviation_pct, 0)}%`}</b></div>
      </div>
      <p>${esc(a.detail)}</p>
      <div class="section-title">${icon("sparkles")} Possible explanations</div>
      <ul class="why">${a.explanations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <div class="section-title">${icon("listChecks")} Recommended checks</div>
      <ul class="checks-list">${a.checks.map((x) => `<li>${icon("checkCircle")}<span>${esc(x)}</span></li>`).join("")}</ul>
      <p class="note">${esc(a.disclaimer)}</p>
      <div class="wa-foot"><span class="subtle">${a.detected_at ? `Detected ${fmtTime(a.detected_at)}` : ""}</span>
        <button class="btn sm ghost" data-toggle-read="${esc(a.key)}">${icon(a.read ? "eyeOff" : "check")}${a.read ? "Mark as unread" : "Mark as read"}</button></div>
    </div></details>`;
}

export default async function waterAnomalies(el, ctx) {
  const s = await waterSummary();
  if (!s.has_data) {
    el.innerHTML = `${dataSourceLine("water", null)}<div class="card">${emptyState("No water data yet", "Add water readings and PowerPulse will flag spikes, overnight use, continuous flow and rising consumption.",
      '<button class="btn primary" data-goto="water/analytics">Go to Water Usage</button>', "droplet")}</div>`;
    return;
  }
  setAnomalyCounts({ water: s.anomaly_counts });
  const all = s.anomalies, f = state.waterFilter || (state.waterFilter = { type: "all", severity: "all" });
  f.read ??= "all";
  const c = s.anomaly_counts;
  const list = all.filter((a) => (f.type === "all" || a.type === f.type) && (f.severity === "all" || a.severity === f.severity)
    && (f.read === "all" || (f.read === "unread" ? !a.read : a.read)));
  const by = (k) => all.reduce((m, a) => (m[a[k]] = (m[a[k]] || 0) + 1, m), {});
  const bySev = by("severity"), wu = s.unit_pref, div = wu === "kL" ? 1000 : 1;
  const seg = (key, label, opts) => `<div class="seg" role="group" aria-label="${label}">${opts.map(([v, l]) => `<button data-${key}="${v}" class="${f[key] === v ? "on" : ""}" aria-pressed="${f[key] === v}">${l}</button>`).join("")}</div>`;
  el.innerHTML = `
    ${dataSourceLine("water", s)}
    <div class="grid g4 stagger">
      ${kpiCard({ label: "Unusual water events", ic: "scan", value: countSpan(all.length), foot: `${num(s.anomaly_litres_total / div, wu === "kL" ? 2 : 0)} ${wu} above normal in total` })}
      ${kpiCard({ label: "Unread", ic: "bellRing", value: `<span id="k-unread">${num(c.unread, 0)}</span>`, tone: c.unread ? "accent" : "", foot: "marked read once you've seen them" })}
      ${kpiCard({ label: "Read", ic: "checkCheck", value: `<span id="k-read">${num(c.read, 0)}</span>`, foot: "kept for reference" })}
      ${kpiCard({ label: "High priority", ic: "alert", value: countSpan((bySev.critical || 0) + (bySev.high || 0)), tone: (bySev.critical || bySev.high) ? "danger" : "good", foot: `${bySev.critical || 0} critical · ${bySev.high || 0} high` })}
    </div>
    <div class="card mt reveal">${cardHead("Daily water use with detected events", `Dots = one-day events, bands = multi-day events (colour = severity). Click a dot to open it. ${s.has_hourly ? "Overnight and continuous-flow checks are on." : "Overnight and continuous-flow checks need hourly readings."}`)}
      <div class="chart tall" id="ch-wa" role="img" aria-label="Daily water use with anomalies marked"></div></div>
    <div class="filters mt">${seg("read", "Read status", READ_OPTS)}
      ${seg("severity", "Severity", [["all", "Any severity"], ["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]])}
      ${seg("type", "Type", [["all", "All types"], ...Object.entries(WATER_TYPE)])}
      <span class="count-note inline"><span class="subtle">${list.length} of ${all.length} events</span>
        <button class="btn sm" id="read-all" ${c.unread ? "" : "disabled"}>${icon("checkCheck")}Mark all as read</button></span></div>
    <div class="grid g-main">
      <div>${list.length ? `<div class="wa-list">${list.map((a, i) => waterAnomalyCard(a, i === 0)).join("")}</div>`
        : `<div class="card">${emptyState(all.length ? "No matches" : "Nothing unusual", all.length ? (f.read === "unread" ? "You've seen every event that matches these filters." : "No events match these filters.") : s.days < 8 ? "PowerPulse needs about a week of readings to learn what's normal." : "Water use matched this home's normal pattern.", "", "checkCircle")}</div>`}</div>
      <div class="card reveal">${cardHead("How water anomalies are detected", "Statistical rules on this home's own history")}
        <dl class="model">${[["Sudden spike", s.rules.spike], ["Sustained increase", s.rules.sustained], ["Repeated pattern", s.rules.repeated],
          ["High overnight use", s.rules.overnight], ["Continuous flow", s.rules.continuous], ["Warm-up", s.rules.warmup]]
          .map(([t, r]) => `<dt>${t}</dt><dd>${esc(r)}</dd>`).join("")}</dl>
        <p class="note">PowerPulse sees the household total only, so it suggests checks - it never claims a specific tap or pipe is faulty.</p></div>
    </div>`;
  const applyRead = (keys, read, counts) => {
    keys.forEach((k) => {
      const a = all.find((x) => x.key === k);
      if (a) a.read = read;
      const sm = el.querySelector(`summary[data-key="${CSS.escape(k)}"]`);
      if (!sm) return;
      sm.dataset.read = String(read);
      sm.parentElement.classList.toggle("unread", !read);
      const b = sm.parentElement.querySelector("[data-toggle-read]");
      b.innerHTML = `${icon(read ? "eyeOff" : "check")}${read ? "Mark as unread" : "Mark as read"}`;
    });
    if (counts) {
      el.querySelector("#k-unread").textContent = num(counts.water.unread, 0);
      el.querySelector("#k-read").textContent = num(counts.water.read, 0);
      el.querySelector("#read-all").disabled = !counts.water.unread;
    }
  };
  const tracker = readTracker("water", applyRead);
  tracker.observe(el);
  const tail = (k) => s.daily[k];
  charts.waterEventsChart(el.querySelector("#ch-wa"), { t: tail("t"), litres: tail("litres") }, all, { unit: wu, div,
    onPick: (ev) => {
      const card = el.querySelector(`#wa-${ev.id}`);
      if (!card) return;
      card.open = true;
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      const sm = card.querySelector("summary");
      if (sm.dataset.read === "false") tracker.seen(sm.dataset.key);  // picked from the chart = seen
    } });
  el.querySelectorAll(".wa-card > summary").forEach((sm) => sm.addEventListener("click", () => {
    if (!sm.parentElement.open && sm.dataset.read === "false") tracker.seen(sm.dataset.key);  // the user opened it = seen
  }));
  el.querySelectorAll("[data-toggle-read]").forEach((b) => b.addEventListener("click", () => {
    const sm = el.querySelector(`summary[data-key="${CSS.escape(b.dataset.toggleRead)}"]`);
    setRead("water", [b.dataset.toggleRead], sm.dataset.read === "false", applyRead);
  }));
  el.querySelector("#read-all")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const r = await markAllRead("water");
      applyRead(all.map((x) => x.key), true, r.counts);
      toast(`Marked ${num(r.updated, 0)} water event${r.updated === 1 ? "" : "s"} as read`, "success");
    } catch (err) { toast(err.message, "error"); e.target.disabled = false; }
  });
  el.querySelectorAll("button[data-read]").forEach((b) => b.addEventListener("click", () => { f.read = b.dataset.read; ctx.rerender([ctx.state.view]); }));
  el.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => { f.type = b.dataset.type; ctx.rerender([ctx.state.view]); }));
  el.querySelectorAll("[data-severity]").forEach((b) => b.addEventListener("click", () => { f.severity = b.dataset.severity; ctx.rerender([ctx.state.view]); }));
}
