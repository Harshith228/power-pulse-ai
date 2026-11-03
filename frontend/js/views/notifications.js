// Notification centre.
import { state, api, post } from "../store.js";
import { icon } from "../icons.js";
import { esc } from "../format.js";
import { toast } from "../ui.js";
import { emptyState } from "../components.js";
import { timeAgo, notificationTarget, openNotification, refreshNotifications } from "../shell.js";

const CATS = [["all", "All", "inbox"], ["electricity", "Electricity", "zap"], ["water", "Water", "droplet"], ["report", "Monthly reports", "file"], ["account", "Account", "user"]];
const STATUS = [["all", "All"], ["unread", "Unread"], ["read", "Read"]];

export default async function notifications(el, ctx) {
  const f = state.notifFilter || (state.notifFilter = { category: "all", status: "all", limit: 30 });
  const d = await api(`/api/notifications?category=${f.category}&status=${f.status}&limit=${f.limit}`);
  const seg = (key, opts) => `<div class="seg" role="group" aria-label="${key}">${opts.map(([v, l, ic]) => `<button data-${key}="${v}" class="${f[key] === v ? "on" : ""}" aria-pressed="${f[key] === v}">${ic ? icon(ic) : ""}${l}</button>`).join("")}</div>`;
  el.innerHTML = `
    <div class="filters">${seg("category", CATS)}${seg("status", STATUS)}
      <span class="count-note inline"><span class="subtle">${d.total} shown · ${d.unread} unread</span>
        <button class="btn sm" id="all-read" ${d.unread ? "" : "disabled"}>${icon("checkCheck")}Mark all read</button>
        <a class="btn sm ghost" data-goto="settings" data-settings-tab="notifications">${icon("sliders")}Preferences</a></span></div>
    <div class="card flush">
      ${d.items.length ? `<ul class="nc-list">${d.items.map((n) => `
        <li class="nc ${n.read ? "read" : "unread"} ${n.severity}">
          <span class="nc-ic ${n.category}">${icon({ electricity: "zap", water: "droplet", report: "file", account: "user" }[n.category] || "bell")}</span>
          <div class="nc-body"><div class="nc-top"><b>${esc(n.title)}</b>${n.read ? "" : '<span class="n-new">New</span>'}</div>
            <p>${esc(n.body)}</p>
            <div class="nc-meta"><time datetime="${n.created_at}" title="${new Date(n.created_at).toLocaleString()}">${timeAgo(n.created_at)}</time></div></div>
          <div class="nc-actions"><button class="btn sm" data-open="${n.id}" data-target="${notificationTarget(n)}" data-cat="${n.category}">View ${icon("arrowRight")}</button>
            <button class="icon-btn sm" data-toggle="${n.id}" data-read="${n.read}" aria-label="${n.read ? "Mark as unread" : "Mark as read"}" data-tip="${n.read ? "Mark as unread" : "Mark as read"}">${icon(n.read ? "mail" : "check")}</button></div>
        </li>`).join("")}</ul>
        ${d.total > d.items.length ? `<div class="more-row"><button class="btn sm" id="nc-more">Load more (${d.total - d.items.length} left)</button></div>` : ""}`
      : emptyState("No notifications", f.status === "unread" ? "You're all caught up." : "Limit warnings, unusual consumption and monthly reports will appear here.", "", "bell")}
    </div>
    <p class="note">PowerPulse never sends the same alert twice: each limit warning, limit breach, anomaly and monthly report is recorded once per day / event / month.</p>`;
  const reload = () => { refreshNotifications(); ctx.rerender([ctx.state.view]); };
  el.querySelectorAll("[data-category]").forEach((b) => b.addEventListener("click", () => { f.category = b.dataset.category; f.limit = 30; reload(); }));
  el.querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", () => { f.status = b.dataset.status; f.limit = 30; reload(); }));
  el.querySelector("#nc-more")?.addEventListener("click", () => { f.limit += 30; reload(); });
  el.querySelector("#all-read")?.addEventListener("click", async () => { await post("/api/notifications/read", { all: true }); toast("All notifications marked as read", "success"); reload(); });
  el.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", async () => {
    try { await post(b.dataset.read === "true" ? "/api/notifications/unread" : "/api/notifications/read", { ids: [+b.dataset.toggle] }); reload(); }
    catch (err) { toast(err.message, "error"); }
  }));
  el.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openNotification(+b.dataset.open, b.dataset.target)));
}
