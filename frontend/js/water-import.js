// Water CSV import: native file picker -> client checks -> upload with progress -> server-side validation
// and preview (column mapping, line-numbered problems, overlap with saved data) -> confirm or cancel -> import.
// Nothing is stored until the user confirms; nothing invalid is dropped without being listed.
import { icon } from "./icons.js";
import { esc, fmtDay, fmtTime, num } from "./format.js";
import { toast, openModal } from "./ui.js";

const MAX_MB = 20;

/** The "Add Water CSV" button plus the real <input type="file"> it opens. */
export const importButton = (id = "w-csv", cls = "btn primary") => `
  <button type="button" class="${cls}" data-csv-pick="${id}">${icon("cloudUpload")}Add Water CSV</button>
  <input type="file" id="${id}" class="sr-only" accept=".csv,text/csv" tabindex="-1" aria-label="Choose a water CSV file">`;

/** Wire every Add Water CSV button in root. onDone(result) runs after a successful import. */
export function bindImport(root, onDone) {
  root.querySelectorAll("[data-csv-pick]").forEach((btn) => {
    const input = root.querySelector("#" + btn.dataset.csvPick);
    if (!input) return;
    btn.addEventListener("click", () => { input.value = ""; input.click(); });  // opens the OS file picker
    input.addEventListener("change", () => { if (input.files?.[0]) start(input.files[0], onDone); });
  });
}

function clientCheck(file) {
  if (!/\.csv$/i.test(file.name)) return `"${file.name}" is not a .csv file. Export the sheet as CSV (comma-separated values) first.`;
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_MB * 1024 * 1024) return `"${file.name}" is ${num(file.size / 1048576, 1)} MB - the limit is ${MAX_MB} MB.`;
  return null;
}

/** XHR rather than fetch: fetch can't report upload progress. */
function send(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.setRequestHeader("X-Requested-With", "PowerPulse");
    x.responseType = "json";
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onerror = () => reject(new Error("Can't reach the PowerPulse server. Check your connection and try again."));
    x.onload = () => {
      if (x.status === 401) { location.replace("/login?next=" + encodeURIComponent(location.pathname + location.hash)); return; }
      if (x.status >= 200 && x.status < 300) return resolve(x.response);
      const d = x.response?.detail;
      reject(new Error(typeof d === "string" ? d : Array.isArray(d) ? d.map((e) => e.msg).join("; ") : `Upload failed (HTTP ${x.status}).`));
    };
    x.send(form);
  });
}

const sizeLabel = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${num(b / 1024, 0)} KB` : `${num(b / 1048576, 1)} MB`);
const fileHead = (file) => `<div class="imp-file">${icon("file")}<div><b>${esc(file.name)}</b><span>${sizeLabel(file.size)}</span></div></div>`;
const progress = (label) => `<div class="imp-progress" role="status" aria-live="polite"><span class="imp-label">${label}</span>
  <div class="imp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></div>`;
function setProgress(w, frac, label) {
  const bar = w.querySelector(".imp-bar");
  if (!bar) return;
  bar.setAttribute("aria-valuenow", String(Math.round(frac * 100)));
  bar.firstElementChild.style.width = `${Math.max(3, frac * 100)}%`;
  if (label) w.querySelector(".imp-label").textContent = label;
}

function start(file, onDone) {
  const problem = clientCheck(file);
  const w = openModal({ title: "Import water readings", wide: true, body: `<div class="imp">${fileHead(file)}<div class="imp-body"></div></div>` });
  const body = w.querySelector(".imp-body");
  if (problem) {
    body.innerHTML = `<div class="alert-box error">${icon("alert")}<span>${esc(problem)}</span></div>
      <div class="imp-actions"><button class="btn" data-modal-close>Close</button></div>`;
    return;
  }
  const opts = { unit: "L", date_column: "", value_column: "", on_duplicate: "skip" };
  preview(w, body, file, opts, onDone);
}

const form = (file, opts) => {
  const fd = new FormData();
  fd.append("file", file);
  for (const [k, v] of Object.entries(opts)) fd.append(k, v);
  return fd;
};

async function preview(w, body, file, opts, onDone) {
  body.innerHTML = progress("Uploading for checking…");
  let p;
  try {
    p = await send("/api/water/upload/preview", form(file, opts), (f) => setProgress(w, f * 0.9, f >= 1 ? "Checking rows…" : null));
    setProgress(w, 1);
  } catch (e) {
    body.innerHTML = `<div class="alert-box error">${icon("alert")}<span>${esc(e.message)}</span></div>
      <div class="imp-actions"><button class="btn" data-modal-close>Close</button></div>`;
    return;
  }
  if (!document.body.contains(w)) return;  // cancelled meanwhile
  body.innerHTML = report(p, opts);
  const remap = () => {
    opts.date_column = body.querySelector("[name=date_column]")?.value || "";
    opts.value_column = body.querySelector("[name=value_column]")?.value || "";
    opts.unit = body.querySelector("[name=unit]")?.value || "L";
    preview(w, body, file, opts, onDone);
  };
  body.querySelectorAll(".imp-map select").forEach((s) => s.addEventListener("change", remap));
  body.querySelector("[name=on_duplicate]")?.addEventListener("change", (e) => { opts.on_duplicate = e.target.value; });
  body.querySelector("#imp-go")?.addEventListener("click", () => commit(w, body, file, opts, onDone));
}

function mapping(p, opts) {
  const cols = p.columns || [];
  if (!cols.length) return "";
  const sel = (name, label, current) => `<label class="field"><span>${label}</span><select name="${name}">
    <option value="">Detect automatically</option>${cols.map((c) => `<option ${c === current ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>`;
  return `<div class="imp-map">
    ${sel("date_column", "Date column", opts.date_column)}
    ${sel("value_column", "Water amount column", opts.value_column)}
    <label class="field"><span>Unit${p.unit_source === "header" ? " (from the column name)" : ""}</span><select name="unit" ${p.unit_source === "header" ? "disabled" : ""}>
      <option value="L" ${(p.unit_in_file || opts.unit) === "L" ? "selected" : ""}>Litres (L)</option>
      <option value="kL" ${(p.unit_in_file || opts.unit) === "kL" ? "selected" : ""}>Kilolitres (kL)</option></select></label></div>`;
}

function issues(p) {
  const counts = Object.entries(p.issue_counts || {});
  if (!counts.length) return "";
  const total = counts.reduce((a, [, n]) => a + n, 0);
  return `<div class="section-title">${icon("alert")} ${num(total, 0)} row${total === 1 ? "" : "s"} will not be imported</div>
    <div class="issue-counts">${counts.map(([k, n]) => `<span class="tag">${num(n, 0)} × ${esc(k)}</span>`).join("")}</div>
    <div class="table-wrap imp-table"><table class="mini"><thead><tr><th class="n">Line</th><th>Field</th><th>Problem</th><th>Value</th></tr></thead><tbody>
      ${(p.issues || []).map((i) => `<tr><td class="n num">${i.line}</td><td>${i.field}</td><td>${esc(i.problem)}</td><td><code>${esc(i.value) || "(empty)"}</code></td></tr>`).join("")}
    </tbody></table></div>${(p.issues || []).length < total ? `<p class="subtle">Showing the first ${p.issues.length} of ${num(total, 0)}.</p>` : ""}`;
}

function report(p, opts) {
  const raw = p.preview_raw?.length && p.columns ? `<div class="section-title">${icon("table")} First rows of the file</div>
    <div class="table-wrap imp-table"><table class="mini"><thead><tr><th class="n">Line</th>${p.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
      ${p.preview_raw.map((r, i) => `<tr><td class="n num">${i + 2}</td>${r.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : "";
  if (!p.ok) {
    return `<div class="alert-box error">${icon("alert")}<span>${esc(p.error)}</span></div>
      ${p.columns ? `<p class="subtle">Choose which columns hold the date and the water amount:</p>${mapping(p, opts)}` : ""}
      ${issues(p)}${raw}
      <div class="imp-actions"><button class="btn" data-modal-close>Cancel</button></div>`;
  }
  const gran = p.granularity === "day" ? "daily" : "hourly";
  return `
    <div class="imp-summary">
      <div><b class="num">${num(p.rows_clean, 0)}</b><span>${gran} readings ready</span></div>
      <div><b class="num">${num(p.new_records, 0)}</b><span>new dates</span></div>
      <div><b class="num">${num(p.already_saved, 0)}</b><span>already saved</span></div>
      <div class="${p.rows_excluded ? "warn" : ""}"><b class="num">${num(p.rows_excluded, 0)}</b><span>rows with problems</span></div>
    </div>
    <p class="subtle">${num(p.rows_raw, 0)} rows read · ${fmtDay(p.start)} – ${fmtDay(p.end)} · amounts from <b>${esc(p.value_column)}</b> (${p.unit_in_file})
      · dates from <b>${esc(p.date_column)}</b>${p.cumulative_meter ? " · cumulative meter readings converted to usage" : ""}</p>
    ${mapping(p, opts)}
    ${issues(p)}
    <div class="section-title">${icon("droplet")} Preview of what will be saved</div>
    <div class="table-wrap imp-table"><table class="mini"><thead><tr><th>${p.granularity === "day" ? "Date" : "Hour"}</th><th class="n">Litres</th></tr></thead><tbody>
      ${p.preview.map((r) => `<tr><td>${r.granularity === "day" ? fmtDay(r.ts) : fmtTime(r.ts)}</td><td class="n num">${num(r.litres, 1)}</td></tr>`).join("")}
    </tbody></table></div>${p.rows_clean > p.preview.length ? `<p class="subtle">…and ${num(p.rows_clean - p.preview.length, 0)} more.</p>` : ""}
    ${raw}
    <div class="imp-actions">
      ${p.already_saved ? `<label class="field inline-field"><span>Dates already saved</span><select name="on_duplicate">
        <option value="skip" ${opts.on_duplicate === "skip" ? "selected" : ""}>Keep my saved readings</option>
        <option value="replace" ${opts.on_duplicate === "replace" ? "selected" : ""}>Replace with this file</option></select></label>` : ""}
      <span class="grow"></span>
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn primary" id="imp-go">${icon("check")}Import ${num(p.rows_clean, 0)} readings</button></div>`;
}

async function commit(w, body, file, opts, onDone) {
  body.innerHTML = progress("Importing…");
  try {
    const r = await send("/api/water/upload", form(file, opts), (f) => setProgress(w, f * 0.9, f >= 1 ? "Saving readings…" : null));
    setProgress(w, 1, "Done");
    const excluded = r.rows_excluded ? ` ${num(r.rows_excluded, 0)} row${r.rows_excluded === 1 ? "" : "s"} with problems were not imported.` : "";
    body.innerHTML = `<div class="alert-box success">${icon("checkCircle")}<span><b>Imported ${num(r.inserted, 0)} new reading${r.inserted === 1 ? "" : "s"}</b>
      ${r.updated ? `, replaced ${num(r.updated, 0)}` : ""}${r.skipped_duplicates ? `, kept ${num(r.skipped_duplicates, 0)} already-saved date${r.skipped_duplicates === 1 ? "" : "s"}` : ""}
      from ${esc(r.file)}.${excluded}</span></div>
      <div class="imp-actions"><button class="btn primary" data-modal-close autofocus>Done</button></div>`;
    body.querySelector("[data-modal-close]").focus();
    toast(`Imported ${num(r.inserted, 0)} water readings`, "success");
    onDone?.(r);
  } catch (e) {
    body.innerHTML = `<div class="alert-box error">${icon("alert")}<span>Nothing was imported: ${esc(e.message)}</span></div>
      <div class="imp-actions"><button class="btn" data-modal-close>Close</button></div>`;
  }
}

