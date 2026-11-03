// PowerPulse dashboard controller: auth-aware boot, hash routing (#electricity/limit, #water/savings, ...),
// loading states, theme changes and the analysis actions shared by every view.
import * as charts from "./charts.js";
import { state, api, post, patch, loadSettings } from "./store.js";
import { $, $$, toast, countUp, applyMotionPref, initReveal } from "./ui.js";
import { hydrateIcons } from "./icons.js";
import { skeleton, emptyState } from "./components.js";
import { TITLES, initShell, setActiveView, updateDataset, setUser, refreshNotifications } from "./shell.js";
import { initTheme, adoptServerPref } from "./theme.js";
import household from "./views/household.js";
import elecAnalytics from "./views/elec-analytics.js";
import elecAnomalies from "./views/elec-anomalies.js";
import elecAlerts from "./views/elec-alerts.js";
import elecSavings from "./views/elec-savings.js";
import waterAnalytics from "./views/water-analytics.js";
import waterAnomalies from "./views/water-anomalies.js";
import waterAlerts from "./views/water-alerts.js";
import waterSavings from "./views/water-savings.js";
import { limitPage } from "./views/limit.js";
import { utilityReports } from "./views/utility-reports.js";
import reports from "./views/reports.js";
import lab from "./views/lab.js";
import notifications from "./views/notifications.js";
import settings from "./views/settings.js";

const VIEWS = {
  overview: household,
  "electricity/analytics": elecAnalytics, "electricity/anomalies": elecAnomalies, "electricity/alerts": elecAlerts,
  "electricity/limit": limitPage("electricity"), "electricity/savings": elecSavings, "electricity/reports": utilityReports("electricity"),
  "water/analytics": waterAnalytics, "water/anomalies": waterAnomalies, "water/alerts": waterAlerts,
  "water/limit": limitPage("water"), "water/savings": waterSavings, "water/reports": utilityReports("water"),
  reports, notifications, settings, lab,
};
// old links (bookmarks, notifications, the README) keep working
const ALIASES = {
  electricity: "electricity/analytics", consumption: "electricity/analytics", monitoring: "electricity/alerts", anomalies: "electricity/anomalies",
  savings: "electricity/savings", recommendations: "electricity/savings", water: "water/analytics", data: "settings",
};
const NEEDS_ELECTRICITY = new Set(["electricity/alerts", "electricity/savings"]);
// views that fetch their own server data on every visit
const STATIC_OK = new Set(["electricity/analytics", "electricity/savings"]);
const viewEl = (route) => {
  const id = "v-" + route.replace("/", "-");
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("section");
    el.className = "view";
    el.id = id;
    el.setAttribute("aria-labelledby", "view-title");
    $("#views").appendChild(el);
  }
  return el;
};
const resolve = (route) => (VIEWS[route] ? route : ALIASES[route] || "overview");

// ---------------- analysis ----------------
async function analyse(promise, text = "Analysing consumption…") {
  $("#loading-text").textContent = text;
  const firstLoad = !state.res;
  if (firstLoad && NEEDS_ELECTRICITY.has(state.view)) viewEl(state.view).innerHTML = skeleton();
  else $("#loading").hidden = false;
  try {
    setResult(await promise);
    return true;
  } catch (e) {
    toast(e.message, "error");
    if (firstLoad) render(state.view);
    return false;
  } finally {
    $("#loading").hidden = true;
  }
}

function setResult(res) {
  state.res = res;
  state.selectedKey = null;
  state.limit = 60;
  state.feedLimit = 12;
  state.dirty = new Set(Object.keys(VIEWS));
  updateDataset(res);
  refreshNotifications();
  show(state.view, { scroll: false });
}

async function reloadActive() {
  try { setResult(await api("/api/datasets/active")); } catch (e) { if (e.status === 404) setResult(null); else toast(e.message, "error"); }
}

function uploadFile(file) {
  if (!file) return;
  if (!/\.(csv|txt)$/i.test(file.name)) { toast("Please choose a .csv file.", "error"); return; }
  const fd = new FormData();
  fd.append("file", file);
  analyse(api("/api/datasets/upload", { method: "POST", body: fd }), `Validating & analysing ${file.name}…`)
    .then((ok) => { if (ok) { toast(`${file.name} analysed`, "success"); go("electricity/analytics"); } });
}
const loadUci = () => analyse(post("/api/datasets/uci"), "Analysing 4 years of real household data…")
  .then((ok) => { if (ok) { toast("UCI household analysed", "success"); go("electricity/analytics"); } });
const runScenario = () => analyse(post("/api/datasets/scenario", { scenario: state.scenario, base: state.base, seed: state.seed }), "Injecting anomalies & detecting…")
  .then((ok) => ok && toast(`Scenario “${state.scenario}” analysed`, "success"));

// ---------------- routing ----------------
const go = (route) => { if (location.hash !== "#" + route) location.hash = route; else show(route); };

function show(route, { scroll = true } = {}) {
  if (route === "data") state.settingsTab = "data";
  const view = resolve(route);
  if (view !== route && location.hash.slice(1) === route) history.replaceState(null, "", "#" + view);
  const changed = state.view !== view;
  state.view = view;
  setActiveView(view);
  const el = viewEl(view);
  $$(".view").forEach((v) => v.classList.toggle("active", v === el));
  if (state.dirty.has(view) || !STATIC_OK.has(view) || !el.childElementCount) { render(view); state.dirty.delete(view); }
  requestAnimationFrame(charts.resizeAll);
  if (scroll && changed) window.scrollTo({ top: 0 });
}

function render(view) {
  const el = viewEl(view);
  if (NEEDS_ELECTRICITY.has(view) && !state.res) {
    el.innerHTML = `<div class="card">${emptyState("No electricity dataset yet", "Upload a meter CSV, analyse the public UCI dataset or run a validation scenario to get started.",
      '<button class="btn primary" data-goto="settings" data-settings-tab="data" data-data-tab="electricity">Add electricity data</button>', "zap")}</div>`;
    hydrateIcons(el);
    return;
  }
  if (!el.childElementCount) el.innerHTML = '<div class="card"><div class="skel w40"></div><div class="skel chart-skel"></div></div>';
  const out = VIEWS[view](el, ctx);
  const finish = () => { if (state.view !== view) return; hydrateIcons(el); countUp(el); initReveal(el); };
  if (out && typeof out.then === "function") {
    out.then(finish).catch((e) => {
      el.innerHTML = `<div class="card">${emptyState("Couldn't load this page", e.message, '<button class="btn" data-retry>Try again</button>', "alert")}</div>`;
      hydrateIcons(el);
      el.querySelector("[data-retry]")?.addEventListener("click", () => render(view));
    });
  } else finish();
}

function openEvent(id) {
  const ev = state.res?.events.find((e) => e.id === id);
  if (ev) {  // select it by its stable key, and make sure filters don't hide it
    state.selectedKey = `${state.res.dataset.id}:${ev.type}:${ev.start}`;
    state.filters = { type: "all", severity: "all", origin: "all", read: "all" };
    const pos = state.res.events.indexOf(ev);
    if (pos >= state.limit) state.limit = pos + 40;  // manual-reading anomalies can sit between dataset ones
  }
  state.dirty.add("electricity/anomalies");
  if (state.view === "electricity/anomalies") show(state.view); else go("electricity/anomalies");
}

function rerender(views = Object.keys(VIEWS)) {
  views.forEach((v) => state.dirty.add(v));
  show(state.view, { scroll: false });
}

const ctx = {
  state, analyse, uploadFile, loadUci, runScenario, openEvent, go, rerender, reloadActive, setResult,
  refreshSettings: loadSettings, refreshNotifications,
  onRangeChange: () => state.res && rerender(["electricity/analytics", "electricity/alerts"]),
};

// ---------------- theme ----------------
initTheme();
charts.setChartTheme(document.documentElement.dataset.theme);
window.addEventListener("themechange", (e) => {
  charts.setChartTheme(e.detail.theme);
  if (state.user) rerender();  // charts are canvas: redraw them with the new palette
});
let themeSave;
window.addEventListener("themepref", (e) => {  // remember the choice on the account too (other devices pick it up)
  clearTimeout(themeSave);
  themeSave = setTimeout(() => state.user && patch("/api/settings", { appearance: { theme: e.detail.pref } }).then((c) => { state.cfg = c; }).catch(() => {}), 400);
});

// ---------------- boot ----------------
applyMotionPref();
initShell(ctx);
document.addEventListener("click", (e) => {
  const goto = e.target.closest("[data-goto]");
  if (goto) { e.preventDefault(); return go(goto.dataset.goto); }
  const ev = e.target.closest("[data-event]");
  if (ev && state.res) { e.preventDefault(); openEvent(+ev.dataset.event); }
});
document.addEventListener("keydown", (e) => {
  const t = e.target.closest?.("[data-event], a.alert[data-goto]");
  if (!t || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  if (t.dataset.event && state.res) openEvent(+t.dataset.event); else if (t.dataset.goto) go(t.dataset.goto);
});
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

(async () => {
  state.view = resolve(location.hash.slice(1) || "overview");
  if (location.hash.slice(1) === "data") state.settingsTab = "data";
  try {
    setUser(await api("/api/auth/me"));
    [state.sources] = await Promise.all([api("/api/sources"), loadSettings()]);
    adoptServerPref(state.cfg.settings.appearance?.theme);
  } catch (e) {
    toast(e.message, "error");
    return;
  }
  refreshNotifications();
  const q = new URLSearchParams(location.search);  // deep link, e.g. /dashboard?scenario=mixed&base=uci#lab
  if (state.sources.scenarios[q.get("scenario")]) {
    Object.assign(state, { scenario: q.get("scenario"), base: q.get("base") === "uci" ? "uci" : "synthetic", seed: +q.get("seed") || 7 });
    show(state.view, { scroll: false });
    await analyse(post("/api/datasets/scenario", { scenario: state.scenario, base: state.base, seed: state.seed }), "Injecting anomalies & detecting…");
    return;
  }
  if (NEEDS_ELECTRICITY.has(state.view)) viewEl(state.view).innerHTML = skeleton();
  try {
    setResult(await api("/api/datasets/active"));
  } catch (e) {
    if (e.status !== 404) { toast(e.message, "error"); setResult(null); return; }
    const list = await api("/api/datasets").catch(() => []);
    if (!list.length && state.sources.uci_available) {  // first visit: start with real public data so the app isn't empty
      show(state.view, { scroll: false });
      const ok = await analyse(post("/api/datasets/uci"), "Setting up your workspace with 4 years of real household data…");
      if (ok) toast("Loaded the public UCI household so you can explore. Add your own data any time.", "info");
    } else setResult(null);
  }
})();

export { TITLES };
