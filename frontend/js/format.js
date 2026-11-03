// Naive ISO timestamps from the API are treated as UTC so wall-clock hours never shift.
// Strings that already carry a zone (Z or +05:30) are parsed as-is (server timestamps).
export const ms = (iso) => Date.parse(iso.length <= 10 ? iso + "T00:00:00Z" : /([zZ]|[+-]\d\d:\d\d)$/.test(iso) ? iso : iso + "Z");

const dt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const dd = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });
const wd = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" });
const toMs = (x) => (typeof x === "number" ? x : ms(x));

export const fmtTime = (x) => `${wd.format(toMs(x))} ${dt.format(toMs(x))}`;
export const fmtDay = (x) => dd.format(toMs(x));
export const isoDay = (x) => new Date(toMs(x)).toISOString().slice(0, 10);
export const hourLabel = (h) => `${String(h).padStart(2, "0")}:00`;
export const inr = (v) => "₹" + Math.round(v ?? 0).toLocaleString("en-IN");
export const num = (v, d = 1) => (v ?? 0).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
export const pct = (v, d = 0) => `${((v ?? 0) * 100).toFixed(d)}%`;
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const sum = (a) => a.reduce((x, y) => x + (y ?? 0), 0);
