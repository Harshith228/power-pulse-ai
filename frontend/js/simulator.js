// What-if savings simulator, shared by Electricity and Water. Each utility supplies its own levers and maths;
// the bill is always computed with that utility's own slab tariff (kWh or kL).
import { inr, num } from "./format.js";
import { cardHead } from "./components.js";

/** levers: [{id, label, help, min, max, step, value, show(v)}]; unit: "kWh" | "L" */
export function simulatorCard({ title, help, levers, note }) {
  return `<div class="card mt reveal sim">${cardHead(title, help)}
    <div class="sim-grid">
      <div class="sim-controls">${levers.map((l) => `<label class="sim-row"><span><b>${l.label}</b><small>${l.help}</small></span>
        <input type="range" id="sim-${l.id}" min="${l.min}" max="${l.max}" step="${l.step}" value="${l.value}" aria-label="${l.label}"><output id="sim-${l.id}-o"></output></label>`).join("")}</div>
      <div class="sim-out" aria-live="polite">
        <div><span>Typical month now</span><b class="num" data-o="now"></b><small data-o="nowu"></small></div>
        <div><span>With these changes</span><b class="num" data-o="new"></b><small data-o="newu"></small></div>
        <div class="save"><span>You would save</span><b class="num" data-o="save"></b><small data-o="year"></small></div>
      </div>
    </div><p class="note">${note}</p></div>`;
}

/** compute(values) -> {base, after} in usage units; bill(units) -> rupees; fmt(units) -> label */
export function bindSimulator(root, { levers, compute, bill, fmt }) {
  const $ = (s) => root.querySelector(s);
  const upd = () => {
    const vals = Object.fromEntries(levers.map((l) => [l.id, +$(`#sim-${l.id}`).value]));
    levers.forEach((l) => { $(`#sim-${l.id}-o`).textContent = l.show(vals[l.id]); });
    const { base, after } = compute(vals);
    const now = bill(base), nb = bill(after);
    $("[data-o=now]").textContent = inr(now); $("[data-o=nowu]").textContent = fmt(base);
    $("[data-o=new]").textContent = inr(nb); $("[data-o=newu]").textContent = fmt(after);
    $("[data-o=save]").textContent = `${inr(now - nb)} / month`;
    $("[data-o=year]").textContent = `${inr((now - nb) * 12)} a year · ${fmt(base - after)} less`;
  };
  levers.forEach((l) => $(`#sim-${l.id}`).addEventListener("input", upd));
  upd();
}

export const pctShow = (sign = "−") => (v) => `${sign}${v}%`;
export { num };
