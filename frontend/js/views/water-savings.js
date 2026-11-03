// Water > Savings & Cost: water bills (kL tariff), anomaly cost, what-if simulator and water recommendations.
import * as charts from "../charts.js";
import { state } from "../store.js";
import { icon } from "../icons.js";
import { num } from "../format.js";
import { kpiCard, countSpan, cardHead, emptyState } from "../components.js";
import { tariffEditor, bindTariff, slabBill } from "../forms.js";
import { simulatorCard, bindSimulator } from "../simulator.js";
import { recommendationsSection, bindRecommendations } from "./recommendations.js";
import { waterSummary } from "./water-analytics.js";

export default async function waterSavings(el, ctx) {
  const s = await waterSummary();
  const tariffCard = `<div class="card reveal">${cardHead("Water tariff (INR per kL)", "Match your municipal / society bill. Slabs are monthly kilolitres.")}${tariffEditor("water")}</div>`;
  if (!s.has_data) {
    el.innerHTML = `<div class="grid g-main"><div class="card">${emptyState("No water data yet", "Add water readings to estimate bills and savings.",
      `<button class="btn primary" data-goto="water/analytics">${icon("droplet")}Go to Water Usage</button>`, "droplet")}</div>${tariffCard}</div>`;
    bindTariff(el, "water", () => ctx.rerender([ctx.state.view]));
    return;
  }
  const t = s.tariff, typicalL = s.cost.typical_month_litres, months = s.monthly_costs;
  const last12 = months.slice(-12), anomalyMonth = last12.length ? last12.reduce((a, m) => a + m.avoidable_inr, 0) / last12.length : 0;
  const leak = s.recommendations.find((r) => r.key === "leak");
  const eventL = s.recommendations.filter((r) => !["leak", "fixtures"].includes(r.key)).reduce((a, r) => a + r.litres_month, 0) / 0.8;
  const levers = [
    { id: "l", label: "Fix leaks", help: leak ? `${num(leak.litres_month, 0)} L/month measured leak flow` : "no leak detected", min: 0, max: 100, step: 5, value: leak ? 100 : 0, show: (v) => `${v}%` },
    { id: "a", label: "Avoid unusual-use days", help: `${num(eventL, 0)} L/month in spikes and rises`, min: 0, max: 100, step: 5, value: 80, show: (v) => `${v}%` },
    { id: "r", label: "Reduce everyday use", help: "aerators, shorter showers, full loads", min: 0, max: 30, step: 1, value: 10, show: (v) => `−${v}%` },
  ];
  el.innerHTML = `
    <div class="grid g4 stagger">
      ${kpiCard({ label: "Typical monthly water bill", ic: "wallet", value: countSpan(s.cost.typical_month, { prefix: "₹" }), foot: `for <b>${num(typicalL / 1000, 1)} kL</b>/month` })}
      ${kpiCard({ label: "Effective rate", ic: "rupee", value: countSpan(s.effective_rate, { prefix: "₹", dec: 2 }), unit: "/ kL", foot: `marginal slab <b>₹${s.marginal_rate}</b>/kL` })}
      ${kpiCard({ label: "Cost of unusual use", ic: "alert", value: countSpan(anomalyMonth, { prefix: "₹" }), unit: "/ month", tone: "danger",
        foot: `<b>${num(s.anomaly_litres_total, 0)} L</b> above normal in all detected events`, tip: "Average avoidable cost per month over the last 12 months, 80% of the excess assumed avoidable" })}
      ${kpiCard({ label: "Potential savings", ic: "piggy", value: countSpan(s.potential_savings_month, { prefix: "₹" }), unit: "/ month", tone: "accent",
        foot: `<span class="good-text">${num(s.potential_litres_month, 0)} L/month</span> if every action is taken` })}
    </div>
    <div class="grid g-main mt">
      <div class="card reveal">${cardHead("Monthly water bill", "Orange = cost of unusual consumption · partial months cover recorded days only")}
        <div class="chart hero" id="ch-wbill" role="img" aria-label="Monthly water bill with avoidable portion"></div></div>
      ${tariffCard}
    </div>
    ${simulatorCard({ title: "What-if water savings simulator", help: "See how your typical monthly water bill would change. Uses your water tariff and this home's numbers.", levers,
      note: "Estimate: monthly litres = typical month − fixed leak flow − avoided unusual-use water − the everyday reduction, billed per kL with your slab tariff." })}
    <div class="section-title">Recommended actions</div>
    <div id="recs">${recommendationsSection(s.recommendations, { utility: "water", filter: state.wRecFilter || "all" })}</div>`;
  charts.monthlyChart(el.querySelector("#ch-wbill"), null, { months: months.map((m) => ({ ...m })), usage: "kl", unit: "kL", usageLabel: "Water" });
  bindTariff(el, "water", () => ctx.rerender([ctx.state.view]));
  bindSimulator(el, {
    levers, bill: (litres) => slabBill(litres / 1000, t), fmt: (litres) => `${num(litres, 0)} L`,
    compute: (v) => ({ base: typicalL, after: Math.max(0, typicalL - ((leak?.litres_month || 0) * v.l) / 100 - (eventL * v.a) / 100 - (typicalL * v.r) / 100) }),
  });
  bindRecommendations(el, s.recommendations, { checklistId: "water", onFilter: (f) => { state.wRecFilter = f; ctx.rerender([ctx.state.view]); } });
}
