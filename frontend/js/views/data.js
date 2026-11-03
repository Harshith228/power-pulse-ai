// Dataset Management: electricity datasets (validate -> analyse), water records, sample files, smart meters.
import { state, api, post, put, del } from "../store.js";
import { icon } from "../icons.js";
import { esc, fmtDay, fmtTime, num } from "../format.js";
import { toast, openModal, closeModal } from "../ui.js";
import { cardHead, emptyState } from "../components.js";
import { importButton, bindImport } from "../water-import.js";
import { readingsCard, bindReadings } from "../elec-manual.js";

const TABS = [["electricity", "Electricity", "zap"], ["water", "Water", "droplet"], ["samples", "Samples & formats", "file"], ["devices", "Smart meters", "cpu"]];
const SRC = { manual: "Manual", csv: "CSV", device: "Smart meter", demo: "Demo" };

/** Validation report (repo feature): summary, warnings, line-numbered problems and a raw preview. */
export function validationReport(v, name) {
  const issues = v.ok ? v.report.issues : v.issues, counts = v.ok ? v.report.issue_counts : v.issue_counts;
  const preview = v.ok ? v.report.preview : v.preview, cols = v.ok ? v.report.columns : v.columns;
  const head = v.ok
    ? `<div class="alert-box success">${icon("checkCircle")}<span><b>${esc(name)} can be analysed.</b> ${num(v.report.rows_raw, 0)} rows read → ${num(v.report.rows_hourly, 0)} clean hourly readings over ${num(v.report.days, 1)} days (${esc(v.report.interpreted_as)}, every ${esc(v.report.source_interval)}).</span></div>`
    : `<div class="alert-box error">${icon("alert")}<span><b>${esc(name)} can't be analysed.</b> ${esc(v.error)}</span></div>`;
  return `${head}
    ${v.ok && v.report.warnings.length ? `<ul class="warn-list">${v.report.warnings.map((w) => `<li>${icon("info")}<span>${esc(w)}</span></li>`).join("")}</ul>` : ""}
    ${Object.keys(counts || {}).length ? `<div class="section-title">${icon("listChecks")} Problems found (${Object.values(counts).reduce((a, b) => a + b, 0)})</div>
      <div class="issue-counts">${Object.entries(counts).map(([k, n]) => `<span class="tag">${n} × ${esc(k)}</span>`).join("")}</div>
      <div class="table-wrap" style="max-height:220px"><table class="mini"><thead><tr><th class="n">Line</th><th>Field</th><th>Problem</th><th>Value</th></tr></thead><tbody>
        ${issues.map((i) => `<tr><td class="n num">${i.line}</td><td>${i.field}</td><td>${esc(i.problem)}</td><td><code>${esc(i.value) || "(empty)"}</code></td></tr>`).join("")}</tbody></table></div>` : ""}
    ${preview?.length ? `<div class="section-title">${icon("table")} First rows of the file</div>
      <div class="table-wrap" style="max-height:220px"><table class="mini"><thead><tr><th class="n">Line</th>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
        ${preview.map((r, i) => `<tr><td class="n num">${i + 2}</td>${r.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : ""}`;
}

async function validateAndConfirm(file, ctx) {
  const fd = new FormData();
  fd.append("file", file);
  let v;
  try { v = await api("/api/datasets/validate", { method: "POST", body: fd }); } catch (e) { toast(e.message, "error"); return; }
  openModal({
    title: `Check ${file.name}`, wide: true,
    body: `${validationReport(v, file.name)}
      <div class="inline" style="margin-top:16px;justify-content:flex-end">
        <button class="btn" data-modal-close>Cancel</button>
        ${v.ok ? `<button class="btn primary" id="go-analyse">${icon("scan")}Analyse this file</button>` : ""}</div>`,
    onMount: (w) => w.querySelector("#go-analyse")?.addEventListener("click", () => { closeModal(); ctx.uploadFile(file); }),
  });
}

// ---------------- tabs ----------------
async function electricityTab() {
  const [list, readings] = await Promise.all([api("/api/datasets"), api(`/api/electricity/readings?limit=${state.erLimit || 25}`)]);
  const d = state.res?.dataset, m = state.res?.model;
  const checks = d && d.source !== "scenario" ? [
    ["Raw rows read", d.rows_raw], ["Hourly readings after cleaning", d.rows_hourly], ["Consumption column", d.value_column],
    ["Interpreted as", d.interpreted_as], ["Source interval", d.source_interval], ["Unparseable timestamps dropped", d.unparseable_timestamps],
    ["Duplicate timestamps merged", d.duplicate_timestamps], ["Negative readings removed", d.negative_values_removed],
    ["Impossible values removed (> 60 kWh/h)", d.outliers_removed], ["Short gaps interpolated (≤ 3 h)", d.short_gaps_interpolated],
    ["Long-gap hours excluded", d.long_gap_hours_dropped], ["Circuits / sub-meters", d.circuits.length ? d.circuits.length : "none"],
  ] : null;
  return `
    <div class="card flush reveal"><div class="pad">${cardHead("Your electricity datasets", `${list.length} of 10 · the active one feeds every electricity page, limit and report`)}</div>
      ${list.length ? `<div class="table-wrap"><table class="ds-table"><thead><tr><th>Dataset</th><th>Source</th><th>Period</th><th class="n">Days</th><th>Added</th><th></th></tr></thead><tbody>
        ${list.map((x) => `<tr class="${x.active ? "sel" : ""}"><td data-l="Dataset"><b>${esc(x.name)}</b> ${x.active ? '<span class="tag good">Active</span>' : ""}</td>
          <td data-l="Source">${x.has_ground_truth ? '<span class="tag injected">Validation</span>' : x.source === "public" ? '<span class="tag blue">Public</span>' : `<span class="tag">${x.source === "upload" ? "Upload" : esc(x.source)}</span>`}</td>
          <td data-l="Period" class="subtle">${x.start ? `${fmtDay(x.start)} – ${fmtDay(x.end)}` : "–"}</td><td class="n" data-l="Days">${num(x.days ?? 0, 0)}</td>
          <td data-l="Added" class="subtle">${fmtDay(x.created_at)}</td>
          <td class="row-actions">${x.active ? "" : `<button class="btn sm" data-activate="${x.id}">${icon("check")}Make active</button>`}
            <a class="btn sm ghost" href="/api/datasets/${x.id}/data.csv" aria-label="Download cleaned data">${icon("download")}</a>
            <button class="btn sm ghost" data-del-ds="${x.id}" data-name="${esc(x.name)}" aria-label="Delete dataset">${icon("trash")}</button></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="pad">${emptyState("No electricity datasets", "Upload one below or analyse the public UCI dataset.", "", "zap")}</div>`}</div>
    <div class="mt">${readingsCard(readings)}</div>
    <div class="grid g2 mt">
      <div class="card reveal">${cardHead("Upload meter data", "CSV export from a smart meter, DISCOM portal or energy monitor. Files are checked first; nothing is saved until you choose Analyse.")}
        <label class="drop" id="drop" tabindex="0"><input type="file" id="file" accept=".csv,.txt" hidden>
          <div class="ic">${icon("cloudUpload")}</div><h4>Drop a CSV here or click to browse</h4><p>Hourly or finer readings · at least 14 days · up to 60 MB</p></label>
        <div class="inline" style="margin-top:12px"><button class="btn sm" id="tpl">${icon("download")}Download template</button><span class="subtle">Template values are random demo data.</span></div></div>
      <div class="card source reveal">${cardHead("Public dataset & scenarios", "UCI Machine Learning Repository", `<span class="tag blue">${icon("globe")}CC BY 4.0</span>`)}
        <h4>Individual Household Electric Power Consumption</h4>
        <p>2,075,259 one-minute readings from a single home near Paris (Dec 2006 – Nov 2010), with three sub-meters. Resampled to ${num(34589, 0)} hourly readings.</p>
        <p class="subtle">Hebrail, G. &amp; Berard, A. (2006). UCI ML Repository. doi:10.24432/C58K54</p>
        <div class="inline"><button class="btn primary" id="load-uci" ${state.sources?.uci_available ? "" : "disabled"}>${icon("database")}Analyse UCI household</button>
          <button class="btn" data-goto="lab">${icon("flask")}Validation scenarios</button></div></div>
    </div>
    ${d ? `<div class="grid g2 mt">
      <div class="card reveal">${cardHead("Data quality report", esc(d.name), `<span class="tag good">${icon("check")}validated</span>`)}
        ${checks ? `<div class="checks">${checks.map(([a, b]) => `<div>${a}</div><div>${esc(b)}</div>`).join("")}</div>
          ${d.issues?.length ? `<details class="more"><summary>${d.issues_total} row-level problem${d.issues_total === 1 ? "" : "s"} in the source file</summary>
            <div class="table-wrap" style="max-height:220px"><table class="mini"><thead><tr><th class="n">Line</th><th>Problem</th><th>Value</th></tr></thead><tbody>
            ${d.issues.map((i) => `<tr><td class="n">${i.line}</td><td>${esc(i.problem)}</td><td><code>${esc(i.value) || "(empty)"}</code></td></tr>`).join("")}</tbody></table></div></details>` : ""}`
          : `<p class="subtle">Generated scenario: ${num(d.rows_hourly, 0)} clean hourly readings, ${d.circuits.length} circuits, ground-truth labels included.</p>`}</div>
      <div class="card reveal">${cardHead("How detection works", "Statistical baseline + Isolation Forest + event rules", '<a class="link" data-goto="settings" data-settings-tab="detection">Tune thresholds</a>')}
        <dl class="model"><dt>1 · Robust baseline</dt><dd>${esc(m.baseline)}. First ${m.warmup_days} days are warm-up.</dd>
          <dt>2 · Isolation Forest</dt><dd>${esc(m.isolation_forest)}</dd>
          <dt>3 · Sudden spike</dt><dd>${esc(m.spike_rule)}</dd>
          <dt>4 · Sustained increase</dt><dd>${esc(m.sustained_rule)}</dd>
          <dt>5 · Repeated pattern</dt><dd>${esc(m.repeated_rule)}</dd>
          <dt>6 · Night-time increase</dt><dd>${esc(m.night_rule)}</dd></dl></div>
    </div>` : ""}`;
}

async function waterTab() {
  const page = state.waterPage || 0, limit = 25;
  const r = await api(`/api/water/readings?limit=${limit}&offset=${page * limit}`);
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="grid g2">
      <div class="card reveal">${cardHead("Add a daily reading", "Totals in litres or kilolitres - stored internally in litres.")}
        <form class="entry-form" id="w-entry">
          <label class="field"><span>Date</span><input type="date" name="date" max="${today}" value="${today}" required></label>
          <label class="field"><span>Water used</span><input type="number" name="value" min="0" step="any" required placeholder="e.g. 540"></label>
          <label class="field"><span>Unit</span><select name="unit"><option value="L">Litres</option><option value="kL">Kilolitres</option></select></label>
          <label class="field grow"><span>Notes (optional)</span><input type="text" name="notes" maxlength="500"></label>
          <button class="btn primary" type="submit">${icon("plus")}Add</button></form></div>
      <div class="card reveal">${cardHead("Upload water CSV", "A date column plus litres or kL - e.g. date,water_usage_litres or date,water_usage_kl. Daily or hourly; cumulative meter readings are converted. You'll see a preview and every problem row before anything is saved.")}
        <div class="inline">${importButton("w-csv")}</div>
        <div class="inline" style="margin-top:12px"><button class="btn sm" id="w-demo">${icon("sparkles")}Load demo data</button>
          <a class="btn sm ghost" href="/api/samples/water_daily_sample.csv">${icon("download")}Sample CSV</a></div></div>
    </div>
    <div class="card mt flush reveal"><div class="pad">${cardHead("Water records", `${num(r.total, 0)} readings · ${Object.entries(r.by_source).map(([k, n]) => `${num(n, 0)} ${SRC[k] || k}`).join(" · ") || "none yet"}`,
      r.total ? `<div class="inline">${Object.keys(r.by_source).map((k) => `<button class="btn sm ghost" data-clear="${k}">${icon("trash")}Clear ${SRC[k] || k}</button>`).join("")}</div>` : "")}</div>
      ${r.items.length ? `<div class="table-wrap"><table class="w-table"><thead><tr><th>Date / hour</th><th class="n">Litres</th><th>Type</th><th>Source</th><th>Notes</th><th></th></tr></thead><tbody>
        ${r.items.map((x) => `<tr><td data-l="When">${x.granularity === "day" ? fmtDay(x.ts) : fmtTime(x.ts)}</td><td class="n num" data-l="Litres">${num(x.litres, 1)}</td>
          <td data-l="Type">${x.granularity === "day" ? "Daily total" : "Hourly"}</td><td data-l="Source"><span class="tag ${x.source === "demo" ? "demo" : ""}">${SRC[x.source] || x.source}</span></td>
          <td data-l="Notes" class="subtle">${esc(x.notes || "")}</td>
          <td class="row-actions"><button class="btn sm ghost" data-edit='${esc(JSON.stringify(x))}' aria-label="Edit">${icon("edit")}</button>
            <button class="btn sm ghost" data-del-w="${x.id}" aria-label="Delete">${icon("trash")}</button></td></tr>`).join("")}</tbody></table></div>
        <div class="more-row inline" style="justify-content:center"><button class="btn sm" id="w-prev" ${page ? "" : "disabled"}>Newer</button>
          <span class="subtle">Page ${page + 1} of ${Math.max(1, Math.ceil(r.total / limit))}</span>
          <button class="btn sm" id="w-next" ${(page + 1) * limit < r.total ? "" : "disabled"}>Older</button></div>`
        : `<div class="pad">${emptyState("No water records", "Add a reading, upload a CSV or connect a smart meter.", "", "droplet")}</div>`}</div>`;
}

async function samplesTab() {
  const list = await api("/api/samples");
  return `<div class="card reveal">${cardHead("Sample files", "Check each file's validation report - including the edge cases that are meant to fail - or analyse it directly.")}
    <div class="sample-grid">${list.filter((s) => s.available).map((s) => `<div class="sample">
      <span class="tag ${s.utility === "water" ? "blue" : ""}">${icon(s.utility === "water" ? "droplet" : "zap")}${s.utility}</span>
      <b>${esc(s.title)}</b><p>${esc(s.description)}</p>
      <div class="inline">${s.utility === "electricity" ? `<button class="btn sm" data-check="${s.name}">${icon("listChecks")}Check file</button>` : `<button class="btn sm" data-wsample="${s.name}">${icon("cloudUpload")}Import</button>`}
        <a class="btn sm ghost" href="/api/samples/${s.name}">${icon("download")}Download</a></div></div>`).join("")}</div></div>
    <div class="grid g2 mt">
      <div class="card reveal">${cardHead("Electricity CSV format")}
        <p class="subtle">A timestamp column plus energy per reading (<code>kwh</code>, <code>energy_wh</code>) or average power (<code>power_kw</code>, <code>watts</code>). UCI-style <code>Date;Time;Global_active_power</code> also works. Optional <code>circuit_&lt;name&gt;_kwh</code> columns enable per-appliance explanations.</p>
        <pre>timestamp,kwh,circuit_cooling_kwh
2026-04-01 00:00,0.82,0.55
2026-04-01 01:00,0.77,0.52</pre></div>
      <div class="card reveal">${cardHead("Water CSV format")}
        <p class="subtle">A <code>date</code> or <code>timestamp</code> column plus <code>litres</code> or <code>kl</code>. Daily totals or hourly readings. A <code>meter_reading</code> column of cumulative values is converted to usage.</p>
        <pre>date,litres
2026-10-01,560
2026-10-02,612</pre></div>
    </div>`;
}

async function devicesTab() {
  const list = await api("/api/water/devices");
  return `<div class="grid g-main">
    <div class="card reveal">${cardHead("Smart water meters & IoT devices", "Each device gets its own key to send hourly totals. Keys are stored hashed and shown only once.")}
      <form class="inline" id="dev-add"><label class="field inline-field" style="margin:0"><span>Device name</span><input type="text" name="name" maxlength="60" required placeholder="e.g. Main inlet meter"></label>
        <button class="btn primary" type="submit">${icon("key")}Create key</button></form>
      ${list.length ? `<div class="table-wrap mt"><table class="mini"><thead><tr><th>Device</th><th>Key</th><th>Created</th><th>Last data</th><th></th></tr></thead><tbody>
        ${list.map((d) => `<tr><td><b>${esc(d.name)}</b></td><td><code>${esc(d.prefix)}…</code></td><td class="subtle">${fmtDay(d.created_at)}</td>
          <td class="subtle">${d.last_used_at ? fmtTime(d.last_used_at.slice(0, 19)) : "never"}</td>
          <td class="row-actions"><button class="btn sm ghost" data-revoke="${d.id}">${icon("trash")}Revoke</button></td></tr>`).join("")}</tbody></table></div>`
        : `<p class="note">No devices yet.</p>`}</div>
    <div class="card reveal">${cardHead("Ingest API", "For device firmware or a home-automation hub")}
      <pre>POST ${location.origin}/api/water/ingest
X-Device-Key: ppw_…
Content-Type: application/json

{"readings": [
  {"ts": "2026-11-03T07:00", "litres": 82.5},
  {"ts": "2026-11-03T08:00", "value": 0.06, "unit": "kL"}
]}</pre>
      <p class="note">Send hourly totals (up to 1,000 per request). Re-sending an hour replaces it, so retries are safe. Invalid readings are returned in <code>rejected</code>.</p></div></div>`;
}

export default async function data(el, ctx) {
  const tab = state.dataTab || "electricity";
  const body = tab === "water" ? await waterTab() : tab === "samples" ? await samplesTab() : tab === "devices" ? await devicesTab() : await electricityTab();
  el.innerHTML = `<div class="util-tabs" role="tablist">${TABS.map(([v, l, ic]) => `<button role="tab" data-tab="${v}" aria-selected="${tab === v}">${icon(ic)}${l}</button>`).join("")}</div>${body}`;
  const rerender = () => ctx.rerender([ctx.state.view]);  // hosted inside Settings > Data
  el.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { state.dataTab = b.dataset.tab; rerender(); }));

  // electricity
  bindReadings(el, ctx, () => { state.erLimit = (state.erLimit || 25) + 25; rerender(); });
  const input = el.querySelector("#file"), drop = el.querySelector("#drop");
  if (drop) {
    input.addEventListener("change", () => { if (input.files[0]) validateAndConfirm(input.files[0], ctx); input.value = ""; });
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    ["dragover", "dragenter"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((n) => drop.addEventListener(n, () => drop.classList.remove("over")));
    drop.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) validateAndConfirm(e.dataTransfer.files[0], ctx); });
    el.querySelector("#load-uci").addEventListener("click", ctx.loadUci);
    el.querySelector("#tpl").addEventListener("click", () => {
      let csv = "timestamp,kwh\n";
      const start = Date.UTC(2026, 0, 1);
      for (let i = 0; i < 24 * 21; i++) {
        const h = i % 24, base = 0.25 + (h >= 18 && h <= 22 ? 0.6 : h >= 7 && h <= 9 ? 0.4 : 0.05);
        csv += `${new Date(start + i * 36e5).toISOString().slice(0, 16).replace("T", " ")},${(base * (0.85 + Math.random() * 0.3)).toFixed(3)}\n`;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = "powerpulse-template.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }
  el.querySelectorAll("[data-activate]").forEach((b) => b.addEventListener("click", () =>
    ctx.analyse(post(`/api/datasets/${b.dataset.activate}/activate`), "Switching dataset…").then((ok) => ok && toast("Active dataset changed", "success"))));
  el.querySelectorAll("[data-del-ds]").forEach((b) => b.addEventListener("click", () => openModal({
    title: "Delete dataset?",
    body: `<p>Delete <b>${esc(b.dataset.name)}</b> and its anomalies? This can't be undone.</p>
      <div class="inline" style="margin-top:16px;justify-content:flex-end"><button class="btn" data-modal-close>Cancel</button><button class="btn danger" id="yes">${icon("trash")}Delete</button></div>`,
    onMount: (w) => w.querySelector("#yes").addEventListener("click", async () => {
      closeModal();
      try { await del(`/api/datasets/${b.dataset.delDs}`); toast("Dataset deleted", "success"); await ctx.reloadActive(); }
      catch (err) { toast(err.message, "error"); }
    }),
  })));

  // water
  el.querySelector("#w-entry")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await post("/api/water/readings", { date: f.date.value, value: +f.value.value, unit: f.unit.value, notes: f.notes.value }); toast("Reading added", "success"); ctx.refreshNotifications(); rerender(); }
    catch (err) { toast(err.message, "error"); }
  });
  bindImport(el, () => { ctx.refreshNotifications(); rerender(); });
  el.querySelector("#w-demo")?.addEventListener("click", async () => {
    try { await post("/api/water/demo"); toast("Demo water data loaded (labelled as demo)", "success"); ctx.refreshNotifications(); rerender(); }
    catch (err) { toast(err.message, "error"); }
  });
  el.querySelectorAll("[data-clear]").forEach((b) => b.addEventListener("click", () => openModal({
    title: `Clear ${SRC[b.dataset.clear] || b.dataset.clear} water records?`,
    body: `<p>This permanently deletes every ${SRC[b.dataset.clear] || b.dataset.clear} water reading in your account.</p>
      <div class="inline" style="margin-top:16px;justify-content:flex-end"><button class="btn" data-modal-close>Cancel</button><button class="btn danger" id="yes">${icon("trash")}Delete</button></div>`,
    onMount: (w) => w.querySelector("#yes").addEventListener("click", async () => {
      closeModal();
      try { const r = await del(`/api/water/readings?source=${b.dataset.clear}`); toast(`Deleted ${num(r.deleted, 0)} readings`, "success"); rerender(); }
      catch (err) { toast(err.message, "error"); }
    }),
  })));
  el.querySelectorAll("[data-del-w]").forEach((b) => b.addEventListener("click", async () => {
    try { await del(`/api/water/readings/${b.dataset.delW}`); toast("Reading deleted", "success"); rerender(); } catch (err) { toast(err.message, "error"); }
  }));
  el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
    const x = JSON.parse(b.dataset.edit);
    openModal({
      title: x.granularity === "day" ? "Edit daily reading" : "Edit hourly reading",
      body: `<form class="entry-form" id="ed">
        ${x.granularity === "day" ? `<label class="field"><span>Date</span><input type="date" name="date" value="${x.ts.slice(0, 10)}" max="${new Date().toISOString().slice(0, 10)}" required></label>` : `<p class="subtle">${fmtTime(x.ts)}</p>`}
        <label class="field"><span>Water used</span><input type="number" name="value" min="0" step="any" value="${x.litres}" required autofocus></label>
        <label class="field"><span>Unit</span><select name="unit"><option value="L">Litres</option><option value="kL">kL</option></select></label>
        <label class="field grow"><span>Notes</span><input type="text" name="notes" maxlength="500" value="${esc(x.notes || "")}"></label>
        <button class="btn primary" type="submit">${icon("check")}Save</button></form>`,
      onMount: (w) => w.querySelector("#ed").addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        try {
          await put(`/api/water/readings/${x.id}`, { date: f.date ? f.date.value : x.ts.slice(0, 10), value: +f.value.value, unit: f.unit.value, notes: f.notes.value });
          closeModal(); toast("Reading updated", "success"); ctx.refreshNotifications(); rerender();
        } catch (err) { toast(err.message, "error"); }
      }),
    });
  }));
  el.querySelector("#w-prev")?.addEventListener("click", () => { state.waterPage = Math.max(0, (state.waterPage || 0) - 1); rerender(); });
  el.querySelector("#w-next")?.addEventListener("click", () => { state.waterPage = (state.waterPage || 0) + 1; rerender(); });

  // samples
  el.querySelectorAll("[data-check]").forEach((b) => b.addEventListener("click", async () => {
    const blob = await fetch(`/api/samples/${b.dataset.check}`).then((r) => r.blob());
    validateAndConfirm(new File([blob], b.dataset.check, { type: "text/csv" }), ctx);
  }));
  el.querySelectorAll("[data-wsample]").forEach((b) => b.addEventListener("click", async () => {
    const blob = await fetch(`/api/samples/${b.dataset.wsample}`).then((r) => r.blob());
    const fd = new FormData();
    fd.append("file", new File([blob], b.dataset.wsample, { type: "text/csv" }));
    try { const r = await api("/api/water/upload", { method: "POST", body: fd }); toast(`Imported ${r.inserted} water readings`, "success"); state.dataTab = "water"; ctx.refreshNotifications(); rerender(); }
    catch (err) { toast(err.message, "error"); }
  }));

  // devices
  el.querySelector("#dev-add")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await post("/api/water/devices", { name: e.target.elements.name.value });
      openModal({ title: "Device key created", body: `<p>Copy this key into <b>${esc(r.name)}</b> now. For security it is stored hashed and <b>won't be shown again</b>.</p>
        <pre class="key">${esc(r.key)}</pre><div class="inline" style="justify-content:flex-end"><button class="btn primary" id="copy">${icon("check")}Copy key</button></div>`,
        onMount: (w) => w.querySelector("#copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(r.key); toast("Key copied", "success"); } catch { toast("Select the key and copy it manually", "info"); } }) });
      rerender();
    } catch (err) { toast(err.message, "error"); }
  });
  el.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
    try { await del(`/api/water/devices/${b.dataset.revoke}`); toast("Device key revoked", "success"); rerender(); } catch (err) { toast(err.message, "error"); }
  }));
}
