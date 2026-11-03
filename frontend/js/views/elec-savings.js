// Electricity > Savings & Cost: bill history, tariff, what-if simulator and recommendation checklists.
import * as charts from "../charts.js";
import { state } from "../store.js";
import { inr, num } from "../format.js";
import { kpiCard, countSpan, cardHead } from "../components.js";
import { tariffEditor, bindTariff, slabBill } from "../forms.js";
import { simulatorCard, bindSimulator } from "../simulator.js";
import { recommendationsSection, bindRecommendations } from "./recommendations.js";

export default function elecSavings(el, ctx) {
  const { kpis: k, cost: c, recommendations: recs, tariff: t } = state.res;
  const levers = [
    { id: "a", label: "Fix detected anomalies", help: `${num(c.anomaly_kwh_month)} kWh/month above normal`, min: 0, max: 100, step: 5, value: 80, show: (v) => `${v}%` },
    { id: "w", label: "Cut always-on load", help: `currently ${k.baseload_w} W, all day`, min: 0, max: Math.max(k.baseload_w, 10), step: 10,
      value: Math.round((k.baseload_w * 0.2) / 10) * 10, show: (v) => `−${v} W` },
    { id: "r", label: "Reduce everyday use", help: "e.g. AC set-points, shorter geyser runs", min: 0, max: 30, step: 1, value: 5, show: (v) => `−${v}%` },
  ];
  el.innerHTML = `
    <div class="grid g4 stagger">
      ${kpiCard({ label: "Typical monthly bill", ic: "wallet", value: countSpan(c.typical_month_bill, { prefix: "₹" }), foot: `for <b>${num(c.typical_month_kwh, 0)} kWh</b>/month` })}
      ${kpiCard({ label: "Effective rate", ic: "rupee", value: countSpan(c.effective_rate, { prefix: "₹", dec: 2 }), unit: "/ kWh", foot: `marginal slab <b>₹${c.marginal_rate}</b>/kWh` })}
      ${kpiCard({ label: "Cost of anomalies", ic: "alert", value: countSpan(c.anomaly_inr_month, { prefix: "₹" }), unit: "/ month", tone: "danger",
        foot: `<b>${num(c.anomaly_kwh_month)} kWh</b>/month above normal`, tip: "80% of the anomalous excess is assumed avoidable" })}
      ${kpiCard({ label: "Potential savings", ic: "piggy", value: countSpan(k.potential_savings_month, { prefix: "₹" }), unit: "/ month", tone: "accent",
        foot: `<span class="good-text">${inr(k.potential_savings_year)} a year</span> if all actions are taken` })}
    </div>
    <div class="grid g-main mt">
      <div class="card reveal">${cardHead("Monthly electricity bill", "Orange = cost of anomalous consumption (last 24 months)")}<div class="chart hero" id="ch-month" role="img" aria-label="Monthly bill with avoidable portion"></div></div>
      <div class="card reveal">${cardHead("Electricity tariff (INR)", "Match your DISCOM bill - every cost updates.")}${tariffEditor("electricity")}</div>
    </div>
    ${simulatorCard({ title: "What-if savings simulator", help: "See how your typical monthly electricity bill would change. Uses your tariff and this home's numbers.", levers,
      note: "Estimate: monthly kWh = typical month − fixed anomaly energy − standby watts × 24 h × 30.44 days − the everyday reduction, billed with your slab tariff." })}
    <div class="section-title">Recommended actions</div>
    <div id="recs">${recommendationsSection(recs, { utility: "electricity", filter: state.recFilter || "all" })}</div>`;
  charts.monthlyChart(el.querySelector("#ch-month"), state.res);
  bindTariff(el, "electricity", () => ctx.reloadActive());
  bindSimulator(el, {
    levers, bill: (kwh) => slabBill(kwh, t), fmt: (kwh) => `${num(kwh, 0)} kWh`,
    compute: (v) => { const base = c.typical_month_kwh; return { base, after: Math.max(0, base - (c.anomaly_kwh_month * v.a) / 100 - (v.w * 24 * 30.44) / 1000 - (base * v.r) / 100) }; },
  });
  bindRecommendations(el, recs, { checklistId: state.res.dataset.id, onFilter: (f) => { state.recFilter = f; ctx.rerender([ctx.state.view]); } });
}
