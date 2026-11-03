// Settings: account, appearance (theme), notifications, monthly reports, electricity & water (limits,
// tariffs), detection thresholds, data & datasets, privacy.
import { state, api, post, patch } from "../store.js";
import { icon } from "../icons.js";
import { esc, fmtDay } from "../format.js";
import { prefs, applyMotionPref, toast, openModal, closeModal } from "../ui.js";
import { setCollapsed, setRange, setUser, timeAgo } from "../shell.js";
import { cardHead } from "../components.js";
import { switchRow as sw, bindSwitch, limitsForm, bindLimitsForm, tariffEditor, bindTariff } from "../forms.js";
import { getPref, setPref, THEME_ICON, THEME_LABEL } from "../theme.js";
import data from "./data.js";

const TABS = [["account", "Account", "user"], ["appearance", "Appearance", "palette"], ["notifications", "Notifications", "bell"], ["reports", "Monthly reports", "file"], ["electricity", "Electricity", "zap"], ["water", "Water", "droplet"],
  ["detection", "Detection", "sliders"], ["data", "Data & datasets", "database"], ["privacy", "Privacy & data", "shield"]];

const HEAD = {
  account: "Your profile, password and the devices signed in to your account.",
  appearance: "Theme and workspace preferences.",
  notifications: "Which alerts appear in the bell and the notification centre.",
  reports: "The automatic monthly report: when it's made and what it covers.",
  electricity: "Daily limit, warning threshold and tariff for electricity (kWh).",
  water: "Daily limit, warning threshold, tariff and display unit for water.",
  detection: "How sensitive electricity anomaly detection is.",
  data: "Electricity datasets, manual readings, water records, samples and smart meters.",
  privacy: "Account security, exporting your data and deleting your account.",
};

/** "Chrome on Windows" from a user-agent string (the raw string is kept in the tooltip). */
export function deviceLabel(ua = "") {
  const browser = /Edg\//.test(ua) ? "Edge" : /HeadlessChrome/.test(ua) ? "Headless Chrome" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari" : /python|httpx|curl|testclient/i.test(ua) ? "Script / API client" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

const pw = (id, label, auto) => `<label class="field"><span>${label}</span><span class="pw-wrap"><input type="password" name="${id}" autocomplete="${auto}" required>
  <button type="button" class="eye-btn" data-eye aria-label="Show password">${icon("eye")}</button></span></label>`;

async function accountTab() {
  const sessions = await api("/api/auth/sessions"), u = state.user;
  const shown = state.showAllSessions ? sessions : sessions.slice(0, 5);
  return `<div class="grid g2 set-grid">
    <div class="card reveal">${cardHead("Profile", "Your name and sign-in email")}
      <form id="profile" class="stack-form">
        <label class="field"><span>Full name</span><input type="text" name="name" value="${esc(u.name)}" maxlength="80" required autocomplete="name"></label>
        <label class="field"><span>Email</span><input type="email" name="email" value="${esc(u.email)}" required autocomplete="email"></label>
        <label class="field" id="email-pw" hidden><span>Current password (needed to change email)</span><input type="password" name="current_password" autocomplete="current-password"></label>
        <div><button class="btn primary" type="submit">${icon("check")}Save profile</button></div></form></div>
    <div class="card reveal">${cardHead("Password", "Changing your password signs out every other device.")}
      <form id="pwd" class="stack-form">${pw("current", "Current password", "current-password")}${pw("new", "New password (8+ characters, a letter and a number)", "new-password")}${pw("confirm", "Confirm new password", "new-password")}
        <div><button class="btn primary" type="submit">${icon("lock")}Change password</button></div></form></div>
    </div>
    <div class="card mt flush reveal"><div class="pad">${cardHead("Signed-in devices", `${sessions.length} active session${sessions.length === 1 ? "" : "s"}`,
      `<button class="btn sm" id="logout-others" ${sessions.length > 1 ? "" : "disabled"}>${icon("logOut")}Sign out other devices</button>`)}</div>
      <div class="table-wrap"><table class="mini sess-table"><thead><tr><th>Device</th><th>Signed in</th><th>Expires</th></tr></thead><tbody>
        ${shown.map((x) => `<tr><td data-l="Device" title="${esc(x.user_agent || "")}">${icon(/Mobile|Android|iPhone/.test(x.user_agent) ? "phone" : "monitor")}
          <b>${esc(deviceLabel(x.user_agent || ""))}</b>${x.current ? ' <span class="tag good">This device</span>' : ""}</td>
          <td data-l="Signed in" class="subtle">${timeAgo(x.created_at)}</td><td data-l="Expires" class="subtle">${fmtDay(x.expires_at)}</td></tr>`).join("")}</tbody></table></div>
      ${sessions.length > 5 ? `<div class="more-row"><button class="btn sm" id="sess-more">${state.showAllSessions ? "Show fewer" : `Show all ${sessions.length}`}</button></div>` : ""}</div>`;
}

function appearanceTab() {
  const pref = getPref();
  return `<div class="card reveal">${cardHead("Theme", "Applies to every page, chart, form and dialog. Saved on this device and to your account.")}
    <div class="theme-cards" role="radiogroup" aria-label="Theme">${["light", "dark", "system"].map((p) => `
      <button type="button" role="radio" aria-checked="${pref === p}" class="theme-card ${p}" data-theme-pick="${p}">
        <span class="tc-preview" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="tc-label">${icon(THEME_ICON[p])}<b>${THEME_LABEL[p]}</b>${pref === p ? icon("checkCircle", "tc-check") : ""}</span>
        <small>${p === "system" ? "Follows your device - switches automatically" : p === "dark" ? "Dark surfaces, comfortable at night" : "Bright surfaces with dark text"}</small></button>`).join("")}</div>
    <p class="note">Currently showing: <b>${document.documentElement.dataset.theme}</b>${pref === "system" ? " (from your device setting)" : ""}. Quick switch: the ${icon("sun")} button in the top bar.</p></div>
  <div class="card mt reveal">${cardHead("Workspace", "Saved in this browser only")}
    ${sw("set-collapse", "Collapsed sidebar", "Show icons only; Electricity and Water open as flyouts. Shortcut: <kbd>[</kbd>", document.body.classList.contains("sb-collapsed"))}
    <div class="set-row"><div><b>Motion</b><p>Animations respect your system's reduced-motion setting by default.</p></div>
      <div class="seg" id="set-motion">${[["auto", "System"], ["full", "On"], ["reduce", "Reduced"]].map(([v, l]) => `<button type="button" data-v="${v}" class="${prefs.get("motion") === v ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="set-row"><div><b>Default date range</b><p>For electricity time-series charts.</p></div>
      <div class="seg" id="set-range">${[[7, "7D"], [30, "30D"], [90, "90D"], [0, "All"]].map(([v, l]) => `<button type="button" data-v="${v}" class="${prefs.get("range") === v ? "on" : ""}">${l}</button>`).join("")}</div></div>
    ${sw("set-injected", "Show ground-truth bands", "Purple bands for injected anomalies in the Validation Lab chart.", prefs.get("showInjected") !== false)}</div>`;
}

function notificationsTab() {
  const s = state.cfg.settings, kinds = state.cfg.notification_kinds;
  const groups = { electricity: "Electricity", water: "Water", report: "Monthly reports" };
  return `<form id="notif-form" class="grid g2 set-grid">
    <div class="card reveal">${cardHead("Electricity and water alerts", "Shown in the bell and the notification centre")}
    <table class="matrix"><thead><tr><th>Notification</th><th>In-app</th></tr></thead><tbody>
      ${Object.entries(groups).map(([g, gl]) => `<tr class="grp"><td colspan="2">${gl}</td></tr>` + Object.entries(kinds).filter(([, v]) => v.category === g).map(([k, v]) => `<tr><td>${esc(v.label)}</td>
        <td><input type="checkbox" name="${k}:in_app" ${s.notifications[k].in_app ? "checked" : ""} aria-label="${esc(v.label)} in-app"></td></tr>`).join("")).join("")}
    </tbody></table></div>
    <div class="card reveal">${cardHead("Anomaly notifications", "How serious an unusual reading must be to notify you")}
    <label class="field"><span>Alert me about anomalies of at least</span><select name="min_sev">${["low", "medium", "high", "critical"].map((x) => `<option value="${x}" ${s.anomaly_min_severity === x ? "selected" : ""}>${x[0].toUpperCase() + x.slice(1)} severity</option>`).join("")}</select></label>
    <p class="note">Only anomalies from the last 7 days of data notify you, and each limit warning, breach, anomaly and report notifies once.
      Every anomaly is still listed on the Anomaly Detection pages, whatever you choose here.</p>
    <div class="inline" style="margin-top:14px"><button class="btn primary" type="submit">${icon("check")}Save preferences</button><button class="btn" type="reset">Cancel</button></div></div></form>`;
}

function reportsTab() {
  const r = state.cfg.settings.reports;
  const kind = r.include_electricity && r.include_water ? "combined" : r.include_electricity ? "electricity" : "water";
  return `<div class="card reveal rep-settings">
    <div class="card-h"><div><h3>Automatic monthly report</h3><p>Generated once for the previous month on your chosen day - never duplicated.</p></div>
      <button type="button" class="switch" id="rep-enabled" role="switch" aria-checked="${r.enabled}" aria-label="Generate reports automatically"><span></span></button></div>
    <div class="rep-set-grid">
      <label class="field"><span>Delivery day</span><small class="hint">Day 1–28, so it exists in every month</small>
        <select id="rep-day">${Array.from({ length: 28 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${r.day === d ? "selected" : ""}>Day ${d}</option>`).join("")}</select></label>
      <label class="field"><span>Report type</span><small class="hint">What the report covers</small>
        <select id="rep-kind">${[["electricity", "Electricity"], ["water", "Water"], ["combined", "Electricity + Water"]].map(([v, l]) =>
          `<option value="${v}" ${kind === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    </div>
    <div class="inline rep-set-actions"><button class="btn primary" id="rep-save">${icon("check")}Save</button><a class="btn" data-goto="reports">${icon("file")}Open reports</a></div>
  </div>`;
}

function utilityTab(util) {
  const s = state.cfg.settings[util];
  return `<div class="grid g2">
    <div class="card reveal">${cardHead(`${util === "water" ? "Water" : "Electricity"} daily limit`, util === "water" ? `Shown in ${s.unit}` : "kWh per day", `<a class="link" data-goto="${util}/limit">View history</a>`)}${limitsForm(util)}</div>
    <div class="card reveal">${cardHead(`${util === "water" ? "Water" : "Electricity"} tariff (INR)`, util === "water" ? "Slabs are monthly kilolitres (kL)." : "Slabs are monthly kWh.")}
      ${tariffEditor(util)}
      ${util === "water" ? `<div class="set-row" style="margin-top:12px"><div><b>Display water in</b><p>Stored internally in litres either way.</p></div>
        <div class="seg" id="wunit">${[["L", "Litres"], ["kL", "Kilolitres"]].map(([v, l]) => `<button type="button" data-v="${v}" class="${s.unit === v ? "on" : ""}">${l}</button>`).join("")}</div></div>` : ""}</div>
  </div>`;
}

function detectionTab() {
  const d = state.cfg.settings.detection, b = state.cfg.defaults.detection_bounds, def = state.cfg.defaults.detection;
  const field = (k, label, help, step, scale = 1, suffix = "") => `<label class="field"><span>${label} <small class="subtle">(default ${+(def[k] * scale).toFixed(3)}${suffix})</small></span>
    <input type="number" name="${k}" min="${+(b[k][0] * scale).toFixed(3)}" max="${+(b[k][1] * scale).toFixed(3)}" step="${step}" value="${+(d[k] * scale).toFixed(3)}" data-scale="${scale}">
    <small class="hint">${help}</small></label>`;
  return `<div class="card reveal">${cardHead("Electricity detection thresholds", "Make detection more or less sensitive. Changes re-run the analysis and update anomalies and alerts. (Water rules are fixed and listed on Water > Anomaly Detection.)")}
    <form id="det" class="det-grid">
      <fieldset><legend>Sudden spikes</legend>
        ${field("spike_z", "Robust z-score", "How many 'normal spreads' above the expected hour counts as unusual.", 0.1)}
        ${field("if_rarity", "Isolation Forest rarity", "The hour must also be rarer than this share of all hours.", 0.1, 100, "%")}
        ${field("min_excess_kwh", "Minimum extra energy (kWh)", "Ignore tiny deviations below this.", 0.05)}</fieldset>
      <fieldset><legend>Sustained increases</legend>
        ${field("sustain_ratio", "Daily total vs baseline", "e.g. 120% = a day 20% above its 4-week baseline counts as elevated.", 1, 100, "%")}
        ${field("sustain_min_days", "Minimum consecutive days", "Elevated days in a row that make a sustained increase.", 1)}</fieldset>
      <fieldset><legend>Night-time increases</legend>
        ${sw("night_enabled", "Detect night-time increases", "Nights well above the previous two weeks of nights.", d.night_enabled)}
        <div class="grid g2"><label class="field"><span>Night starts</span><select name="night_start">${[...Array(24).keys()].map((h) => `<option value="${h}" ${d.night_start === h ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("")}</select></label>
          <label class="field"><span>Night ends</span><select name="night_end">${[...Array(24).keys()].map((h) => `<option value="${h}" ${d.night_end === h ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("")}</select></label></div>
        ${field("night_ratio", "Night total vs typical night", "e.g. 200% = twice a normal night.", 5, 100, "%")}
        ${field("night_min_excess_kwh", "Minimum extra per night (kWh)", "Avoids flagging tiny night-time loads.", 0.1)}</fieldset>
      <div class="inline det-actions"><button class="btn primary" type="submit">${icon("check")}Apply & re-analyse</button><button class="btn ghost" type="button" id="det-reset">${icon("refresh")}Reset to defaults</button>
        <a class="link" data-goto="lab">Measure accuracy in the Validation Lab</a></div>
    </form></div>`;
}

function privacyTab() {
  return `<div class="grid g2">
    <div class="card reveal">${cardHead("Account security", "")}
      <ul class="checks-list"><li>${icon("lock")}<span>Passwords are stored only as salted scrypt hashes.</span></li>
        <li>${icon("key")}<span>Sessions use secure, HTTP-only cookies and expire automatically.</span></li>
        <li>${icon("shield")}<span>Every request is checked against your account - other users can't see your data.</span></li></ul>
      <div class="inline" style="margin-top:12px"><button class="btn" data-stab-go="account">${icon("lock")}Change password</button><button class="btn" id="p-logout-others">${icon("logOut")}Sign out other devices</button></div></div>
    <div class="card reveal">${cardHead("Your data", "Download everything stored about you, or delete your account.")}
      <div class="inline"><button class="btn" id="p-export">${icon("download")}Export my data (JSON)</button><button class="btn danger" id="p-delete">${icon("trash")}Delete account</button></div>
      <p class="note">Deleting your account permanently removes your datasets, water records, limits, notifications and reports.</p></div>
  </div>`;
}

export default async function settings(el, ctx) {
  await ctx.refreshSettings();  // forms always show what the server has now
  const tab = TABS.some(([v]) => v === state.settingsTab) ? state.settingsTab : "account";
  const body = tab === "account" ? await accountTab() : tab === "appearance" ? appearanceTab()
    : tab === "electricity" || tab === "water" ? utilityTab(tab) : tab === "detection" ? detectionTab() : tab === "notifications" ? notificationsTab()
    : tab === "reports" ? reportsTab() : tab === "privacy" ? privacyTab() : '<div id="data-host"></div>';
  el.innerHTML = `<div class="settings-layout"><nav class="set-tabs" role="tablist" aria-label="Settings sections">${TABS.map(([v, l, ic]) =>
    `<button role="tab" data-stab="${v}" aria-selected="${tab === v}">${icon(ic)}<span>${l}</span></button>`).join("")}</nav>
    <div class="set-body"><header class="set-head"><h2>${TABS.find(([v]) => v === tab)[1]}</h2><p>${HEAD[tab]}</p></header>${body}</div></div>`;
  if (tab === "data") await data(el.querySelector("#data-host"), ctx);

  const again = () => ctx.rerender([ctx.state.view]);
  const savePatch = async (patchBody, msg = "Settings saved", reload = false) => {
    try {
      state.cfg = await patch("/api/settings", patchBody);
      toast(msg, "success");
      ctx.refreshNotifications();
      if (reload) await ctx.reloadActive(); else again();
    } catch (err) { toast(err.message, "error"); }
  };
  el.querySelectorAll("[data-stab]").forEach((b) => b.addEventListener("click", () => { state.settingsTab = b.dataset.stab; again(); }));
  el.querySelectorAll("[data-stab-go]").forEach((b) => b.addEventListener("click", () => { state.settingsTab = b.dataset.stabGo; again(); }));
  el.querySelectorAll("[data-eye]").forEach((b) => b.addEventListener("click", () => {
    const i = b.previousElementSibling, show = i.type === "password";
    i.type = show ? "text" : "password";
    b.innerHTML = icon(show ? "eyeOff" : "eye");
    b.setAttribute("aria-label", show ? "Hide password" : "Show password");
  }));

  // ---- account ----
  const prof = el.querySelector("#profile");
  if (prof) {
    prof.elements.email.addEventListener("input", (e) => { el.querySelector("#email-pw").hidden = e.target.value.trim().toLowerCase() === state.user.email; });
    prof.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        setUser(await patch("/api/auth/profile", { name: prof.elements.name.value, email: prof.elements.email.value, current_password: prof.elements.current_password.value || null }));
        toast("Profile saved", "success"); again();
      } catch (err) { toast(err.message, "error"); }
    });
    el.querySelector("#pwd").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.elements.new.value !== f.elements.confirm.value) { toast("New passwords don't match.", "error"); return; }
      try { await post("/api/auth/password", { current_password: f.elements.current.value, new_password: f.elements.new.value }); toast("Password changed. Other devices were signed out.", "success"); f.reset(); }
      catch (err) { toast(err.message, "error"); }
    });
  }
  const logoutOthers = async () => { const r = await post("/api/auth/logout-others"); toast(`Signed out ${r.signed_out} other session${r.signed_out === 1 ? "" : "s"}`, "success"); again(); };
  el.querySelector("#logout-others")?.addEventListener("click", logoutOthers);
  el.querySelector("#sess-more")?.addEventListener("click", () => { state.showAllSessions = !state.showAllSessions; again(); });
  el.querySelector("#p-logout-others")?.addEventListener("click", logoutOthers);

  // ---- appearance ----
  el.querySelectorAll("[data-theme-pick]").forEach((b) => b.addEventListener("click", () => {
    setPref(b.dataset.themePick);
    toast(`Theme: ${THEME_LABEL[b.dataset.themePick]}`, "success");
    again();  // the preference can change without the visible theme changing (e.g. Light -> System on a light device)
  }));
  bindSwitch(el, "set-collapse", (on) => setCollapsed(on));
  bindSwitch(el, "set-injected", (on) => { prefs.set("showInjected", on); state.dirty.add("lab"); });
  el.querySelectorAll("#set-motion button").forEach((b) => b.addEventListener("click", () => { prefs.set("motion", b.dataset.v); applyMotionPref(); again(); }));
  el.querySelectorAll("#set-range button").forEach((b) => b.addEventListener("click", () => { setRange(+b.dataset.v); again(); }));

  // ---- utilities ----
  ["electricity", "water"].forEach((util) => {
    bindLimitsForm(el, util, () => { ctx.refreshNotifications(); again(); });
    bindTariff(el, util, () => (util === "electricity" ? ctx.reloadActive() : again()));
  });
  el.querySelectorAll("#wunit button").forEach((b) => b.addEventListener("click", () => savePatch({ water: { unit: b.dataset.v } }, "Display unit saved")));

  // ---- detection ----
  const det = el.querySelector("#det");
  if (det) {
    bindSwitch(el, "night_enabled");
    const busy = (p) => { const l = document.querySelector("#loading"); document.querySelector("#loading-text").textContent = "Re-analysing with new thresholds…"; l.hidden = false; p.finally(() => { l.hidden = true; }); };
    det.addEventListener("submit", (e) => {
      e.preventDefault();
      const cfg = { night_enabled: el.querySelector("#night_enabled").getAttribute("aria-checked") === "true", night_start: +det.elements.night_start.value, night_end: +det.elements.night_end.value };
      det.querySelectorAll("input[type=number]").forEach((i) => { cfg[i.name] = +i.value / +i.dataset.scale; });
      busy(savePatch({ detection: cfg }, "Thresholds applied - analysis updated", true));
    });
    el.querySelector("#det-reset").addEventListener("click", () => busy(savePatch({ reset_detection: true }, "Detection reset to defaults", true)));
  }

  // ---- notifications ----
  el.querySelector("#notif-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const out = {};
    e.target.querySelectorAll("input[type=checkbox]:not(:disabled)").forEach((i) => { const [k, ch] = i.name.split(":"); (out[k] ||= {})[ch] = i.checked; });
    savePatch({ notifications: out, anomaly_min_severity: e.target.elements.min_sev.value }, "Notification preferences saved");
  });

  // ---- reports ----
  bindSwitch(el, "rep-enabled");
  el.querySelector("#rep-save")?.addEventListener("click", () => {
    const on = (id) => el.querySelector("#" + id).getAttribute("aria-checked") === "true";
    savePatch({ reports: { enabled: on("rep-enabled"), day: +el.querySelector("#rep-day").value, include_electricity: el.querySelector("#rep-kind").value !== "water", include_water: el.querySelector("#rep-kind").value !== "electricity" } }, "Report preferences saved");
  });

  // ---- privacy ----
  el.querySelector("#p-export")?.addEventListener("click", async () => {
    const d = await api("/api/auth/export");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
    a.download = `powerpulse-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  el.querySelector("#p-delete")?.addEventListener("click", () => openModal({
    title: "Delete your account?",
    body: `<p>This permanently deletes your account and all of its data. It can't be undone.</p>
      <form id="del-acc" class="stack-form">${pw("password", "Enter your password to confirm", "current-password")}
      <div class="inline" style="justify-content:flex-end"><button class="btn" type="button" data-modal-close>Cancel</button><button class="btn danger" type="submit">${icon("trash")}Delete account</button></div></form>`,
    onMount: (w) => {
      w.querySelector("[data-eye]").addEventListener("click", (e) => { const i = e.currentTarget.previousElementSibling; i.type = i.type === "password" ? "text" : "password"; });
      w.querySelector("#del-acc").addEventListener("submit", async (e) => {
        e.preventDefault();
        try { await post("/api/auth/delete-account", { password: e.target.elements.password.value }); closeModal(); location.replace("/"); }
        catch (err) { toast(err.message, "error"); }
      });
    },
  }));
}
