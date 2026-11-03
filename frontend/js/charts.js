// ECharts builders. Timestamps from the API are naive wall-clock times sent as epoch ms,
// so every chart runs with useUTC to show the household's own clock hours.
/* global echarts */
import { fmtTime, fmtDay, ms, inr, hourLabel } from "./format.js";
import { reducedMotion } from "./ui.js";

// Chart palettes per theme. Both were checked with the dataviz palette validator against their card surface
// (light #ffffff, dark #111b2e): lightness band, chroma, colour-blind separation and >= 3:1 contrast all pass.
const PALETTES = {
  light: {
    ink: "#0f172a", ink2: "#475569", muted: "#64748b", grid: "#e8edf3", axis: "#cbd5e1", surface: "#ffffff",
    s1: "#2563eb", s2: "#e0662f", water: "#0891b2", baseline: "#64748b", violet: "#5b4bc4", anomaly: "#dc2626", good: "#059669",
    sev: { low: "#2563eb", medium: "#f59e0b", high: "#ea580c", critical: "#dc2626" },
    seq: ["#dbe7fe", "#b3cdfb", "#7eaaf6", "#4f86ee", "#2563eb", "#1b48b8", "#13337f"],
    zoomFill: "rgba(37,99,235,0.10)", zoomBg: "#eef2f7", zoomHandle: "#dbe7fe", shadow: "rgba(15,23,42,0.04)", tipShadow: "rgba(15,23,42,.14)",
  },
  dark: {
    ink: "#e8eef8", ink2: "#b2bfd4", muted: "#8e9db6", grid: "#22314b", axis: "#33435f", surface: "#111b2e",
    s1: "#3b82f6", s2: "#d95926", water: "#22d3ee", baseline: "#8e9db6", violet: "#a78bfa", anomaly: "#f87171", good: "#34d399",
    sev: { low: "#60a5fa", medium: "#fbbf24", high: "#fb923c", critical: "#f87171" },
    seq: ["#13254a", "#173a7a", "#1d4fae", "#2563eb", "#3b82f6", "#7aa7f7", "#bcd3fb"],
    zoomFill: "rgba(59,130,246,0.18)", zoomBg: "#15213a", zoomHandle: "#1d4fae", shadow: "rgba(255,255,255,0.04)", tipShadow: "rgba(0,0,0,.5)",
  },
};
export const C = { ...PALETTES.light, sev: { ...PALETTES.light.sev } };
let SEQ = C.seq;

/** Switch every chart builder to the light or dark palette (call before re-rendering charts). */
export function setChartTheme(theme) {
  const p = PALETTES[theme] || PALETTES.light;
  Object.assign(C, p, { sev: { ...p.sev } });
  SEQ = C.seq;
}
setChartTheme(document.documentElement.dataset.theme);

// one ResizeObserver keeps every chart sized to its card (sidebar collapse, drawer, window resize)
const live = new Map(), refit = new Map();  // refit: per-chart layout that depends on the card's width
const resize = (el, c) => { refit.get(el)?.(); c.resize(); };
const ro = "ResizeObserver" in window ? new ResizeObserver((entries) => entries.forEach((e) => { const c = live.get(e.target); if (c) resize(e.target, c); })) : null;
if (!ro) window.addEventListener("resize", () => live.forEach((c, el) => resize(el, c)));

// A chart drawn while off-screen (below the fold, or in a view that isn't shown yet) replays its entrance
// the first time it actually comes into view, so the animation is seen instead of wasted. Same option,
// same data: only the drawing is repeated.
const unseen = "IntersectionObserver" in window ? new IntersectionObserver((entries) => entries.forEach((e) => {
  if (!e.isIntersecting || e.intersectionRect.height < 24) return;
  unseen.unobserve(e.target);
  const c = live.get(e.target);
  if (!c || reducedMotion()) return;
  const o = c.getOption();
  if (o) { c.clear(); c.setOption(o); }
}), { threshold: 0.2 }) : null;
const inView = (el) => {
  const r = el.getBoundingClientRect();
  return r.height > 0 && r.top < innerHeight && r.bottom > 0;
};

function mount(el) {
  const old = live.get(el);
  if (old) { old.dispose(); ro?.unobserve(el); unseen?.unobserve(el); }
  refit.delete(el);
  for (const [k, c] of live) if (!k.isConnected) { c.dispose(); live.delete(k); refit.delete(k); ro?.unobserve(k); unseen?.unobserve(k); }  // views re-render their DOM
  const chart = echarts.init(el, null, { renderer: "canvas" });
  live.set(el, chart);
  ro?.observe(el);
  if (unseen && !reducedMotion() && !inView(el)) unseen.observe(el);
  return chart;
}
export function resizeAll() { live.forEach((c, el) => resize(el, c)); }

const font = { fontFamily: "Inter, system-ui, sans-serif" };
export const MOTION = { enter: 650, update: 450, stagger: 12, maxDelay: 240 };
const anim = () => (reducedMotion() ? { animation: false } : {
  animation: true, animationDuration: MOTION.enter, animationEasing: "cubicOut",
  animationDurationUpdate: MOTION.update, animationEasingUpdate: "cubicInOut",
  animationDelay: (i) => Math.min(i * MOTION.stagger, MOTION.maxDelay),  // bars grow left to right, briefly
  animationThreshold: 3000,  // very long series draw instantly rather than stutter
});
const tooltip = (extra = {}) => ({
  backgroundColor: C.surface, borderColor: C.axis, borderWidth: 1, padding: [10, 12],
  textStyle: { color: C.ink, fontSize: 12, ...font }, extraCssText: `box-shadow:0 10px 28px ${C.tipShadow};border-radius:10px;`,
  confine: true, transitionDuration: reducedMotion() ? 0 : 0.2, ...extra,
});
const AX = () => ({
  axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
  axisLabel: { color: C.muted, fontSize: 11, hideOverlap: true, ...font }, splitLine: { lineStyle: { color: C.grid, type: [3, 3] } },
});
// read through a getter so every chart picks up the palette that is active when it renders
const axisCommon = new Proxy({}, { get: (_, k) => AX()[k], ownKeys: () => Reflect.ownKeys(AX()), getOwnPropertyDescriptor: (_, k) => ({ value: AX()[k], enumerable: true, configurable: true }) });
const timeAxis = (o = {}) => ({ type: "time", ...axisCommon, splitLine: { show: false }, ...o });
// unit goes on the tick labels (an axis title collides with the top legend)
const valAxis = (unit, o = {}) => ({
  type: "value", ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => `${v} ${unit}`.trim() }, ...o,
});
const legend = (o = {}) => ({ top: 0, left: 0, icon: "roundRect", itemWidth: 12, itemHeight: 4, itemGap: 16,
  textStyle: { color: C.ink2, fontSize: 12, ...font }, ...o });
// rows the legend above wraps into at this width (same greedy wrap as ECharts), so the plot can start below it
const textCtx = document.createElement("canvas").getContext("2d");
function legendRows(width, names) {
  textCtx.font = `12px ${font.fontFamily}`;
  let rows = 1, x = 0;
  for (const n of names) {
    const w = 12 + 5 + textCtx.measureText(n).width;
    if (x && x + w > width) { rows++; x = 0; }
    x += w + 16;
  }
  return rows;
}
const legendTop = (el, names, top) => top + (legendRows(el.clientWidth, names) - 1) * 30;
const row = (color, label, value) =>
  `<div style="display:flex;gap:8px;align-items:center;margin-top:4px"><span style="width:8px;height:8px;border-radius:2px;background:${color}"></span>` +
  `<span style="color:${C.ink2}">${label}</span><b style="margin-left:auto;padding-left:16px;color:${C.ink}">${value}</b></div>`;

// nearest index in a sorted ms array
function bisect(arr, t) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}
const zoomWindow = (win) => (win ? { startValue: win[0], endValue: win[1] } : { start: 0, end: 100 });

/** Hourly consumption vs expected baseline, with anomalous hours in red, detected events and injected ground truth.
 *  win = [fromMs, toMs] or null for the whole dataset. */
export function consumptionChart(el, res, { win = null, showInjected = true, onPick, compact = false } = {}) {
  const h = res.hourly, chart = mount(el);
  const pair = (arr) => h.t.map((t, i) => [t, arr[i]]);
  const flagged = [];
  for (let i = 0; i < h.t.length; i++) if (h.flag[i]) flagged.push([h.t[i], h.kwh[i]]);
  const points = res.events.filter((e) => e.type !== "sustained").map((e) => ({
    value: [ms(e.peak_time), e.peak_kwh], id: e.id, ev: e,
    itemStyle: { color: C.sev[e.severity], borderColor: C.surface, borderWidth: 2 },
  }));
  const sustained = res.events.filter((e) => e.type === "sustained").map((e) => [
    { xAxis: ms(e.start), itemStyle: { color: hexA(C.anomaly, 0.09) }, name: "" }, { xAxis: ms(e.end) }]);
  const injected = showInjected && res.validation ? res.validation.segments.map((s) => [
    { xAxis: ms(s.start) - 18e5, itemStyle: { color: hexA(C.violet, 0.16) } }, { xAxis: ms(s.end) + 18e5 }]) : [];
  const z = zoomWindow(win);
  const names = ["Consumption", "Expected baseline", "Anomalous hour", "Detected anomaly"].concat(injected.length ? ["Injected (ground truth)"] : []);
  chart.setOption({
    useUTC: true, textStyle: font, ...anim(),
    grid: { left: 58, right: compact ? 12 : 44, top: 44, bottom: 66 },
    legend: legend({ data: names, right: compact ? 0 : 96 }),
    toolbox: compact ? undefined : {
      right: 6, top: 0, itemSize: 14, itemGap: 10, iconStyle: { borderColor: C.muted }, emphasis: { iconStyle: { borderColor: C.s1 } },
      feature: { dataZoom: { yAxisIndex: "none", title: { zoom: "Box zoom", back: "Undo zoom" } }, restore: { title: "Reset" } },
    },
    tooltip: tooltip({
      trigger: "axis", axisPointer: { type: "line", lineStyle: { color: C.axis } },
      formatter: (ps) => {
        const t = ps[0].value[0], i = bisect(h.t, t);
        let s = `<b>${fmtTime(h.t[i])}</b>`;
        s += row(C.s1, "Consumption", `${h.kwh[i]?.toFixed(2) ?? "–"} kWh`);
        if (h.expected[i] != null) s += row(C.baseline, "Expected", `${h.expected[i].toFixed(2)} kWh`);
        if (h.expected[i] != null && h.kwh[i] != null) {
          const d = h.kwh[i] - h.expected[i];
          s += row(d > 0 ? C.anomaly : C.good, "Difference", `${d > 0 ? "+" : ""}${d.toFixed(2)} kWh`);
        }
        s += row(C.ink2, "Model rarity", `${(h.score[i] * 100).toFixed(1)}%`);
        if (h.flag[i]) s += `<div style="margin-top:6px;color:${C.anomaly};font-weight:600">Flagged as anomalous</div>`;
        if (h.injected?.[i]) s += row(C.violet, "Ground truth", "injected");
        const ev = ps.find((p) => p.seriesName === "Detected anomaly");
        if (ev) s += `<div style="margin-top:6px;color:${C.sev[ev.data.ev.severity]};font-weight:600">● ${ev.data.ev.title}</div><div style="color:${C.muted};font-size:11px">Click to see why it was flagged</div>`;
        return s;
      },
    }),
    xAxis: timeAxis(),
    yAxis: valAxis("kWh"),
    dataZoom: [{ type: "inside", ...z }, {
      type: "slider", ...z, height: 22, bottom: 8, borderColor: C.grid, fillerColor: C.zoomFill,
      handleStyle: { color: C.surface, borderColor: C.axis }, moveHandleStyle: { color: C.zoomHandle },
      dataBackground: { lineStyle: { color: C.axis }, areaStyle: { color: C.zoomBg } },
      textStyle: { color: C.muted, fontSize: 10 }, labelFormatter: (v) => fmtDay(v),
    }],
    series: [
      { name: "Consumption", type: "line", data: pair(h.kwh), showSymbol: false, sampling: "lttb", lineStyle: { width: 1.5, color: C.s1 },
        itemStyle: { color: C.s1 }, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: hexA(C.s1, 0.2) }, { offset: 1, color: hexA(C.s1, 0) }]) },
        markArea: { silent: true, data: [...sustained, ...injected] }, z: 2 },
      { name: "Expected baseline", type: "line", data: pair(h.expected), showSymbol: false, sampling: "lttb",
        lineStyle: { width: 1.5, color: C.baseline, type: [5, 4] }, itemStyle: { color: C.baseline }, z: 3 },
      { name: "Anomalous hour", type: "scatter", data: flagged, symbolSize: 5, itemStyle: { color: C.anomaly, opacity: 0.85 }, z: 4, silent: true, large: flagged.length > 2000 },
      { name: "Detected anomaly", type: "scatter", data: points, symbolSize: 11, itemStyle: { color: C.sev.critical }, z: 5,
        emphasis: { scale: 1.5 }, cursor: "pointer" },
      ...(injected.length ? [{ name: "Injected (ground truth)", type: "line", data: [], itemStyle: { color: hexA(C.violet, 0.5) } }] : []),
    ],
  });
  if (onPick) chart.on("click", (p) => p.seriesName === "Detected anomaly" && onPick(p.data.id));
  return chart;
}

/** Move an existing consumption chart to a new date window without rebuilding it. */
export function setWindow(el, win) {
  live.get(el)?.dispatchAction({ type: "dataZoom", ...(win ? { startValue: win[0], endValue: win[1] } : { start: 0, end: 100 }) });
}

export function dailyChart(el, res, { win = null } = {}) {
  const d = res.daily, chart = mount(el);
  const last = d.t[d.t.length - 1];
  const z = zoomWindow(win || [last - 120 * 864e5, last]);
  chart.setOption({
    useUTC: true, textStyle: font, ...anim(),
    grid: { left: 58, right: 16, top: 40, bottom: 28 },
    legend: legend({ data: ["Daily energy", "Sustained-anomaly day", "Expected (4-week median)"] }),
    tooltip: tooltip({ trigger: "axis", formatter: (ps) => {
      const i = bisect(d.t, ps[0].value[0]);
      return `<b>${fmtDay(d.t[i])}</b>` + row(d.flag[i] ? C.anomaly : C.s1, "Energy", `${d.kwh[i] ?? "–"} kWh`) +
        (d.expected[i] != null ? row(C.baseline, "Expected", `${d.expected[i]} kWh`) : "");
    } }),
    xAxis: timeAxis(), yAxis: valAxis("kWh"),
    dataZoom: [{ type: "inside", ...z }],
    series: [
      { name: "Daily energy", type: "bar", barMaxWidth: 14, data: d.t.map((t, i) => d.flag[i] ? null : [t, d.kwh[i]]),
        stack: "d", itemStyle: { color: C.s1, borderRadius: [4, 4, 0, 0] } },
      { name: "Sustained-anomaly day", type: "bar", barMaxWidth: 14, data: d.t.map((t, i) => d.flag[i] ? [t, d.kwh[i]] : null),
        stack: "d", itemStyle: { color: C.anomaly, borderRadius: [4, 4, 0, 0] } },
      { name: "Expected (4-week median)", type: "line", data: d.t.map((t, i) => [t, d.expected[i]]), showSymbol: false,
        lineStyle: { width: 2, color: C.ink2, type: [5, 4] }, itemStyle: { color: C.ink2 } },
    ],
  });
}

export function profileChart(el, res) {
  const chart = mount(el), hours = [...Array(24).keys()].map(hourLabel);
  chart.setOption({
    textStyle: font, ...anim(), grid: { left: 58, right: 16, top: 40, bottom: 28 },
    legend: legend({ data: ["Weekday", "Weekend"] }),
    tooltip: tooltip({ trigger: "axis", valueFormatter: (v) => `${v?.toFixed(2)} kWh` }),
    xAxis: { type: "category", data: hours, ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, interval: 3 } },
    yAxis: valAxis("kWh"),
    series: [
      { name: "Weekday", type: "line", data: res.profile.weekday, smooth: true, symbol: "circle", symbolSize: 8, showSymbol: false, lineStyle: { width: 2, color: C.s1 }, itemStyle: { color: C.s1 },
        areaStyle: { color: hexA(C.s1, 0.08) } },
      { name: "Weekend", type: "line", data: res.profile.weekend, smooth: true, symbol: "circle", symbolSize: 8, showSymbol: false, lineStyle: { width: 2, color: C.s2 }, itemStyle: { color: C.s2 } },
    ],
  });
}

/** Weekday x hour average. res = electricity result, or pass {heatmap, unit} for water ([[dow, hour, value]]). */
export function heatmapChart(el, res, { heatmap = null, unit = "kWh" } = {}) {
  const chart = mount(el), days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const data = (heatmap || res.profile.heatmap).map(([d, h, v]) => [h, d, v]);
  const max = Math.max(...data.map((x) => x[2]));
  chart.setOption({
    textStyle: font, ...anim(), grid: { left: 44, right: 12, top: 8, bottom: 56 },
    tooltip: tooltip({ formatter: (p) => `<b>${days[p.value[1]]} ${hourLabel(p.value[0])}</b>` + row(C.s1, "Average", `${p.value[2].toFixed(unit === "L" ? 1 : 2)} ${unit}`) }),
    xAxis: { type: "category", data: [...Array(24).keys()].map((h) => String(h).padStart(2, "0")), ...axisCommon, splitLine: { show: false }, axisLine: { show: false } },
    yAxis: { type: "category", data: days, inverse: true, ...axisCommon, splitLine: { show: false }, axisLine: { show: false } },
    visualMap: { min: 0, max, calculable: false, orient: "horizontal", left: "center", bottom: 0, itemWidth: 10, itemHeight: 160,
      inRange: { color: SEQ }, textStyle: { color: C.muted, fontSize: 11 }, formatter: (v) => `${v.toFixed(1)} ${unit}` },
    series: [{ type: "heatmap", data, itemStyle: { borderColor: C.surface, borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: C.ink } } }],
  });
}

/** Monthly bill with the avoidable (anomaly) part stacked on top. Water passes {months, usage: "kl", unit: "kL"}. */
export function monthlyChart(el, res, { months = null, usage = "kwh", unit = "kWh", usageLabel = "Energy" } = {}) {
  const chart = mount(el), m = (months || res.cost.months).slice(-24);
  chart.setOption({
    textStyle: font, ...anim(), grid: { left: 56, right: 16, top: 40, bottom: 28 },
    legend: legend({ data: ["Bill", "Avoidable (anomalies)"] }),
    tooltip: tooltip({ trigger: "axis", formatter: (ps) => {
      const x = m[ps[0].dataIndex];
      return `<b>${x.month}${x.complete ? "" : " (partial)"}</b>` + row(C.s1, "Bill", inr(x.bill)) + row(C.s2, "Avoidable", inr(x.avoidable_inr)) + row(C.baseline, usageLabel, `${x[usage]} ${unit}`);
    } }),
    xAxis: { type: "category", data: m.map((x) => new Date(x.month + "-01T00:00:00Z").toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" })), ...axisCommon, splitLine: { show: false } },
    yAxis: valAxis("", { axisLabel: { ...axisCommon.axisLabel, formatter: (v) => `₹${v >= 1000 ? v / 1000 + "k" : v}` } }),
    series: [
      { name: "Bill", type: "bar", stack: "b", barMaxWidth: 28, data: m.map((x) => x.bill - x.avoidable_inr), itemStyle: { color: C.s1, borderColor: C.surface, borderWidth: 1 } },
      { name: "Avoidable (anomalies)", type: "bar", stack: "b", barMaxWidth: 28, data: m.map((x) => x.avoidable_inr), itemStyle: { color: C.s2, borderRadius: [4, 4, 0, 0], borderColor: C.surface, borderWidth: 1 } },
    ],
  });
}

/** Alerts per month, stacked by severity (status colours, each labelled in the legend). */
export function alertsByMonthChart(el, resOrEvents) {
  const chart = mount(el), order = ["critical", "high", "medium", "low"];
  const months = new Map();
  (Array.isArray(resOrEvents) ? resOrEvents : resOrEvents.events).forEach((e) => {
    const k = e.start.slice(0, 7);
    if (!months.has(k)) months.set(k, { critical: 0, high: 0, medium: 0, low: 0 });
    months.get(k)[e.severity]++;
  });
  const keys = [...months.keys()].sort().slice(-24);
  const label = (k) => new Date(k + "-01T00:00:00Z").toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
  chart.setOption({
    textStyle: font, ...anim(), grid: { left: 40, right: 12, top: 40, bottom: 28 },
    legend: legend({ data: order.map((s) => s[0].toUpperCase() + s.slice(1)) }),
    tooltip: tooltip({ trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: C.shadow } } }),
    xAxis: { type: "category", data: keys.map(label), ...axisCommon, splitLine: { show: false } },
    yAxis: valAxis("", { minInterval: 1 }),
    series: order.map((s, i) => ({
      name: s[0].toUpperCase() + s.slice(1), type: "bar", stack: "a", barMaxWidth: 22, data: keys.map((k) => months.get(k)[s] || null),
      itemStyle: { color: C.sev[s], borderColor: C.surface, borderWidth: 1, borderRadius: i === order.length - 1 ? [4, 4, 0, 0] : 0 },
    })),
  });
}

/** When anomalies peak: count of spike/repeated peaks by clock hour. */
export function alertsByHourChart(el, res) {
  const chart = mount(el), counts = Array(24).fill(0);
  res.events.forEach((e) => { counts[new Date(ms(e.peak_time)).getUTCHours()]++; });
  chart.setOption({
    textStyle: font, ...anim(), grid: { left: 40, right: 12, top: 16, bottom: 28 },
    tooltip: tooltip({ trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: C.shadow } },
      formatter: (ps) => `<b>${ps[0].name}</b>` + row(C.s1, "Anomalies peaking", ps[0].value) }),
    xAxis: { type: "category", data: [...Array(24).keys()].map(hourLabel), ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, interval: 3 } },
    yAxis: valAxis("", { minInterval: 1 }),
    series: [{ type: "bar", data: counts, barMaxWidth: 16, itemStyle: { color: C.s1, borderRadius: [4, 4, 0, 0] },
      emphasis: { itemStyle: { color: C.seq[5] } } }],
  });
}

/** Daily totals for one utility with the daily limit as a dashed step line; days over the limit in red.
 *  d = {t: ["YYYY-MM-DD"], v: [number], limit: [number|null]} */
export function utilityDailyChart(el, d, { utility = "electricity", unit = "kWh", div = 1 } = {}) {
  const chart = mount(el), color = utility === "water" ? C.water : C.s1;
  const t = d.t.map((x) => ms(x)), val = d.v.map((v) => (v == null ? null : v / div)), lim = d.limit.map((v) => (v == null ? null : v / div));
  const over = val.map((v, i) => lim[i] != null && v > lim[i]);
  const exp = d.expected?.some((x) => x != null) ? d.expected.map((v) => (v == null ? null : v / div)) : null;
  const dec = unit === "L" ? 0 : unit === "kL" ? 2 : 1;
  const names = ["Within limit", "Over limit", ...(exp ? ["Expected"] : []), ...(lim.some((x) => x != null) ? ["Daily limit"] : [])];
  refit.set(el, () => chart.setOption({ grid: { top: legendTop(el, names, 40) } }));
  chart.setOption({
    useUTC: true, textStyle: font, ...anim(), grid: { left: 58, right: 12, top: legendTop(el, names, 40), bottom: 28 },
    legend: legend({ data: names }),
    tooltip: tooltip({ trigger: "axis", formatter: (ps) => {
      const i = bisect(t, ps[0].value[0]);
      return `<b>${fmtDay(t[i])}</b>` + row(over[i] ? C.anomaly : color, "Used", `${val[i]?.toFixed(dec) ?? "–"} ${unit}`) +
        (exp && exp[i] != null ? row(C.baseline, "Expected", `${exp[i].toFixed(dec)} ${unit}`) : "") +
        (lim[i] != null ? row(C.ink2, "Limit", `${lim[i].toFixed(dec)} ${unit}`) + (over[i] ? row(C.anomaly, "Over by", `${(val[i] - lim[i]).toFixed(dec)} ${unit}`) : "") : "");
    } }),
    xAxis: timeAxis({ minInterval: 864e5 }), yAxis: valAxis(unit),
    series: [
      { name: "Within limit", type: "bar", stack: "u", barMaxWidth: 16, data: t.map((x, i) => (over[i] ? null : [x, val[i]])), itemStyle: { color, borderRadius: [4, 4, 0, 0] } },
      { name: "Over limit", type: "bar", stack: "u", barMaxWidth: 16, data: t.map((x, i) => (over[i] ? [x, val[i]] : null)), itemStyle: { color: C.anomaly, borderRadius: [4, 4, 0, 0] } },
      ...(exp ? [{ name: "Expected", type: "line", data: t.map((x, i) => [x, exp[i]]), showSymbol: false, connectNulls: false,
        lineStyle: { width: 2, color: C.violet }, itemStyle: { color: C.violet } }] : []),
      ...(lim.some((x) => x != null) ? [{ name: "Daily limit", type: "line", step: "middle", data: t.map((x, i) => [x, lim[i]]), showSymbol: false,
        lineStyle: { width: 2, color: C.ink2, type: [5, 4] }, itemStyle: { color: C.ink2 } }] : []),
    ],
  });
}

/** Average litres per clock hour (last 30 days of hourly water data). */
export function waterProfileChart(el, profile) {
  const chart = mount(el);
  chart.setOption({
    textStyle: font, ...anim(), grid: { left: 52, right: 12, top: 16, bottom: 28 },
    tooltip: tooltip({ trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: C.shadow } },
      formatter: (ps) => `<b>${ps[0].name}</b>` + row(C.water, "Average", `${(ps[0].value ?? 0).toFixed(1)} L`) }),
    xAxis: { type: "category", data: [...Array(24).keys()].map(hourLabel), ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, interval: 3 } },
    yAxis: valAxis("L"),
    series: [{ type: "bar", data: profile, barMaxWidth: 16, itemStyle: { color: C.water, borderRadius: [4, 4, 0, 0] } }],
  });
}

/** Monthly totals bar chart. rows = [{month: "YYYY-MM", value}] */
export function monthlyTotalsChart(el, rows, { unit = "L", color = C.water, dec = 0 } = {}) {
  const chart = mount(el);
  const label = (k) => new Date(k + "-01T00:00:00Z").toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
  chart.setOption({
    textStyle: font, ...anim(), grid: { left: 56, right: 12, top: 16, bottom: 28 },
    tooltip: tooltip({ trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: C.shadow } },
      formatter: (ps) => `<b>${ps[0].name}</b>` + row(color, "Total", `${(+ps[0].value).toLocaleString("en-IN", { maximumFractionDigits: dec })} ${unit}`) }),
    xAxis: { type: "category", data: rows.map((r) => label(r.month)), ...axisCommon, splitLine: { show: false } },
    yAxis: valAxis(unit),
    series: [{ type: "bar", data: rows.map((r) => r.value), barMaxWidth: 26, itemStyle: { color, borderRadius: [4, 4, 0, 0] } }],
  });
}

const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Average per weekday (Mon..Sun). */
export function weekdayChart(el, values, { unit = "L", color = C.water, dec = 0 } = {}) {
  const chart = mount(el);
  chart.setOption({
    textStyle: font, ...anim(), grid: { left: 56, right: 12, top: 16, bottom: 28 },
    tooltip: tooltip({ trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: C.shadow } },
      formatter: (ps) => `<b>${ps[0].name}</b>` + row(color, "Average day", `${(+ps[0].value || 0).toLocaleString("en-IN", { maximumFractionDigits: dec })} ${unit}`) }),
    xAxis: { type: "category", data: WD, ...axisCommon, splitLine: { show: false } },
    yAxis: valAxis(unit),
    series: [{ type: "bar", barMaxWidth: 28, data: values.map((v, i) => ({ value: v, itemStyle: { color: i >= 5 ? C.s2 : color, borderRadius: [4, 4, 0, 0] } })) }],
  });
}

/** Number of anomaly events by weekday of their start. */
export function eventsByWeekdayChart(el, events) {
  const chart = mount(el), counts = Array(7).fill(0);
  events.forEach((e) => { counts[(new Date(ms(String(e.start).slice(0, 10))).getUTCDay() + 6) % 7]++; });
  chart.setOption({
    textStyle: font, ...anim(), grid: { left: 40, right: 12, top: 16, bottom: 28 },
    tooltip: tooltip({ trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: C.shadow } },
      formatter: (ps) => `<b>${ps[0].name}</b>` + row(C.water, "Events starting", ps[0].value) }),
    xAxis: { type: "category", data: WD, ...axisCommon, splitLine: { show: false } },
    yAxis: valAxis("", { minInterval: 1 }),
    series: [{ type: "bar", data: counts, barMaxWidth: 24, itemStyle: { color: C.water, borderRadius: [4, 4, 0, 0] } }],
  });
}

/** Daily water use with detected events marked (dots for one-day events, bands for multi-day ones). */
export function waterEventsChart(el, d, events, { unit = "L", div = 1, onPick } = {}) {
  const chart = mount(el), t = d.t.map((x) => ms(x)), v = d.litres.map((x) => (x == null ? null : x / div));
  const dec = unit === "kL" ? 2 : 0;
  const inRange = (x) => x >= t[0] && x <= t[t.length - 1] + 864e5;
  const pts = events.filter((e) => e.start === e.end && inRange(ms(e.start))).map((e) => {
    const i = t.indexOf(ms(e.start));
    return { value: [ms(e.start), i >= 0 ? v[i] : e.actual_litres / div], ev: e, itemStyle: { color: C.sev[e.severity], borderColor: C.surface, borderWidth: 2 } };
  });
  const bands = events.filter((e) => e.start !== e.end && inRange(ms(e.end))).map((e) => [
    { xAxis: ms(e.start) - 432e5, itemStyle: { color: hexA(C.sev[e.severity], 0.13) } }, { xAxis: ms(e.end) + 432e5 }]);
  chart.setOption({
    useUTC: true, textStyle: font, ...anim(), grid: { left: 58, right: 12, top: 40, bottom: 28 },
    legend: legend({ data: ["Daily use", "Unusual day", ...(bands.length ? ["Multi-day event"] : [])] }),
    tooltip: tooltip({ trigger: "axis", formatter: (ps) => {
      const i = bisect(t, ps[0].value[0]);
      const ev = events.filter((e) => ms(e.start) <= t[i] && t[i] <= ms(e.end));
      return `<b>${fmtDay(t[i])}</b>` + row(C.water, "Used", `${v[i]?.toFixed(dec) ?? "–"} ${unit}`) +
        ev.map((e) => `<div style="margin-top:6px;color:${C.sev[e.severity]};font-weight:600">● ${e.title}</div>`).join("");
    } }),
    xAxis: timeAxis(), yAxis: valAxis(unit),
    series: [
      { name: "Daily use", type: "bar", barMaxWidth: 12, data: t.map((x, i) => [x, v[i]]), itemStyle: { color: hexA(C.water, 0.75), borderRadius: [3, 3, 0, 0] },
        markArea: { silent: true, data: bands } },
      { name: "Unusual day", type: "scatter", symbolSize: 12, data: pts, itemStyle: { color: C.sev.critical }, z: 5, cursor: onPick ? "pointer" : "default" },
      ...(bands.length ? [{ name: "Multi-day event", type: "line", data: [], itemStyle: { color: hexA(C.sev.high, 0.5) } }] : []),
    ],
  });
  if (onPick) chart.on("click", (p) => p.seriesName === "Unusual day" && onPick(p.data.ev));
}

/** Zoomed view of a single event: actual vs expected around it. */
export function eventChart(el, res, ev) {
  const h = res.hourly, chart = mount(el);
  const pad = ev.type === "sustained" ? 7 * 864e5 : 2 * 864e5;
  const a = ms(ev.start) - pad, b = ms(ev.end) + pad;
  const idx = [];
  for (let i = bisect(h.t, a); i < h.t.length && h.t[i] <= b; i++) idx.push(i);
  const areas = ev.type === "repeated" ? ev.occurrences.map((t) => [{ xAxis: ms(t) - 54e5 }, { xAxis: ms(t) + 54e5 }])
    : [[{ xAxis: ms(ev.start) - 18e5 }, { xAxis: ms(ev.end) + 18e5 }]];
  chart.setOption({
    useUTC: true, textStyle: font, ...anim(), grid: { left: 52, right: 12, top: 36, bottom: 24 },
    legend: legend({ data: ["Actual", "Expected"] }),
    tooltip: tooltip({ trigger: "axis", formatter: (ps) => `<b>${fmtTime(ps[0].value[0])}</b>` +
      ps.map((p) => row(p.color, p.seriesName, `${p.value[1]?.toFixed(2) ?? "–"} kWh`)).join("") }),
    xAxis: timeAxis(), yAxis: valAxis("kWh"),
    series: [
      { name: "Actual", type: "line", data: idx.map((i) => [h.t[i], h.kwh[i]]), showSymbol: false, lineStyle: { width: 2, color: C.s1 }, itemStyle: { color: C.s1 },
        markArea: { silent: true, itemStyle: { color: hexA(C.sev[ev.severity], 0.14) }, data: areas } },
      { name: "Expected", type: "line", data: idx.map((i) => [h.t[i], h.expected[i]]), showSymbol: false, lineStyle: { width: 1.5, color: C.baseline, type: [5, 4] }, itemStyle: { color: C.baseline } },
    ],
  });
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Daily kWh from every source - imported data (blue) or manual readings (orange); a day is never both. */
export function sourceDailyChart(el, d) {
  const chart = mount(el);
  const t = d.t.map((x) => ms(x));
  const pick = (src) => t.map((x, i) => (d.source[i] === src ? [x, d.kwh[i]] : null));
  const names = [...(d.source.includes("imported") ? ["Imported data"] : []), ...(d.source.includes("manual") ? ["Manual readings"] : [])];
  chart.setOption({
    useUTC: true, textStyle: font, ...anim(), grid: { left: 58, right: 12, top: 40, bottom: 28 },
    legend: legend({ data: names }),
    tooltip: tooltip({ trigger: "axis", formatter: (ps) => {
      const i = bisect(t, ps[0].value[0]), m = d.source[i] === "manual";
      return `<b>${fmtDay(t[i])}</b>` + row(m ? C.s2 : C.s1, m ? "Manual reading" : "Imported data", `${d.kwh[i].toFixed(1)} kWh`);
    } }),
    xAxis: timeAxis(), yAxis: valAxis("kWh"),
    series: [
      { name: "Imported data", type: "bar", stack: "u", barMaxWidth: 16, data: pick("imported"), itemStyle: { color: C.s1, borderRadius: [4, 4, 0, 0] } },
      { name: "Manual readings", type: "bar", stack: "u", barMaxWidth: 16, data: pick("manual"), itemStyle: { color: C.s2, borderRadius: [4, 4, 0, 0] } },
    ],
  });
}

/** Weekly totals (weeks start on Monday) for a report's period. */
export function weeklyTotalsChart(el, rows, { unit = "kWh" } = {}) {
  const chart = mount(el), dec = unit === "L" ? 0 : 1;
  chart.setOption({
    textStyle: font, ...anim(), grid: { left: 58, right: 12, top: 16, bottom: 28 },
    tooltip: tooltip({ trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: C.shadow } },
      formatter: (ps) => `<b>Week of ${ps[0].name}</b>` + row(C.s1, "Total", `${(+ps[0].value).toLocaleString("en-IN", { maximumFractionDigits: dec })} ${unit}`) }),
    xAxis: { type: "category", data: rows.map((r) => fmtDay(r.week).slice(0, 6)), ...axisCommon, splitLine: { show: false } },
    yAxis: valAxis(unit),
    series: [{ type: "bar", data: rows.map((r) => r.value), barMaxWidth: 26, itemStyle: { color: unit === "L" ? C.water : C.s1, borderRadius: [4, 4, 0, 0] } }],
  });
}
