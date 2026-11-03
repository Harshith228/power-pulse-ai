// Savings recommendations with persistent checklists - used by Electricity and Water "Savings & Cost".
// Electricity checklists are saved per dataset; water checklists under the id "water".
import { put } from "../store.js";
import { icon } from "../icons.js";
import { esc, inr, num } from "../format.js";
import { toast } from "../ui.js";
import { emptyState } from "../components.js";

const done = (r) => r.steps.length && r.done.length === r.steps.length;

export function recommendationsSection(recs, { utility, filter = "all" }) {
  const shown = recs.filter((r) => filter === "all" || (filter === "done" ? done(r) : !done(r)));
  const amount = (r) => utility === "water" ? `${num(r.litres_month, 0)} L` : `${num(r.kwh_month)} kWh`;
  const linked = (r) => r.events.length ? `<span class="tag">${r.events.length} linked event${r.events.length === 1 ? "" : "s"}</span>`
    : `<span class="tag">${utility === "water" ? "Everyday use" : "Always-on load"}</span>`;
  return `
    <div class="filters"><div class="seg" role="group" aria-label="Show">${[["all", "All actions"], ["todo", "To do"], ["done", "Completed"]]
      .map(([v, l]) => `<button data-recf="${v}" class="${filter === v ? "on" : ""}" aria-pressed="${filter === v}">${l}</button>`).join("")}</div>
      <span class="subtle count-note">${recs.filter(done).length} of ${recs.length} completed · progress is saved to your account</span></div>
    <div class="rec-grid">${shown.map((r) => {
      const pct = r.steps.length ? Math.round((r.done.length / r.steps.length) * 100) : 0;
      return `<article class="card rec-card ${done(r) ? "complete" : ""} reveal" data-key="${r.key}">
        <div class="rc-h"><span class="rc-ic ${utility}">${icon(r.icon)}</span><div class="rc-t"><h3>${esc(r.title)}</h3>
          <div class="inline"><span class="prio ${r.priority}">${r.priority} priority</span>${linked(r)}</div></div>
          <div class="rc-save"><b class="num">${inr(r.inr_month)}</b><span>/ month · ${amount(r)}</span></div></div>
        <p class="rc-d">${esc(r.detail)}</p>
        <div class="rc-progress"><span style="width:${pct}%"></span></div><p class="note" style="margin-top:6px">${r.done.length} of ${r.steps.length} steps done</p>
        <ul class="checklist">${r.steps.map((s, i) => `<li><label><input type="checkbox" data-step="${i}" ${r.done.includes(i) ? "checked" : ""}><span>${esc(s)}</span></label></li>`).join("")}</ul>
        <p class="note">Estimate assumes ${esc(r.assumption)}, priced at your marginal tariff rate.</p>
      </article>`;
    }).join("") || `<div class="card">${emptyState(filter === "done" ? "Nothing completed yet" : "All done", filter === "done" ? "Tick checklist steps as you go." : "Every action is complete.", "", "checkCircle")}</div>`}</div>`;
}

/** Wire checklist ticks and the filter. checklistId = electricity dataset id, or "water". */
export function bindRecommendations(root, recs, { checklistId, onFilter }) {
  root.querySelectorAll("[data-recf]").forEach((b) => b.addEventListener("click", () => onFilter(b.dataset.recf)));
  root.querySelectorAll(".rec-card").forEach((card) => card.addEventListener("change", async (e) => {
    if (!e.target.matches("[data-step]")) return;
    const r = recs.find((x) => x.key === card.dataset.key);
    const steps = [...card.querySelectorAll("[data-step]:checked")].map((x) => +x.dataset.step);
    try {
      r.done = (await put("/api/checklists", { dataset_id: checklistId, key: r.key, done: steps })).done;
      card.querySelector(".rc-progress span").style.width = Math.round((r.done.length / r.steps.length) * 100) + "%";
      card.querySelector(".rc-progress + .note").textContent = `${r.done.length} of ${r.steps.length} steps done`;
      card.classList.toggle("complete", r.done.length === r.steps.length);
      if (r.done.length === r.steps.length) toast(`“${r.title}” completed`, "success");
    } catch (err) { toast(err.message, "error"); e.target.checked = !e.target.checked; }
  }));
}
