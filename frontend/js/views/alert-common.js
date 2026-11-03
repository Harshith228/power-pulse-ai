// Pieces shared by the Electricity and Water "Alerts" pages.
import { state, api } from "../store.js";
import { icon } from "../icons.js";
import { esc } from "../format.js";
import { cardHead, emptyState } from "../components.js";
import { timeAgo, notificationTarget } from "../shell.js";

const KINDS = {
  electricity: [["elec_limit_warning", "Daily limit warning"], ["elec_limit_reached", "Daily limit reached"], ["elec_anomaly", "Unusual consumption"]],
  water: [["water_limit_warning", "Daily limit warning"], ["water_limit_reached", "Daily limit reached"], ["water_anomaly", "Unusual consumption"]],
};

/** Which alerts this user receives for a utility, and whether they appear in-app. */
export function alertSettingsCard(utility) {
  const s = state.cfg.settings;
  const chip = (on, label) => `<span class="dchip ${on ? "good" : ""}">${icon(on ? "check" : "x")}${label}</span>`;
  return `<div class="card reveal">${cardHead("Your alert settings", "", '<a class="link" data-goto="settings" data-settings-tab="notifications">Change</a>')}
    <ul class="alert-prefs">${KINDS[utility].map(([k, l]) => `<li><span>${l}</span><span class="inline">${chip(s.notifications[k].in_app, "In-app")}</span></li>`).join("")}</ul>
    <p class="note">Limit alerts ${s[utility].notify_limits ? "on" : "off"} · warning at ${s[utility].warn_pct}% · anomalies of ${s.anomaly_min_severity}+ severity from the last 7 days of data.</p></div>`;
}

/** Recent notifications for one utility (limit warnings, breaches and anomaly alerts). */
export async function notificationFeed(utility) {
  const d = await api(`/api/notifications?category=${utility}&limit=8`);
  return `<div class="card reveal">${cardHead("Recent alert notifications", `${d.total} sent for ${utility}`, '<a class="link" data-goto="notifications">All</a>')}
    ${d.items.length ? `<div class="mini-list">${d.items.map((n) => `<a class="mini-row notif-row ${n.read ? "" : "unread"}" data-goto="${notificationTarget(n)}">
      <span class="n-ic ${n.category}">${icon(n.kind.includes("limit") ? "gauge" : "scan")}</span>
      <span class="mr-t"><b>${esc(n.title)}</b><small>${timeAgo(n.created_at)}</small></span></a>`).join("")}</div>`
      : emptyState("No alerts yet", "Limit warnings, limit breaches and unusual consumption will appear here.", "", "bell")}</div>`;
}
