// Daily Consumption Limit page - one implementation for both utilities, driven by /api/limits/{utility}/history.
// Sections: 1 overview (limit, today, remaining, % used, status) · 2 progress + period statistics · 3 daily history
// with the days over the limit · 4 limit configuration. Every figure comes from the user's own data.
import * as charts from "../charts.js";
import { state, api } from "../store.js";
import { icon } from "../icons.js";
import { fmtDay, num } from "../format.js";
import { cardHead, emptyState, fmtUse } from "../components.js";
import { limitsForm, bindLimitsForm } from "../forms.js";

const STATUS = { ok: ["Within limit", "good", "checkCircle"], warning: ["Approaching limit", "warn", "alert"], reached: ["Limit reached", "danger", "alert"],
  exceeded: ["Over the limit", "danger", "alert"], no_limit: ["No limit set", "", "info"] };

const tile = (label, value, foot = "", tone = "") =>
  `<div class="lim-tile ${tone}"><span>${label}</span><b class="num">${value}</b>${foot ? `<small>${foot}</small>` : ""}</div>`;

/** Large progress bar: usage against the limit with the warning threshold and the limit marked. */
function progress(st, warn, utility, fmt) {
  const pct = Math.min(st.pct, 150), tone = STATUS[st.state][1];
  return `<div class="limit-bar big" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(st.pct)}"
      aria-label="${utility === "water" ? "Water" : "Electricity"} use as a share of the daily limit">
    <div class="lb-track"><span class="lb-fill ${tone}" style="--w:${(pct / 150) * 100}%"></span>
      <i class="lb-mark" style="left:${(warn / 150) * 100}%"></i><i class="lb-mark full" style="left:${(100 / 150) * 100}%"></i></div>
    <div class="lb-scale"><span>0</span><span style="left:${(warn / 150) * 100}%">Warning ${warn}%</span><span style="left:${(100 / 150) * 100}%">Limit</span></div>
  </div>
  <div class="lb-legend"><span><i class="sw used ${tone}"></i>${fmt(st.used)} used</span>
    <span><i class="sw warnm"></i>warning at ${fmt(st.limit * warn / 100)}</span><span><i class="sw limm"></i>limit ${fmt(st.limit)}</span></div>`;
}

export const limitPage = (utility) => async function limit(el, ctx) {
  const days = state.limitDays || 90;
  const h = await api(`/api/limits/${utility}/history?days=${days}`);
  // the form must show what the server has now (limits may have changed in another tab or page)
  state.cfg.limits[utility] = h.limits;
  Object.assign(state.cfg.settings[utility], { warn_pct: h.warn_pct, notify_limits: h.notify });
  const wu = utility === "water" ? state.cfg.settings.water.unit : "kWh";
  const fmt = (v) => fmtUse(v, utility, wu);
  const label = utility === "water" ? "water" : "electricity", Label = utility === "water" ? "Water" : "Electricity";
  const config = `<div class="card mt reveal" id="lim-config">${cardHead("Limit configuration", utility === "water" ? `Daily water limit in litres or kL (shown in ${wu}) and when to warn you` : "Daily electricity limit in kWh and when to warn you")}
    ${limitsForm(utility, { wide: true })}</div>`;
  const bind = () => bindLimitsForm(el, utility, () => { ctx.refreshNotifications(); ctx.rerender([ctx.state.view, "overview"]); });
  if (!h.has_data) {
    el.innerHTML = `<div class="card">${emptyState(`No ${label} data yet`, `Add ${label} data to track it against your daily limit. You can set the limit now.`,
      `<button class="btn primary" data-goto="${utility}/analytics">${icon("plus")}Add ${label} data</button>`, utility === "water" ? "droplet" : "zap")}</div>${config}`;
    bind();
    return;
  }
  const st = h.stats, latest = h.latest, today = new Date().toISOString().slice(0, 10);
  const div = utility === "water" && wu === "kL" ? 1000 : 1;
  const noLimit = latest.state === "no_limit";
  const [statusText, statusTone, statusIc] = STATUS[latest.state];
  const dayLabel = h.latest_day === today ? "Today" : `Latest day in data · ${fmtDay(h.latest_day)}`;
  el.innerHTML = `
    <section class="lim-overview stagger" aria-label="Daily limit overview">
      ${tile("Daily limit", noLimit ? "Not set" : fmt(latest.limit), noLimit ? "set one below" : "applies to this day")}
      ${tile(h.latest_day === today ? "Used today" : "Used on the latest day", fmt(latest.used), dayLabel)}
      ${noLimit ? tile("Remaining", "–") : latest.excess > 0 ? tile("Over by", fmt(latest.excess), "above the limit", "danger") : tile("Remaining", fmt(latest.remaining), "left in the allowance")}
      ${tile("Limit used", noLimit ? "–" : `${num(latest.pct, 0)}%`, noLimit ? "" : `warning at ${h.warn_pct}%`, statusTone)}
      <div class="lim-tile status ${statusTone}"><span>Status</span><b>${icon(statusIc)}${statusText}</b><small>${dayLabel}</small></div>
    </section>
    <div class="grid lim-main mt">
      <div class="card reveal">${cardHead(`${Label} use vs limit`, dayLabel)}
        ${noLimit ? emptyState("No daily limit yet", "Set a limit in Limit configuration below to see your progress against it.", '<a class="btn primary sm" href="#lim-config">Set a limit</a>', "gauge")
          : progress(latest, h.warn_pct, utility, fmt)}</div>
      <div class="card reveal">${cardHead("This period", `Last ${days} days of data`)}
        <div class="lim-stats">
          ${tile("Days over the limit", `${st.days_over}<small> of ${st.days_with_limit}</small>`, `${st.month_over} this month`, st.days_over ? "danger" : "")}
          ${tile("Average use vs limit", st.avg_pct == null ? "–" : `${num(st.avg_pct, 0)}%`, `${st.days_warning} day${st.days_warning === 1 ? "" : "s"} in the warning zone`, st.avg_pct > 100 ? "danger" : "")}
          ${tile("Days in a row within", String(st.streak_within), "most recent streak", st.streak_within ? "good" : "")}
          ${tile("Total over the limit", fmt(st.total_excess), st.worst ? `worst ${fmt(st.worst.excess)} on ${fmtDay(st.worst.day)}` : "no excess", st.total_excess ? "danger" : "")}
        </div></div>
    </div>
    <div class="card mt reveal">${cardHead(`Daily ${label} history`, `Each day against the limit that applied · red = over the limit${noLimit ? " · no limit set yet" : ""}`,
      `<div class="seg" role="group" aria-label="Period">${[30, 90, 365].map((d) => `<button data-days="${d}" class="${days === d ? "on" : ""}" aria-pressed="${days === d}">${d === 365 ? "1Y" : d + "D"}</button>`).join("")}</div>`)}
      <div class="chart" id="ch-limit" role="img" aria-label="Daily ${label} use against the daily limit"></div>
      ${h.violations.length ? `<div class="section-title">${icon("alert")} ${h.violations.length} day${h.violations.length === 1 ? "" : "s"} over the limit</div>
        <div class="table-wrap" style="max-height:300px"><table class="mini"><thead><tr><th>Day</th><th class="n">Used</th><th class="n">Limit</th><th class="n">Over by</th><th class="n">% of limit</th></tr></thead><tbody>
        ${h.violations.map((v) => `<tr><td>${fmtDay(v.day)}</td><td class="n num">${fmt(v.used)}</td><td class="n num">${fmt(v.limit)}</td>
          <td class="n num red-text">${fmt(v.excess)}</td><td class="n num">${num((v.used / v.limit) * 100, 0)}%</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="note lim-none">${icon(noLimit ? "info" : "checkCircle")}${noLimit ? "Set a daily limit to see which days go over it." : `No day went over the limit in the last ${days} days of data.`}</p>`}
    </div>
    ${config}`;
  charts.utilityDailyChart(el.querySelector("#ch-limit"), h.daily, { utility, unit: wu, div });
  el.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => { state.limitDays = +b.dataset.days; ctx.rerender([ctx.state.view]); }));
  bind();
};
