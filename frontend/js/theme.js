// Light / Dark / System theme. The preference lives in localStorage ("powerpulse.theme") so an inline <head> script can
// apply it before first paint (no flash). "system" follows the OS and updates live when the OS theme changes; an
// explicit light/dark choice is never overridden. Signed-in users also get the choice saved to their account.
const KEY = "powerpulse.theme";
const mq = window.matchMedia("(prefers-color-scheme: dark)");

export function getPref() {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}
export const resolved = (pref = getPref()) => (pref === "dark" || (pref === "system" && mq.matches) ? "dark" : "light");
export const isDark = () => document.documentElement.dataset.theme === "dark";

function apply(animate) {
  const root = document.documentElement, next = resolved();
  if (root.dataset.theme === next) return;
  if (animate) {
    root.classList.add("theme-anim");
    setTimeout(() => root.classList.remove("theme-anim"), 350);
  }
  root.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#0a1120" : "#0a1324");
  window.dispatchEvent(new CustomEvent("themechange", { detail: { theme: next, pref: getPref() } }));
}

export function setPref(pref) {
  try { if (pref === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch { /* still applies this session */ }
  apply(true);
  window.dispatchEvent(new CustomEvent("themepref", { detail: { pref } }));
}

/** Adopt the account's saved preference when this browser has none yet. */
export function adoptServerPref(pref) {
  let local = null;
  try { local = localStorage.getItem(KEY); } catch { /* ignore */ }
  if (!local && (pref === "light" || pref === "dark")) { try { localStorage.setItem(KEY, pref); } catch { /* ignore */ } apply(false); }
}

export function initTheme() {
  apply(false);
  mq.addEventListener("change", () => { if (getPref() === "system") apply(true); });
  window.addEventListener("storage", (e) => { if (e.key === KEY) apply(true); });  // other tabs
}

export const THEME_ICON = { light: "sun", dark: "moonStar", system: "monitor" };
export const THEME_LABEL = { light: "Light", dark: "Dark", system: "System" };
