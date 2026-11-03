import * as charts from "../charts.js";
import { state } from "../store.js";
import { icon } from "../icons.js";
import { esc, fmtTime, pct } from "../format.js";
import { prefs } from "../ui.js";
import { TYPE_LABEL, kpiCard, cardHead, emptyState } from "../components.js";

export default function lab(el, ctx) {
  const sc = state.sources?.scenarios ?? {};
  const v = state.res?.validation, d = state.res?.dataset;
  el.innerHTML = `
    <div class="card reveal">${cardHead("Synthetic anomaly scenarios", "Plant known anomalies into normal consumption, then check the detector finds them – and nothing else.", '<span class="tag demo">Demo data</span>')}
      <div class="scen" role="radiogroup" aria-label="Scenario">${Object.entries(sc).map(([k, desc]) => `<button role="radio" aria-checked="${state.scenario === k}" data-sc="${k}" class="${state.scenario === k ? "on" : ""}"><b>${k}</b><span>${esc(desc)}</span></button>`).join("")
        || '<p class="subtle">Scenarios load once the server responds.</p>'}</div>
      <div class="inline lab-controls">
        <div class="seg" id="base" role="group" aria-label="Base household"><button data-v="synthetic" class="${state.base === "synthetic" ? "on" : ""}">Synthetic Indian household</button>
          <button data-v="uci" class="${state.base === "uci" ? "on" : ""}" ${state.sources?.uci_available ? "" : "disabled"}>Real UCI home (last 120 days)</button></div>
        <label class="field inline-field"><span>Random seed</span><input type="number" id="seed" value="${state.seed}" min="0" max="9999" style="width:90px"></label>
        <button class="btn primary" id="run">${icon("play")}Run scenario</button>
      </div></div>
    ${v ? `
    <div class="grid g4 mt stagger">
      ${kpiCard({ label: "Injected anomalies found", ic: "target", value: pct(v.segment_recall), tone: v.segment_recall === 1 ? "good" : "", foot: `<b>${v.segments.filter((s) => s.detected).length} of ${v.segments.length}</b> injected segments detected` })}
      ${kpiCard({ label: "Alert precision", ic: "shield", value: v.event_precision == null ? "–" : pct(v.event_precision), foot: "share of alerts that overlap an injected anomaly" })}
      ${kpiCard({ label: "Natural anomalies", ic: "leaf", value: String(v.natural_events), foot: d.base === "uci" ? "real events in the underlying home, not injected" : "alerts not caused by an injection" })}
      ${kpiCard({ label: "Hour-level recall", ic: "clock", value: pct(v.hour_recall), foot: `hour precision ${v.hour_precision == null ? "–" : pct(v.hour_precision)}` })}
    </div>
    <div class="card mt reveal">${cardHead(esc(d.name), esc(d.description || ""))}
      <div class="chart tall" id="ch-lab" role="img" aria-label="Validation run: consumption with injected and detected anomalies"></div>
      <div class="legend-note"><span><i style="background:rgba(91,75,196,.35)"></i>Injected anomaly (ground truth)</span>
        <span><i style="background:var(--critical);border-radius:50%"></i>Detected anomaly peak (colour = severity)</span>
        <span><i style="background:rgba(220,38,38,.15)"></i>Detected sustained period</span></div></div>
    <div class="grid g2 mt">
      <div class="card flush reveal"><div class="pad">${cardHead("Detection by anomaly type")}</div>
        <div class="table-wrap"><table><thead><tr><th>Injected type</th><th class="n">Segments</th><th class="n">Detected</th><th class="n">Recall</th></tr></thead><tbody>
        ${Object.entries(v.by_type).map(([t, x]) => `<tr><td>${TYPE_LABEL[t] ?? esc(t)}</td><td class="n">${x.segments}</td><td class="n">${x.detected}</td><td class="n ${x.detected === x.segments ? "ok" : "miss"}"><b>${pct(x.detected / x.segments)}</b></td></tr>`).join("")}
        </tbody></table></div></div>
      <div class="card flush reveal"><div class="pad">${cardHead("Injected segments", "Each planted anomaly and the alert that caught it")}</div>
        <div class="table-wrap" style="max-height:320px"><table><thead><tr><th>Type</th><th>Start</th><th class="n">Hours</th><th>Result</th></tr></thead><tbody>
        ${v.segments.map((s) => `<tr><td>${TYPE_LABEL[s.type] ?? esc(s.type)}</td><td class="subtle">${fmtTime(s.start)}</td><td class="n">${s.hours}</td>
          <td>${s.detected ? `<a data-event="${s.matched_event}" class="ok" tabindex="0">${icon("check")} Alert #${s.matched_event} (${s.matched_type})</a>` : '<span class="miss">Missed</span>'}</td></tr>`).join("")}
        </tbody></table></div></div>
    </div>` : `<div class="card mt">${emptyState("No ground truth in the active dataset", "Run a scenario above to measure detection accuracy. Natural datasets (uploads, UCI) have no labels, so their anomalies are shown as observed.", "", "flask")}</div>`}`;
  el.querySelectorAll("[data-sc]").forEach((b) => b.addEventListener("click", () => {
    state.scenario = b.dataset.sc;
    el.querySelectorAll("[data-sc]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
  }));
  el.querySelectorAll("#base button").forEach((b) => b.addEventListener("click", () => {
    state.base = b.dataset.v;
    el.querySelectorAll("#base button").forEach((x) => x.classList.toggle("on", x === b));
  }));
  el.querySelector("#run").addEventListener("click", () => {
    state.seed = +el.querySelector("#seed").value || 0;
    ctx.runScenario();
  });
  if (v) charts.consumptionChart(el.querySelector("#ch-lab"), state.res, { win: null, showInjected: prefs.get("showInjected") !== false, onPick: ctx.openEvent });
}
