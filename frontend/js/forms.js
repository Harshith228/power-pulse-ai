// Reusable forms shared by Settings and the utility pages: daily limits and slab tariffs (kWh or kL).
import { state, put, patch } from "./store.js";
import { icon } from "./icons.js";
import { esc } from "./format.js";
import { toast } from "./ui.js";

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const switchRow = (id, label, help, on, disabled = false) => `
  <div class="set-row"><div><b id="${id}-l">${label}</b>${help ? `<p>${help}</p>` : ""}</div>
    <button type="button" class="switch" role="switch" id="${id}" aria-checked="${on}" aria-labelledby="${id}-l" ${disabled ? "disabled" : ""}><span></span></button></div>`;

/** Wire a switchRow button. fn(on) runs after the visual state flips. */
export function bindSwitch(root, id, fn) {
  root.querySelector("#" + id)?.addEventListener("click", (e) => {
    const b = e.currentTarget, on = b.getAttribute("aria-checked") !== "true";
    b.setAttribute("aria-checked", String(on));
    fn?.(on);
  });
}

// ---------------- daily limits ----------------
export function limitsForm(util, { wide = false } = {}) {
  const lims = state.cfg.limits[util], s = state.cfg.settings[util];
  const kl = util === "water" && s.unit === "kL";
  const unit = util === "water" ? (kl ? "kL" : "L") : "kWh", step = util === "water" ? (kl ? 0.01 : 10) : 0.5, div = kl ? 1000 : 1;
  const show = (v) => (v == null ? "" : +(v / div).toFixed(3));
  return `<form id="lim-${util}" class="limits-form${wide ? " wide" : ""}" data-div="${div}" data-notify="${s.notify_limits}">
    <div class="lf-col">
    <label class="field"><span>Daily limit (${unit}/day) - every day unless overridden below</span>
      <input type="number" name="default" min="0" step="${step}" value="${show(lims.default)}" placeholder="No limit" style="max-width:200px"></label>
    <details class="more" ${Object.keys(lims.weekdays).length ? "open" : ""}><summary>Different limits for particular days</summary>
      <div class="weekday-grid">${DAYS.map((d, i) => `<label class="field"><span>${d}</span><input type="number" name="wd${i}" min="0" step="${step}" value="${show(lims.weekdays[i])}" placeholder="default"></label>`).join("")}</div></details>
    </div><div class="lf-col">
    <label class="field"><span>Warn me when a day reaches <output id="warn-${util}-o">${s.warn_pct}%</output> of its limit</span>
      <input type="range" name="warn" min="50" max="95" step="5" value="${s.warn_pct}"></label>
    ${switchRow(`notify-${util}`, "Limit notifications", "A warning at the threshold, then a limit-reached alert at 100% showing the excess.", s.notify_limits)}
    </div>
    <div class="inline lf-actions"><button class="btn primary" type="submit">${icon("check")}Save limits</button>
      <button class="btn" type="reset">Cancel</button>
      <button class="btn ghost" type="button" data-clear-limit="${util}">Remove limit</button></div></form>`;
}

export function bindLimitsForm(root, util, onSaved) {
  const f = root.querySelector(`#lim-${util}`);
  if (!f) return;
  const div = +f.dataset.div;
  f.elements.warn.addEventListener("input", (e) => { root.querySelector(`#warn-${util}-o`).textContent = e.target.value + "%"; });
  bindSwitch(root, `notify-${util}`);
  // Cancel: the browser restores the inputs; put the threshold label and the switch back too
  f.addEventListener("reset", () => setTimeout(() => {
    root.querySelector(`#warn-${util}-o`).textContent = f.elements.warn.value + "%";
    root.querySelector(`#notify-${util}`).setAttribute("aria-checked", f.dataset.notify);
    toast("Changes discarded", "info");
  }));
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const weekdays = {};
    DAYS.forEach((_, i) => { const v = f.elements["wd" + i].value; if (v !== "") weekdays[i] = +v * div; });
    const bad = [f.elements.default, ...DAYS.map((_, i) => f.elements["wd" + i])].find((x) => x.value !== "" && !(+x.value >= 0));
    if (bad) { toast("Limits must be numbers of 0 or more.", "error"); bad.focus(); return; }
    try {
      await put(`/api/limits/${util}`, { default: f.elements.default.value === "" ? null : +f.elements.default.value * div, weekdays });
      state.cfg = await patch("/api/settings", { [util]: { warn_pct: +f.elements.warn.value, notify_limits: root.querySelector(`#notify-${util}`).getAttribute("aria-checked") === "true" } });
      toast("Limits saved", "success");
      onSaved?.();
    } catch (err) { toast(err.message, "error"); }
  });
  root.querySelector(`[data-clear-limit="${util}"]`).addEventListener("click", async () => {
    try { state.cfg = await put(`/api/limits/${util}`, { default: null, weekdays: {} }); toast("Limit removed", "success"); onSaved?.(); }
    catch (err) { toast(err.message, "error"); }
  });
}

// ---------------- tariffs ----------------
export function tariffEditor(util) {
  const t = state.cfg.settings[util].tariff, unit = util === "water" ? "kL" : "kWh";
  return `<form class="tariff" id="tariff-${util}">
    <label class="field"><span>Tariff name</span><input type="text" name="tname" value="${esc(t.name)}" maxlength="80"></label>
    <table class="slabs"><thead><tr><th>Slab (monthly ${unit})</th><th>Rate ₹/${unit}</th><th><span class="sr-only">Remove</span></th></tr></thead><tbody>
    ${t.slabs.map((s, i) => `<tr><td>${i === t.slabs.length - 1 ? `<span class="subtle">above ${i ? t.slabs[i - 1].upto : 0}</span><input type="hidden" name="upto" value="">`
      : `<span class="subtle">up to</span> <input type="number" name="upto" min="0.1" step="any" value="${s.upto}" required aria-label="Slab ${i + 1} upper limit">`}</td>
      <td><input type="number" name="rate" min="0" max="100" step="0.01" value="${s.rate}" required aria-label="Slab ${i + 1} rate"></td>
      <td>${t.slabs.length > 1 ? `<button type="button" class="icon-btn sm" data-del-slab="${i}" aria-label="Remove slab ${i + 1}">${icon("x")}</button>` : ""}</td></tr>`).join("")}
    </tbody></table>
    <label class="field inline-field"><span>Fixed charge ₹/month</span><input type="number" name="fixed" min="0" step="1" value="${t.fixed_monthly}" style="width:120px"></label>
    <div class="inline" style="margin-top:14px"><button class="btn primary" type="submit">${icon("check")}Save tariff</button><button class="btn" type="button" data-add-slab>${icon("plus")}Add slab</button>
      <button class="btn ghost" type="button" data-reset-tariff>${icon("refresh")}Default</button></div></form>`;
}

function readTariff(f) {
  const uptos = [...f.querySelectorAll("[name=upto]")].map((i) => i.value), rates = [...f.querySelectorAll("[name=rate]")].map((i) => +i.value);
  return { name: f.elements.tname.value || "Custom tariff", fixed_monthly: +f.elements.fixed.value || 0, slabs: rates.map((r, i) => ({ upto: uptos[i] === "" ? null : +uptos[i], rate: r })) };
}

/** onSaved runs after the tariff is stored (electricity callers re-fetch the analysis, whose costs depend on it). */
export function bindTariff(root, util, onSaved) {
  const tf = root.querySelector(`#tariff-${util}`);
  if (!tf) return;
  const save = async (t) => {
    try { state.cfg = await patch("/api/settings", { [util]: { tariff: t } }); toast("Tariff saved", "success"); onSaved?.(); }
    catch (err) { toast(err.message, "error"); }
  };
  tf.addEventListener("submit", (e) => { e.preventDefault(); save(readTariff(tf)); });
  tf.querySelector("[data-add-slab]").addEventListener("click", () => {
    const t = readTariff(tf), last = t.slabs[t.slabs.length - 1], prev = t.slabs[t.slabs.length - 2]?.upto ?? 0;
    t.slabs.splice(t.slabs.length - 1, 0, { upto: prev + (util === "water" ? 10 : 100), rate: last.rate });
    save(t);
  });
  tf.querySelectorAll("[data-del-slab]").forEach((b) => b.addEventListener("click", () => { const t = readTariff(tf); t.slabs.splice(+b.dataset.delSlab, 1); save(t); }));
  tf.querySelector("[data-reset-tariff]").addEventListener("click", () => save(state.cfg.defaults[`${util}_tariff`]));
}

/** Slab bill, identical to backend advisor.bill (fixed charge + cumulative slabs). units = kWh or kL. */
export function slabBill(units, t) {
  let total = t.fixed_monthly, lower = 0;
  for (const s of t.slabs) {
    const upper = s.upto ?? Infinity;
    if (units > lower) total += (Math.min(units, upper) - lower) * s.rate;
    lower = upper;
  }
  return total;
}
