// Dashboard chrome: collapsible sidebar / mobile drawer, header (breadcrumbs, dataset, date range,
// reports, notifications, account menu) and the "New analysis" modal.
import { $, $$, prefs, openModal, closeModal, initDropdowns, initTooltips, toast } from "./ui.js";
import { icon, logo, hydrateIcons } from "./icons.js";
import { state, api, post } from "./store.js";
import { esc, fmtDay, isoDay } from "./format.js";
import { getPref, setPref, THEME_ICON, THEME_LABEL } from "./theme.js";

const SUB = [["analytics", "Consumption Analytics", "Water Usage Analytics"], ["anomalies", "Anomaly Detection"], ["alerts", "Alerts"],
  ["limit", "Daily Consumption Limit"], ["savings", "Savings & Cost"], ["reports", "Electricity Reports", "Water Reports"]];
export const TITLES = {
  overview: ["Overview", "Household"],
  ...Object.fromEntries(SUB.map(([k, t]) => [`electricity/${k}`, [t, "Electricity"]])),
  ...Object.fromEntries(SUB.map(([k, t, w]) => [`water/${k}`, [w || t, "Water"]])),
  reports: ["Monthly Reports", "Household"], notifications: ["Notifications", "Account"], settings: ["Settings", "Account"],
  lab: ["Validation Lab", "Electricity"],
};
const isMobile = () => window.matchMedia("(max-width: 900px)").matches;
let ctx;

export function initShell(context) {
  ctx = context;
  $("#brand-logo").outerHTML = logo(36);
  hydrateIcons();
  initTooltips();
  initDropdowns();

  // ----- sidebar collapse (desktop) -----
  setCollapsed(!!prefs.get("sidebarCollapsed"), false);
  document.documentElement.classList.remove("pre-collapsed");
  $("#sb-toggle").addEventListener("click", () => setCollapsed(!document.body.classList.contains("sb-collapsed")));
  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    if (e.key === "[" && !typing && !e.ctrlKey && !e.metaKey && !isMobile()) setCollapsed(!document.body.classList.contains("sb-collapsed"));
    if (e.key === "Escape" && $("#sidebar").classList.contains("open")) closeDrawer(true);
  });

  // ----- mobile drawer -----
  $("#menu").addEventListener("click", openDrawer);
  $("#sb-close").addEventListener("click", () => closeDrawer(true));
  $("#overlay").addEventListener("click", () => closeDrawer(true));
  $("#nav").addEventListener("click", (e) => { if (e.target.closest("a[data-view]") && isMobile()) closeDrawer(); });
  initSections();
  renderThemeMenu();
  window.addEventListener("themechange", renderThemeMenu);
  window.addEventListener("themepref", renderThemeMenu);
  window.matchMedia("(max-width: 900px)").addEventListener("change", (m) => { if (!m.matches) closeDrawer(); });

  // ----- header -----
  $("#new-analysis").addEventListener("click", newAnalysisModal);
  $("#quick-file").addEventListener("change", (e) => { ctx.uploadFile(e.target.files[0]); e.target.value = ""; });
  $("#notif-dd").addEventListener("dd:open", () => refreshNotifications());
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-settings-tab]");
    if (t) { state.settingsTab = t.dataset.settingsTab; state.dirty.add("settings"); }
    const dt = e.target.closest("[data-data-tab]");
    if (dt) state.dataTab = dt.dataset.dataTab;
  });
  $("#logout").addEventListener("click", async () => {
    try { await post("/api/auth/logout"); } finally { location.replace("/"); }
  });
  renderDatePop();
  setInterval(() => document.visibilityState === "visible" && refreshNotifications(), 60000);
}

export function setUser(u) {
  state.user = u;
  const initials = u.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  $("#avatar").textContent = initials || "?";
  $("#user-name").textContent = u.name;
  $("#user-email").textContent = u.email;
}

export function setCollapsed(collapsed, persist = true) {
  document.body.classList.toggle("sb-collapsed", collapsed);
  const t = $("#sb-toggle");
  t.setAttribute("aria-expanded", String(!collapsed));
  t.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  t.querySelector(".tog-ic").innerHTML = icon(collapsed ? "panelOpen" : "panelClose");
  t.querySelector(".sb-text").textContent = collapsed ? "Expand sidebar" : "Collapse sidebar";
  if (persist) prefs.set("sidebarCollapsed", collapsed);
}

function openDrawer() {
  const sb = $("#sidebar"), ov = $("#overlay");
  ov.hidden = false;
  requestAnimationFrame(() => { sb.classList.add("open"); ov.classList.add("show"); });
  document.body.classList.add("no-scroll");
  $("#menu").setAttribute("aria-expanded", "true");
  sb.querySelector("a.active, a[data-view]")?.focus();
}
function closeDrawer(refocus = false) {
  const sb = $("#sidebar"), ov = $("#overlay");
  if (!sb.classList.contains("open")) return;
  sb.classList.remove("open");
  ov.classList.remove("show");
  setTimeout(() => { if (!sb.classList.contains("open")) ov.hidden = true; }, 260);
  document.body.classList.remove("no-scroll");
  $("#menu").setAttribute("aria-expanded", "false");
  if (refocus) $("#menu").focus();
}

// ---------------- expandable Electricity / Water sections ----------------
// default: only the section holding the current page is open (it opens automatically) - keeps the sidebar uncluttered
const sectionOpen = () => prefs.get("navOpen") || {};
function setSection(key, open, persist = true) {
  const btn = $(`#np-${key}`), sec = btn.closest(".nav-section");
  btn.setAttribute("aria-expanded", String(open));
  sec.classList.toggle("open", open);
  if (persist) prefs.set("navOpen", { ...sectionOpen(), [key]: open });
}
function initSections() {
  const open = sectionOpen();
  $$(".nav-section").forEach((sec) => setSection(sec.dataset.section, !!open[sec.dataset.section], false));
  $$(".nav-parent").forEach((btn) => btn.addEventListener("click", (e) => {
    const key = btn.closest(".nav-section").dataset.section;
    if (document.body.classList.contains("sb-collapsed") && !isMobile()) { e.stopPropagation(); openFlyout(btn); return; }
    setSection(key, btn.getAttribute("aria-expanded") !== "true");
  }));
}

// collapsed sidebar: a parent opens a flyout listing its pages
function openFlyout(btn) {
  if ($(".nav-flyout")) { closeFlyout(); return; }
  const sec = btn.closest(".nav-section"), r = btn.getBoundingClientRect();
  const fly = document.createElement("div");
  fly.className = "nav-flyout";
  fly.setAttribute("role", "menu");
  fly.setAttribute("aria-label", btn.dataset.tip);
  fly.innerHTML = `<div class="nf-title">${btn.dataset.tip}</div>` + [...sec.querySelectorAll(".nav-sub a")].map((a) =>
    `<a role="menuitem" href="${a.getAttribute("href")}" class="${a.classList.contains("active") ? "active" : ""}">${a.querySelector("svg").outerHTML}<span>${a.querySelector("span").textContent}</span></a>`).join("");
  document.body.appendChild(fly);
  fly.style.top = Math.max(8, Math.min(r.top, innerHeight - fly.offsetHeight - 12)) + "px";
  fly.style.left = r.right + 10 + "px";
  btn.setAttribute("aria-expanded", "true");
  fly.querySelector("a")?.focus();
  const close = (ev) => { if (!fly.contains(ev.target)) closeFlyout(); else document.addEventListener("click", close, { once: true }); };
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
  fly.addEventListener("click", (ev) => { if (ev.target.closest("a")) closeFlyout(); });
  fly.addEventListener("keydown", (ev) => {
    const items = [...fly.querySelectorAll("a")], i = items.indexOf(document.activeElement);
    if (ev.key === "Escape") { closeFlyout(); btn.focus(); }
    if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
}
function closeFlyout() {
  const f = $(".nav-flyout");
  if (!f) return;
  f.remove();
  $$(".nav-section").forEach((sec) => $(`#np-${sec.dataset.section}`).setAttribute("aria-expanded", String(sec.classList.contains("open"))));
}

/** Active nav item, breadcrumbs and title for a view. */
export function setActiveView(view) {
  closeFlyout();
  $$("#nav a[data-view]").forEach((a) => {
    const on = a.dataset.view === view;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const section = view.includes("/") ? view.split("/")[0] : view === "lab" ? "electricity" : null;
  $$(".nav-section").forEach((sec) => sec.classList.toggle("has-active", sec.dataset.section === section));
  if (section && !$(`#np-${section}`).closest(".nav-section").classList.contains("open")) setSection(section, true);
  const [title, group] = TITLES[view];
  $("#view-title").textContent = title;
  $("#crumb-group").textContent = group;
  $("#crumb-page").textContent = title;
  document.title = `${title} · PowerPulse`;
  $("#date-dd").hidden = !["electricity/analytics", "electricity/alerts"].includes(view);
  // electricity dataset details belong to electricity pages only - never under Water or elsewhere
  const elec = section === "electricity";
  $("#ds-line").hidden = !elec;
  $("#report-dd").hidden = !elec;
  $("#new-analysis").hidden = !(elec || view === "overview");
}

// ---------------- date range selector ----------------
const PRESETS = [[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"], [0, "All data"]];
export function rangeLabel() {
  if (state.range === "custom" && state.from != null) return `${fmtDay(state.from)} – ${fmtDay(state.to)}`;
  return PRESETS.find(([v]) => v === state.range)?.[1] ?? "All data";
}
export function renderDatePop() {
  const pop = $("#date-pop"), t = state.res?.hourly.t;
  const min = t ? isoDay(t[0]) : "", max = t ? isoDay(t[t.length - 1]) : "";
  pop.innerHTML = `
    <div class="pop-title">Date range</div>
    <div class="presets">${PRESETS.map(([v, l]) => `<button class="${state.range === v ? "on" : ""}" data-range="${v}" data-dd-close>${l}</button>`).join("")}</div>
    <div class="pop-title">Custom range</div>
    <form class="date-fields" id="date-form">
      <label>From<input type="date" name="from" min="${min}" max="${max}" value="${state.from != null ? isoDay(state.from) : ""}" ${t ? "" : "disabled"} required></label>
      <label>To<input type="date" name="to" min="${min}" max="${max}" value="${state.to != null ? isoDay(state.to) : ""}" ${t ? "" : "disabled"} required></label>
      <button class="btn primary sm" type="submit" ${t ? "" : "disabled"}>Apply</button>
    </form>
    <p class="pop-note">${t ? `Electricity data covers ${fmtDay(t[0])} – ${fmtDay(t[t.length - 1])}. Ranges count back from the last reading and apply to the electricity charts.` : "Load an electricity dataset to choose dates."}</p>`;
  $("#date-label").textContent = rangeLabel();
  pop.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => setRange(+b.dataset.range)));
  // an earlier "end before start" message must clear as soon as either date changes, or the form stays blocked
  ["from", "to"].forEach((n) => $("#date-form").elements[n].addEventListener("input", () => $("#date-form").elements.to.setCustomValidity("")));
  $("#date-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target, a = Date.parse(f.from.value + "T00:00:00Z"), b = Date.parse(f.to.value + "T00:00:00Z");
    if (!(a <= b)) { f.to.setCustomValidity("End date must be on or after the start date"); f.to.reportValidity(); return; }
    f.to.setCustomValidity("");
    state.from = a; state.to = b;
    setRange("custom");
    $("#date-dd").classList.remove("open");
  });
}
export function setRange(range) {
  state.range = range;
  if (range !== "custom") prefs.set("range", range);
  renderDatePop();
  ctx.onRangeChange();
}

// ---------------- electricity dataset info ----------------
export function updateDataset(res) {
  $("#report-btn").disabled = !res;
  if (!res) {
    $("#ds-line").innerHTML = `<span class="ds-dot"></span><span>${esc(state.user?.name || "")} · no electricity dataset yet</span>`;
    renderDatePop();
    return;
  }
  const d = res.dataset, id = d.id;
  $("#dl-html").href = `/api/datasets/${id}/report.html`;
  $("#dl-csv").href = `/api/datasets/${id}/report.csv`;
  $("#dl-data").href = `/api/datasets/${id}/data.csv`;
  $("#ds-line").innerHTML = `<span class="ds-dot live"></span><span class="ds-name">${esc(d.name)}</span>
    <span class="ds-sep">·</span><span>${fmtDay(d.start)} – ${fmtDay(d.end)}</span>${d.has_ground_truth ? '<span class="tag injected">Validation data</span>' : ""}`;
  renderDatePop();
}

// ---------------- notifications (server-backed) ----------------
const CAT_ICON = { electricity: "zap", water: "droplet", report: "file", account: "user" };
let lastUnread = null;

export function notificationTarget(n) {
  if (n.category === "report") return "reports";
  if (n.kind === "elec_anomaly") return "electricity/anomalies";
  if (n.kind === "water_anomaly") return "water/anomalies";
  if (n.category === "water") return "water/limit";
  if (n.category === "electricity") return "electricity/limit";
  return "notifications";
}

// ---------------- unread-anomaly badges (electricity and water counted separately) ----------------
const UNIT_NAME = { electricity: "electricity", water: "water" };
function setBadge(el, n, utility) {
  if (!el) return;
  const prev = +(el.dataset.n || 0);
  el.dataset.n = String(n);
  el.title = n ? `${n} unread ${UNIT_NAME[utility]} anomal${n === 1 ? "y" : "ies"}` : "";
  if (!n) {  // fade out, then empty (an empty badge isn't displayed)
    if (prev && el.textContent) { el.classList.add("out"); setTimeout(() => { if (el.dataset.n === "0") { el.textContent = ""; el.classList.remove("out"); } }, 220); }
    else el.textContent = "";
    return;
  }
  el.classList.remove("out");
  el.textContent = n > 99 ? "99+" : String(n);
  if (n !== prev) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
}
/** counts = {electricity: {total, unread, read}, water: {...}} from /api/anomalies/* */
export function setAnomalyCounts(counts) {
  if (!counts) return;
  state.anomalyCounts = { ...state.anomalyCounts, ...counts };
  if (counts.electricity) setBadge($("#nav-count"), counts.electricity.unread, "electricity");
  if (counts.water) setBadge($("#nav-count-water"), counts.water.unread, "water");
}
export async function refreshAnomalyCounts() {
  try { setAnomalyCounts(await api("/api/anomalies/counts")); } catch { /* signed out or offline: keep the last counts */ }
}

export async function refreshNotifications() {
  refreshAnomalyCounts();  // new data can mean new anomalies
  let data;
  try { data = await api("/api/notifications?limit=8"); } catch { return; }
  const badge = $("#notif-badge"), u = data.unread;
  badge.hidden = !u;
  badge.textContent = u > 99 ? "99+" : u;
  $("#nav-unread").textContent = u || "";
  if (lastUnread !== null && u > lastUnread) { badge.classList.remove("pop"); void badge.offsetWidth; badge.classList.add("pop"); }
  lastUnread = u;
  $("#notif-pop").innerHTML = `
    <div class="notif-h"><div><b>Notifications</b><span>${u} unread</span></div>
      <button class="btn ghost sm" id="notif-read" ${u ? "" : "disabled"}>${icon("checkCheck")}Mark all read</button></div>
    <div class="notif-list">${data.items.map((n) => `
      <a class="notif ${n.severity} ${n.read ? "read" : ""}" data-notif="${n.id}" data-target="${notificationTarget(n)}" data-cat="${n.category}" data-dd-close tabindex="0">
        <span class="n-ic">${icon(CAT_ICON[n.category] || "bell")}</span><span class="n-body"><b>${esc(n.title)}</b><small>${esc(n.body)}</small>
        <small class="n-time">${timeAgo(n.created_at)}</small></span>${n.read ? "" : '<span class="n-new">New</span>'}</a>`).join("")
      || '<p class="pop-note" style="padding:16px">No notifications yet. Alerts for limits, unusual use and monthly reports appear here.</p>'}</div>
    <a class="notif-all" href="#notifications" data-dd-close>Open notification centre ${icon("arrowRight")}</a>`;
  $("#notif-read").addEventListener("click", async (e) => {
    e.stopPropagation();
    await post("/api/notifications/read", { all: true });
    refreshNotifications();
    state.dirty.add("notifications");
  });
  $$("#notif-pop [data-notif]").forEach((a) => a.addEventListener("click", () => openNotification(+a.dataset.notif, a.dataset.target, a.dataset.cat)));
  return data;
}

export async function openNotification(id, target) {
  try { await post("/api/notifications/read", { ids: [id] }); } catch { /* still navigate */ }
  state.dirty.add("notifications");
  refreshNotifications();
  ctx.go(target);
}

export function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// ---------------- new analysis modal ----------------
export function newAnalysisModal() {
  const uci = state.sources?.uci_available;
  openModal({
    title: "Add data",
    body: `<p class="subtle" style="margin-bottom:16px">PowerPulse cleans your data, learns what's normal for your home and checks it against your limits.</p>
      <div class="na-grid">
        <button class="na-opt" data-na="upload"><span class="na-ic blue">${icon("cloudUpload")}</span><b>Upload electricity CSV</b><span>Hourly or finer readings, at least 14 days</span></button>
        <button class="na-opt" data-na="uci" ${uci ? "" : "disabled"}><span class="na-ic cyan">${icon("globe")}</span><b>Analyse the UCI household</b><span>${uci ? "4 years of real data from a home near Paris" : "Run python scripts/fetch_uci.py first"}</span></button>
        <button class="na-opt" data-na="water"><span class="na-ic cyan">${icon("droplet")}</span><b>Add water usage</b><span>Manual daily entry, CSV upload or a smart meter</span></button>
        <button class="na-opt" data-na="lab"><span class="na-ic violet">${icon("flask")}</span><b>Run a validation scenario</b><span>Inject labelled anomalies and measure detection</span></button>
      </div>`,
    onMount: (w) => w.querySelectorAll("[data-na]").forEach((b) => b.addEventListener("click", () => {
      const a = b.dataset.na;
      closeModal();
      if (a === "upload") $("#quick-file").click();
      else if (a === "uci") ctx.loadUci();
      else if (a === "water") { state.dataTab = "water"; state.settingsTab = "data"; state.dirty.add("settings"); ctx.go("settings"); }
      else ctx.go(a);
    })),
  });
}

export { toast };

// ---------------- theme menu (header) ----------------
export function renderThemeMenu() {
  const pref = getPref(), shown = pref === "system" ? (document.documentElement.dataset.theme === "dark" ? "dark" : "light") : pref;
  $("#theme-btn").innerHTML = icon(THEME_ICON[shown]);
  $("#theme-btn").setAttribute("aria-label", `Theme: ${THEME_LABEL[pref]}`);
  $("#theme-pop").innerHTML = `<div class="pop-title">Theme</div>` + ["light", "dark", "system"].map((p) =>
    `<a role="menuitemradio" aria-checked="${pref === p}" data-theme-set="${p}" data-dd-close tabindex="0" class="${pref === p ? "on" : ""}">${icon(THEME_ICON[p])}<span><b>${THEME_LABEL[p]}</b>
      <small>${p === "system" ? "Follow your device setting" : p === "dark" ? "Dark surfaces, easy at night" : "Bright surfaces"}</small></span>${pref === p ? icon("check") : ""}</a>`).join("");
  $$("#theme-pop [data-theme-set]").forEach((a) => {
    a.addEventListener("click", () => setPref(a.dataset.themeSet));
    a.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPref(a.dataset.themeSet); } });
  });
}
