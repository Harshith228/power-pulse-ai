// Landing page behaviour: sticky nav, mobile menu, active-section highlight, reveals, stat count-up.
import { hydrateIcons, logo } from "./icons.js";
import { $, $$, initReveal, reducedMotion, applyMotionPref } from "./ui.js";
import { initTheme } from "./theme.js";

initTheme();

// Old links pointed at the dashboard on "/" (e.g. /?scenario=mixed#lab); send them to /dashboard.
const DASH_VIEWS = ["overview", "consumption", "anomalies", "monitoring", "savings", "lab", "data", "settings"];
if (new URLSearchParams(location.search).has("scenario") || DASH_VIEWS.includes(location.hash.slice(1))) {
  location.replace("dashboard" + location.search + location.hash);
}

applyMotionPref();

// Signed in already? Keep the landing page, but offer "Continue to dashboard" instead of Sign in / Get started.
fetch("/api/auth/me", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((u) => {
  if (!u) return;
  $$(".nav-signin, .nav-link-m").forEach((a) => a.remove());
  $$(".nav-cta, .nav-cta-m").forEach((a) => { a.href = "/dashboard"; a.innerHTML = 'Continue to dashboard <i data-icon="arrowRight"></i>'; });
  $$("[data-cta]").forEach((a) => { a.href = "/dashboard"; a.firstChild.textContent = "Continue to dashboard "; });
  $$('a[href^="/login?next="]').forEach((a) => { a.href = decodeURIComponent(a.getAttribute("href").split("next=")[1]); });
  hydrateIcons();
}).catch(() => { /* offline: the public links still work */ });
$$("[data-logo]").forEach((e) => { e.outerHTML = logo(34); });
$$("[data-logo-sm]").forEach((e) => { e.outerHTML = logo(22); });
hydrateIcons();
document.body.classList.add("ready");

// ----- sticky nav -----
const nav = $("#nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 12);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

// ----- mobile menu -----
const burger = $("#burger"), links = $("#nav-links");
const setMenu = (open) => {
  nav.classList.toggle("menu-open", open);
  burger.setAttribute("aria-expanded", String(open));
  burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  burger.innerHTML = `<i data-icon="${open ? "x" : "menu"}"></i>`;
  hydrateIcons(burger);
  document.body.classList.toggle("no-scroll", open);
};
burger.addEventListener("click", () => setMenu(!nav.classList.contains("menu-open")));
links.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && nav.classList.contains("menu-open")) { setMenu(false); burger.focus(); } });
document.addEventListener("click", (e) => { if (nav.classList.contains("menu-open") && !nav.contains(e.target)) setMenu(false); });
window.matchMedia("(min-width: 961px)").addEventListener("change", (m) => m.matches && setMenu(false));

// ----- active section in nav -----
const sections = ["home", "features", "how", "technology", "about"].map((id) => document.getElementById(id));
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (!en.isIntersecting) return;
    $$(".nav-links a[href^='#']").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + en.target.id));
  }), { rootMargin: "-45% 0px -50% 0px" });
  sections.forEach((s) => s && io.observe(s));
}

// ----- reveals, workflow steps, stat count-up -----
initReveal();
const steps = $("#steps");
const statEls = $$(".stat b[data-to]");
const runStats = () => statEls.forEach((el) => {
  const to = +el.dataset.to, suffix = el.dataset.suffix || "";
  if (reducedMotion()) return;
  const t0 = performance.now(), dur = 1400;
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur), v = Math.round(to * (1 - Math.pow(1 - p, 3)));
    el.textContent = v.toLocaleString("en-US") + suffix;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
if ("IntersectionObserver" in window) {
  const once = (el, fn, threshold = 0.35) => {
    if (!el) return;
    const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { fn(); io.disconnect(); } }, { threshold });
    io.observe(el);
  };
  once(steps, () => steps.classList.add("go"));
  once($(".stats-grid"), runStats, 0.4);
} else {
  steps?.classList.add("go");
}

// ----- live server status (best effort, page works without it) -----
fetch("/api/sources").then((r) => (r.ok ? r.json() : null)).then((s) => {
  if (!s) return;
  const el = $("#server-status");
  el.innerHTML = `<span class="ok-dot"></span>Server online · ${s.uci_available ? "UCI dataset ready to analyse" : "demo scenarios ready"} · ${Object.keys(s.scenarios).length} validation scenarios`;
  el.hidden = false;
}).catch(() => { /* static preview without the API */ });
