// Read/unread tracking for anomalies. An anomaly becomes read only when the user actually sees it: its row or card
// stays at least 60% on screen for SEEN_MS while the tab is in the foreground, or the user opens it - never because
// data was fetched. Marks are batched and sent to POST /api/anomalies/{utility}/read; the server keeps the state.
import { post } from "./store.js";
import { setAnomalyCounts } from "./shell.js";
import { toast } from "./ui.js";

const SEEN_MS = 1200;
const trackers = {};

export function readTracker(utility, onChange) {
  trackers[utility]?.disconnect();
  const timers = new Map(), queue = new Set();
  let flushTimer = null;
  const flush = async () => {
    flushTimer = null;
    const keys = [...queue];
    queue.clear();
    if (keys.length) await setRead(utility, keys, true, onChange);
  };
  const enqueue = (key) => {
    queue.add(key);
    flushTimer ??= setTimeout(flush, 400);
  };
  const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => entries.forEach((en) => {
    const key = en.target.dataset.key;
    if (en.isIntersecting && en.intersectionRatio >= 0.6) {
      if (!timers.has(key)) {
        timers.set(key, setTimeout(() => {
          timers.delete(key);
          if (document.visibilityState === "visible" && en.target.isConnected && en.target.dataset.read === "false") {
            io.unobserve(en.target);
            enqueue(key);
          }
        }, SEEN_MS));
      }
    } else {
      clearTimeout(timers.get(key));
      timers.delete(key);
    }
  }), { threshold: [0, 0.6] }) : null;
  const t = {
    observe(root) { root.querySelectorAll("[data-key][data-read=false]").forEach((n) => io?.observe(n)); },
    seen(key) { enqueue(key); },
    disconnect() { io?.disconnect(); timers.forEach(clearTimeout); timers.clear(); if (queue.size) flush(); },
  };
  trackers[utility] = t;
  return t;
}

/** Mark keys read (or unread). onChange(keys, read, counts) updates the page; the sidebar badge updates here. */
export async function setRead(utility, keys, read, onChange) {
  try {
    const r = await post(`/api/anomalies/${utility}/read`, { keys, read });
    setAnomalyCounts(r.counts);
    onChange?.(keys, read, r.counts);
    return r;
  } catch (e) {
    toast(e.message, "error");
    return null;
  }
}

export async function markAllRead(utility) {
  const r = await post(`/api/anomalies/${utility}/read-all`);
  setAnomalyCounts(r.counts);
  return r;
}

export const READ_OPTS = [["all", "All"], ["unread", "Unread"], ["read", "Read"]];
