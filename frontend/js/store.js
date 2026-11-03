// Application state and API access. Every request carries the CSRF header; a 401 sends the user to sign in.
import { prefs } from "./ui.js";
import { ms } from "./format.js";

export const state = {
  user: null, cfg: null,       // signed-in user; settings payload from /api/settings
  res: null, view: "overview", dirty: new Set(), sources: null, selected: null,
  range: prefs.get("range") ?? 30, from: null, to: null,  // date window; range 0 = all, "custom" uses from/to (ms)
  alertTab: "priority", anomalyUtility: "electricity", settingsTab: "account",
  filters: { type: "all", severity: "all", origin: "all", read: "all" }, limit: 60, feedLimit: 12,
  scenario: "mixed", base: "synthetic", seed: 7,
};

export async function api(path, opts = {}) {
  const headers = { "X-Requested-With": "PowerPulse", ...opts.headers };
  let r;
  try { r = await fetch(path, { ...opts, headers, credentials: "same-origin" }); } catch { throw new Error("Can't reach the PowerPulse server. Start it with: python run.py"); }
  if (r.status === 401 && !path.startsWith("/api/auth/login")) {
    location.replace("/login?next=" + encodeURIComponent(location.pathname + location.hash));
    throw new Error("Your session has ended. Please sign in again.");
  }
  if (!r.ok) {
    let msg = await r.text();
    try {
      const d = JSON.parse(msg).detail ?? msg;
      msg = Array.isArray(d) ? d.map((x) => x.msg).join("; ") : d;
    } catch { /* plain-text error */ }
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = r.status;
    throw err;
  }
  const type = r.headers.get("content-type") || "";
  return type.includes("json") ? r.json() : r;
}
const json = (method) => (path, body) => api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
export const post = json("POST");
export const put = json("PUT");
export const patch = json("PATCH");
export const del = (path) => api(path, { method: "DELETE" });

/** The [fromMs, toMs] window selected in the header, or null for the whole dataset. */
export function rangeWindow() {
  const t = state.res?.hourly.t;
  if (!t?.length) return null;
  const first = t[0], last = t[t.length - 1];
  if (state.range === "custom" && state.from != null && state.to != null) {
    return [Math.max(first, state.from), Math.min(last, state.to + 864e5 - 36e5)];
  }
  if (!state.range) return null;
  return [Math.max(first, last - state.range * 864e5), last];
}

/** Events whose start falls inside the selected window. */
export function eventsInWindow() {
  const w = rangeWindow(), ev = state.res?.events ?? [];
  if (!w) return ev;
  return ev.filter((e) => { const s = ms(e.start); return s >= w[0] && s <= w[1]; });
}

/** Refresh settings + limits from the server. */
export async function loadSettings() {
  state.cfg = await api("/api/settings");
  return state.cfg;
}
