// Runs synchronously in <head> before first paint (a classic script, not a module) so the page never flashes the
// wrong theme or sidebar width. Kept in a file so the Content-Security-Policy can forbid inline scripts.
(function () {
  var root = document.documentElement, theme = "light", prefs = {};
  try {
    var p = localStorage.getItem("powerpulse.theme");
    theme = p === "dark" || (p !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    prefs = JSON.parse(localStorage.getItem("powerpulse.prefs") || "{}");
  } catch { /* storage blocked: defaults */ }
  root.setAttribute("data-theme", theme);
  if (prefs.sidebarCollapsed) root.classList.add("pre-collapsed");
  window.addEventListener("pageshow", function (e) { if (e.persisted) location.reload(); });
})();
