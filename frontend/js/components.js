// Reusable dashboard markup builders: tags, KPI cards, alert cards, recommendations, empty and loading states.
import { state } from "./store.js";
import { icon } from "./icons.js";
import { esc, fmtDay, fmtTime, inr, num } from "./format.js";

export const TYPE_LABEL = { spike: "Sudden spike", sustained: "Sustained increase", repeated: "Repeated pattern", night: "Night-time increase" };
export const SEVERITIES = ["critical", "high", "medium", "low"];
export const SEV_COLOR = { low: "var(--low)", medium: "var(--warning)", high: "var(--serious)", critical: "var(--critical)" };

export const sevTag = (s) => `<span class="sev ${s}">${s[0].toUpperCase() + s.slice(1)}</span>`;
export const originTag = (o) => o === "observed" ? "" : `<span class="tag ${o}">${o === "injected" ? "Injected" : "Natural"}</span>`;
export const typeTag = (t) => `<span class="tag">${TYPE_LABEL[t]}</span>`;
export const eventCost = (e) => e.excess_kwh * state.res.cost.marginal_rate;
export const when = (e) => e.granularity === "day" ? fmtDay(e.start)  // daily checks on manual readings have no peak hour
  : e.type === "sustained" ? `${fmtDay(e.start)} – ${fmtDay(e.end)}`
  : e.type === "repeated" ? `${e.occurrences.length}× from ${fmtDay(e.start)}` : fmtTime(e.peak_time);

/** Count-up number span. Final text is rendered immediately so the value is correct without JS animation. */
export const countSpan = (value, { dec = 0, prefix = "", suffix = "" } = {}) =>
  `<span data-count="${value}" data-dec="${dec}" data-prefix="${prefix}" data-suffix="${suffix}">${prefix}${(+value).toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec })}${suffix}</span>`;

/** KPI card. value is HTML (usually a countSpan); tone: "" | "accent" | "good" | "warn" | "danger". */
export const kpiCard = ({ label, ic, value, unit = "", foot = "", tone = "", extra = "", tip = "" }) => `
  <div class="card kpi ${tone}">
    <div class="kpi-top"><span class="label">${label}</span><span class="ic">${icon(ic)}</span></div>
    <div class="value num">${value}${unit ? `<small>${unit}</small>` : ""}</div>${extra}
    ${foot ? `<div class="foot">${foot}</div>` : ""}${tip ? `<span class="kpi-info" data-tip="${esc(tip)}" tabindex="0">${icon("info")}</span>` : ""}
  </div>`;

export const cardHead = (title, sub = "", right = "") =>
  `<div class="card-h"><div><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ""}</div>${right}</div>`;

export const sevBar = (by) => {
  const total = Object.values(by).reduce((a, b) => a + b, 0) || 1;
  return `<div class="sevbar" role="img" aria-label="Severity split: ${SEVERITIES.map((s) => `${by[s]} ${s}`).join(", ")}">${SEVERITIES.filter((s) => by[s])
    .map((s) => `<span style="width:${(100 * by[s]) / total}%;background:${SEV_COLOR[s]}" data-tip="${by[s]} ${s}"></span>`).join("")}</div>`;
};

export function alertItem(e) {
  return `<div class="alert ${e.severity}" data-event="${e.id}" tabindex="0" role="button" aria-label="Open anomaly ${e.id}: ${esc(e.title)}">
    <div class="bar"></div>
    <div class="alert-body"><h4>${esc(e.title)}</h4><p>${when(e)}</p>
      <div class="meta">${sevTag(e.severity)}${typeTag(e.type)}${originTag(e.origin)}</div></div>
    <div class="right"><b class="num">+${num(e.excess_kwh)} kWh</b><span>≈ ${inr(eventCost(e))}</span></div></div>`;
}

export function recItem(r) {
  return `<div class="rec"><div class="ic">${icon(r.icon)}</div>
    <div class="rec-body"><h4>${esc(r.title)} <span class="prio ${r.priority}">${r.priority}</span></h4><p>${esc(r.detail)}</p>
    ${r.events.length ? `<p class="subtle" style="margin-top:6px">Linked to ${r.events.length} anomal${r.events.length === 1 ? "y" : "ies"}</p>` : ""}</div>
    <div class="save"><b class="num">${inr(r.inr_month)}</b><span>/ month · ${num(r.kwh_month)} kWh</span></div></div>`;
}

export const emptyState = (title, text, action = "", ic = "sparkles") =>
  `<div class="empty"><div class="empty-ic">${icon(ic)}</div><div class="big">${title}</div><p>${text}</p>${action}</div>`;

/** Slim "where does this data come from" bar with a link to dataset management (Settings > Data). */
export function dataSourceLine(utility, info) {
  const what = utility === "water"
    ? (info ? `${info.days} days of water readings · ${fmtDay(info.start)} – ${fmtDay(info.latest_day)}` : "No water readings yet")
    : (info ? `${esc(info.name)} · ${fmtDay(info.start)} – ${fmtDay(info.end)}` : "No electricity dataset yet");
  return `<div class="source-line">${icon("database")}<span>${what}</span>
    <a class="link" data-goto="settings" data-settings-tab="data" data-data-tab="${utility}">Manage ${utility} data ${icon("arrowRight")}</a></div>`;
}

// ---------------- daily limits ----------------
export const UNIT = { electricity: "kWh", water: "L" };
export const fmtUse = (v, utility, waterUnit = "L") => utility === "water"
  ? (waterUnit === "kL" ? `${num(v / 1000, 2)} kL` : `${num(v, 0)} L`) : `${num(v, 1)} kWh`;

/** The limit that applies on a given day (weekday override, else the default). */
export function limitFor(lims, day) {
  if (!lims) return null;
  const wd = (new Date(typeof day === "number" ? day : Date.parse(String(day).slice(0, 10) + "T00:00:00Z")).getUTCDay() + 6) % 7;
  return lims.weekdays?.[wd] ?? lims.weekdays?.[String(wd)] ?? lims.default ?? null;
}

/** Same rules as the backend (limits.status). */
export function limitStatus(used, limit, warn) {
  if (limit == null || used == null) return { used, limit, state: "no_limit" };
  const pct = (used / limit) * 100;
  const state = used > limit * 1.0005 ? "exceeded" : pct >= 99.95 ? "reached" : pct >= warn ? "warning" : "ok";
  return { used, limit, pct, remaining: Math.max(limit - used, 0), excess: Math.max(used - limit, 0), warn_pct: warn, state };
}

const STATE_LABEL = { ok: ["Within limit", "good"], warning: ["Approaching limit", "warn"], reached: ["Limit reached", "danger"], exceeded: ["Over the limit", "danger"] };

/** Progress card for one utility's daily limit. st = limitStatus(...) result. */
export function limitCard({ utility, st, dayLabel, note = "", waterUnit = "L", compact = false }) {
  const label = utility === "water" ? "Water" : "Electricity";
  if (st.state === "no_limit") {
    return `<div class="card limit-card none reveal"><div class="card-h"><div><h3>${label} daily limit</h3><p>No limit set. Set one to track your daily allowance and get warnings.</p></div>
      <span class="lc-ic ${utility}">${icon(utility === "water" ? "droplet" : "zap")}</span></div>
      <form class="inline quick-limit" data-limit-form="${utility}">
        <label class="field inline-field" style="margin:0"><span>Daily limit (${UNIT[utility]})</span>
        <input type="number" name="limit" min="0.1" step="${utility === "water" ? 10 : 0.5}" required style="width:120px" placeholder="${utility === "water" ? "e.g. 600" : "e.g. 12"}"></label>
        <button class="btn primary sm" type="submit">${icon("check")}Set limit</button></form>
      ${dayLabel ? `<p class="note">Latest reading: ${fmtUse(st.used, utility, waterUnit)} on ${dayLabel}.</p>` : ""}</div>`;
  }
  const [text, tone] = STATE_LABEL[st.state];
  const pct = Math.min(st.pct, 150), warn = st.warn_pct;
  return `<div class="card limit-card ${tone} ${compact ? "compact" : ""} reveal">
    <div class="card-h"><div><h3>${label} today vs limit</h3><p>${dayLabel}${note ? ` · ${note}` : ""}</p></div><span class="limit-chip ${tone}">${icon(tone === "good" ? "checkCircle" : "alert")}${text}</span></div>
    <div class="limit-figs"><div><span>Used</span><b class="num">${fmtUse(st.used, utility, waterUnit)}</b></div>
      <div><span>Daily limit</span><b class="num">${fmtUse(st.limit, utility, waterUnit)}</b></div>
      <div>${st.excess > 0 ? `<span>Over by</span><b class="num red-text">${fmtUse(st.excess, utility, waterUnit)}</b>` : `<span>Remaining</span><b class="num">${fmtUse(st.remaining, utility, waterUnit)}</b>`}</div></div>
    <div class="limit-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(st.pct)}" aria-label="${label} use as a share of the daily limit">
      <div class="lb-track"><span class="lb-fill ${tone}" style="--w:${(pct / 150) * 100}%"></span>
        <i class="lb-mark" style="left:${(warn / 150) * 100}%" title="Warning at ${warn}%"></i><i class="lb-mark full" style="left:${(100 / 150) * 100}%" title="Limit"></i></div>
      <div class="lb-scale"><span>0</span><span style="left:${(warn / 150) * 100}%">${warn}%</span><span style="left:${(100 / 150) * 100}%">100%</span></div>
    </div>
    <div class="limit-foot"><b class="num">${num(st.pct, 0)}%</b> of today's allowance used <a data-goto="settings" data-settings-tab="${utility}" class="link">Edit limit</a></div></div>`;
}

/** Wire the inline "set limit" forms rendered by limitCard. */
export function bindLimitForms(root, onSaved) {
  root.querySelectorAll("[data-limit-form]").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { put } = await import("./store.js");
    const { toast } = await import("./ui.js");
    try {
      await put(`/api/limits/${f.dataset.limitForm}`, { default: +f.elements.limit.value, weekdays: {} });
      toast("Daily limit saved", "success");
      onSaved?.();
    } catch (err) { toast(err.message, "error"); }
  }));
}

export const skeleton = () => `
  <div class="grid g4">${'<div class="card skel-card"><div class="skel w40"></div><div class="skel h28 w60"></div><div class="skel w80"></div></div>'.repeat(4)}</div>
  <div class="grid g-main mt"><div class="card"><div class="skel w30"></div><div class="skel chart-skel"></div></div>
    <div class="card"><div class="skel w40"></div>${'<div class="skel h48"></div>'.repeat(4)}</div></div>`;
