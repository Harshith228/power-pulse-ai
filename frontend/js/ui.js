// Small reusable UI primitives shared by the landing page and dashboard:
// preferences, reduced motion, count-up numbers, tooltips, dropdowns, modals, toasts and scroll reveals.
import { icon } from "./icons.js";

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- preferences (localStorage can throw in private mode, so every access is guarded) ----------
const PREF_KEY = "powerpulse.prefs";
const DEFAULT_PREFS = { sidebarCollapsed: false, motion: "auto", range: 30, showInjected: true, notifyAll: false, seen: {} };
export const prefs = (() => {
  let data = { ...DEFAULT_PREFS };
  try { Object.assign(data, JSON.parse(localStorage.getItem(PREF_KEY) || "{}")); } catch { /* use defaults */ }
  return {
    get: (k) => data[k],
    set(k, v) { data[k] = v; try { localStorage.setItem(PREF_KEY, JSON.stringify(data)); } catch { /* not persisted */ } },
    reset() { data = { ...DEFAULT_PREFS }; try { localStorage.removeItem(PREF_KEY); } catch { /* ignore */ } },
  };
})();

const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
export const reducedMotion = () => prefs.get("motion") === "reduce" || (prefs.get("motion") === "auto" && mq.matches);
export function applyMotionPref() { document.documentElement.classList.toggle("reduce-motion", reducedMotion()); }

// ---------- count-up numbers: <span data-count="1234.5" data-dec="1" data-prefix="₹" data-suffix="%"> ----------
const fmtCount = (v, dec, prefix = "", suffix = "") =>
  prefix + v.toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suffix;
export function countUp(root = document) {
  const els = $$("[data-count]", root);
  const still = reducedMotion();
  els.forEach((el) => {
    const end = +el.dataset.count, dec = +(el.dataset.dec || 0), { prefix = "", suffix = "" } = el.dataset;
    if (still || !Number.isFinite(end)) { el.textContent = fmtCount(end, dec, prefix, suffix); return; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmtCount(end * e, dec, prefix, suffix);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// ---------- tooltips: any element with data-tip; data-tip-when="collapsed" only fires when the sidebar is collapsed ----------
let tipEl;
export function initTooltips() {
  tipEl = document.createElement("div");
  tipEl.className = "tip";
  tipEl.setAttribute("role", "tooltip");
  document.body.appendChild(tipEl);
  const show = (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (!t) return;
    if (t.dataset.tipWhen === "collapsed" && !document.body.classList.contains("sb-collapsed")) return;
    tipEl.textContent = t.dataset.tip;
    const r = t.getBoundingClientRect(), side = t.dataset.tipSide || (t.dataset.tipWhen === "collapsed" ? "right" : "top");
    tipEl.classList.add("show");
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let x = side === "right" ? r.right + 10 : r.left + r.width / 2 - w / 2;
    let y = side === "right" ? r.top + r.height / 2 - h / 2 : r.top - h - 8;
    if (y < 4) y = r.bottom + 8;
    x = Math.max(6, Math.min(x, innerWidth - w - 6));
    tipEl.style.left = x + "px";
    tipEl.style.top = y + "px";
  };
  const hide = (e) => { if (e.target.closest?.("[data-tip]")) tipEl.classList.remove("show"); };
  document.addEventListener("mouseover", show);
  document.addEventListener("focusin", show);
  document.addEventListener("mouseout", hide);
  document.addEventListener("focusout", hide);
  window.addEventListener("scroll", () => tipEl.classList.remove("show"), { passive: true });
}

// ---------- dropdowns: <div class="dropdown" data-dd><button data-dd-toggle>…</button><div class="menu-pop">…</div></div> ----------
export function initDropdowns() {
  const closeAll = (except) => $$("[data-dd].open").forEach((d) => {
    if (d === except) return;
    d.classList.remove("open");
    d.querySelector("[data-dd-toggle]")?.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-dd-toggle]");
    if (toggle) {
      const dd = toggle.closest("[data-dd]");
      const open = !dd.classList.contains("open");
      closeAll(dd);
      dd.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      if (open) dd.dispatchEvent(new CustomEvent("dd:open"));
      return;
    }
    const dd = e.target.closest("[data-dd]");
    if (dd && e.target.closest("[data-dd-close]")) return closeAll();
    if (!dd) closeAll();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
  return closeAll;
}

// ---------- modal ----------
let lastFocus = null;
export function openModal({ title, body, wide = false, onMount }) {
  closeModal();
  lastFocus = document.activeElement;
  const wrap = document.createElement("div");
  wrap.className = "modal-wrap";
  wrap.innerHTML = `<div class="modal${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-h"><h3 id="modal-title">${title}</h3><button class="icon-btn" data-modal-close aria-label="Close">${icon("x")}</button></div>
    <div class="modal-b">${body}</div></div>`;
  document.body.appendChild(wrap);
  document.body.classList.add("no-scroll");
  requestAnimationFrame(() => wrap.classList.add("open"));
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-modal-close]")) closeModal(); });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
    if (e.key !== "Tab") return;  // keep focus inside the dialog
    const f = $$("button, a[href], input, select, [tabindex]:not([tabindex='-1'])", wrap).filter((x) => !x.disabled);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  onMount?.(wrap);
  (wrap.querySelector("[autofocus]") || wrap.querySelector(".modal-b button, .modal-b a") || wrap.querySelector("[data-modal-close]")).focus();
  return wrap;
}
export function closeModal() {
  const w = $(".modal-wrap");
  if (!w) return;
  w.remove();
  if (!$(".sidebar.open")) document.body.classList.remove("no-scroll");
  lastFocus?.focus?.();
}

// ---------- toasts (stacked, auto-dismiss) ----------
export function toast(msg, kind = "info") {
  let box = $("#toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  const kinds = { info: "info", success: "checkCircle", error: "alert" };
  t.className = `toast ${kind}`;
  t.innerHTML = `${icon(kinds[kind] || "info")}<span></span><button class="toast-x" aria-label="Dismiss">${icon("x")}</button>`;
  t.querySelector("span").textContent = msg;
  box.appendChild(t);
  const remove = () => { t.classList.add("out"); setTimeout(() => t.remove(), 250); };
  t.querySelector(".toast-x").addEventListener("click", remove);
  setTimeout(remove, kind === "error" ? 8000 : 4000);
}

// ---------- scroll reveal ----------
export function initReveal(root = document) {
  const els = $$(".reveal:not(.in)", root);
  if (reducedMotion() || !("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
  }), { threshold: 0, rootMargin: "0px 0px -40px 0px" });
  els.forEach((e) => io.observe(e));
}
