// PowerPulse end-to-end + responsive test runner.
//
//   node e2e/run.mjs                 full user journey + responsive/theme matrix
//   node e2e/run.mjs --journey       only the user journey
//   node e2e/run.mjs --responsive    only the responsive/theme matrix
//
// It drives a real headless Chrome over the DevTools protocol against a PowerPulse server that it starts itself
// on a spare port with a throwaway database (POWERPULSE_DB in a temp folder), the background worker off and
// no outside services - so it never touches data/powerpulse.db and never contacts anyone.
// No npm packages needed: Node 22+ (global fetch/WebSocket) and Google Chrome / Chromium / Edge.
// Env: CHROME_PATH, CHROME_ARGS (extra browser flags, e.g. --no-sandbox on CI), PYTHON (default .venv python), E2E_PORT (default 8765), E2E_KEEP=1 keeps the temp folder.
// Screenshots and a JSON summary go to e2e/output/ (git-ignored). Exit code 1 if any check fails.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "e2e", "output");
const PORT = +(process.env.E2E_PORT || 8765);
const BASE = `http://127.0.0.1:${PORT}`;
const ONLY = process.argv.includes("--journey") ? "journey" : process.argv.includes("--responsive") ? "responsive" : "all";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// ---------------- results ----------------
const results = [];
let section = "";
function check(name, ok, detail = "") {
  results.push({ section, name, ok: !!ok, detail: String(detail ?? "") });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail !== "" ? "  -  " + String(detail).slice(0, 300) : ""}`);
  return !!ok;
}
const begin = (s) => { section = s; console.log(`\n== ${s}`); };

// ---------------- binaries ----------------
function findChrome() {
  const c = [process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const p = c.find((x) => x && existsSync(x));
  if (!p) throw new Error("Chrome/Chromium not found - set CHROME_PATH.");
  return p;
}
function findPython() {
  const c = [process.env.PYTHON, join(ROOT, ".venv", "Scripts", "python.exe"), join(ROOT, ".venv", "bin", "python")];
  return c.find((x) => x && existsSync(x)) || "python";
}

// ---------------- test data (written to the temp folder, uploaded through the UI) ----------------
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d; };

function electricityCsv() {
  // 70 days of hourly household load ending yesterday, with one evening spike and a 5-day sustained rise.
  const rows = ["timestamp,kwh"];
  for (let day = 70; day >= 1; day--) {
    const d = daysAgo(day);
    for (let h = 0; h < 24; h++) {
      const shape = h < 6 ? 0.25 : h < 9 ? 0.9 : h < 17 ? 0.5 : h < 23 ? 1.2 : 0.4;
      let v = shape * (0.85 + rnd() * 0.3);
      if (day === 12 && h === 20) v += 7.5;          // spike
      if (day <= 8 && day >= 4) v *= 1.7;            // sustained
      rows.push(`${iso(d)} ${String(h).padStart(2, "0")}:00,${v.toFixed(3)}`);
    }
  }
  return rows.join("\n") + "\n";
}
function waterCsv() {
  // 45 days of normal daily use ending 3 days ago
  const rows = ["date,litres"];
  for (let day = 47; day >= 3; day--) rows.push(`${iso(daysAgo(day))},${Math.round(380 + rnd() * 80)}`);
  return rows.join("\n") + "\n";
}

// ---------------- server ----------------
async function startServer(tmp) {
  const env = {
    ...process.env, POWERPULSE_PORT: String(PORT), POWERPULSE_HOST: "127.0.0.1", POWERPULSE_DB: join(tmp, "e2e.db"),
    POWERPULSE_APP_URL: BASE, POWERPULSE_SCHEDULER: "0", PYTHONUNBUFFERED: "1",
  };
  try { await fetch(`${BASE}/api/health`); throw new Error(`port ${PORT} is already in use - set E2E_PORT`); } catch (e) { if (e.message.includes("in use")) throw e; }
  const proc = spawn(findPython(), [join(ROOT, "run.py")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d)); proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return { proc, log: () => log }; } catch { /* starting */ }
    if (proc.exitCode !== null) break;
    await sleep(200);
  }
  proc.kill();
  throw new Error("server did not start:\n" + log);
}

// ---------------- browser ----------------
async function startBrowser(profile) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const chrome = spawn(findChrome(), ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "--force-device-scale-factor=1",
    ...(process.env.CHROME_ARGS || "").split(" ").filter(Boolean), "about:blank"], { stdio: "ignore" });
  let page;
  for (let i = 0; i < 75 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch { /* starting */ }
    if (!page) await sleep(200);
  }
  if (!page) { chrome.kill(); throw new Error("Chrome did not start"); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  let id = 0;
  const pending = new Map(), problems = [], fileChoosers = [], downloads = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Page.fileChooserOpened") fileChoosers.push(m.params);
    if (m.method === "Page.downloadWillBegin") downloads.push({ ...m.params, state: "started" });
    if (m.method === "Page.downloadProgress" && m.params.state !== "inProgress") {
      const d = downloads.find((x) => x.guid === m.params.guid);
      if (d) d.state = m.params.state;
    }
    if (m.method === "Runtime.exceptionThrown") problems.push("exception: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push("console.error: " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") problems.push("log: " + m.params.entry.text + " " + (m.params.entry.url || ""));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable"); await send("DOM.enable");
  // name the element/file behind any CSP violation (Chrome's own log line doesn't)
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation',
    e.violatedDirective, e.blockedURI, (e.sourceFile || '') + ':' + e.lineNumber, (e.target && e.target.outerHTML || '').slice(0, 160), e.sample || ''), true);` });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) throw new Error("eval failed: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return r.result?.result?.value;
  };
  const b = {
    send, evaluate, problems, fileChoosers, downloads,
    async goto(url) { await send("Page.navigate", { url }); await b.waitFor("document.readyState === 'complete'", 30); await sleep(300); },
    async waitFor(expr, timeoutS = 60) {
      for (let i = 0; i < timeoutS * 5; i++) { try { if (await evaluate(expr)) return true; } catch { /* navigating */ } await sleep(200); }
      return false;
    },
    async viewport(w, h) { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 }); },
    async colorScheme(v) { await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] }); },
    async setFile(selector, path) {
      const { result: { root } } = await send("DOM.getDocument", { depth: -1, pierce: false });
      const { result: { nodeId } } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error("file input not found: " + selector);
      await evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (i) i.value = ''; return 1; })()`);
      await send("DOM.setFileInputFiles", { nodeId, files: [path] });
    },
    async shot(name, full = false) {
      let clip;
      if (full) { const [w, h] = await evaluate("[innerWidth, document.documentElement.scrollHeight]"); clip = { x: 0, y: 0, width: w, height: Math.min(h, 8000), scale: 1 }; }
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full, ...(clip ? { clip } : {}) });
      writeFileSync(join(OUT, name), Buffer.from(r.result.data, "base64"));
    },
    close() { try { ws.close(); } catch { /* closed */ } chrome.kill(); },
  };
  return b;
}

// ---------------- page helpers (run inside the page) ----------------
const ACTIVE_READY = `(() => { const v = document.querySelector('.view.active'); return !!v && !v.querySelector('.skel') && v.innerText.trim().length > 30
  && !document.querySelector('#loading:not([hidden])'); })()`;
async function route(b, r) {
  await b.evaluate(`location.hash = ${JSON.stringify(r)}; 1`);
  const ok = await b.waitFor(`location.hash === '#${r}' && document.querySelector('.view.active')?.id === 'v-${r.replace("/", "-")}' && ${ACTIVE_READY}`, 90);
  await sleep(500); // charts settle
  return ok;
}
const pageState = (b) => b.evaluate(`({
  title: document.querySelector('#view-title')?.textContent.trim(),
  error: /Couldn't load|Something went wrong/.test(document.querySelector('.view.active')?.innerText || ''),
  overflow: document.documentElement.scrollWidth - innerWidth,
  phantom: document.documentElement.scrollHeight - Math.max(Math.round(document.body.getBoundingClientRect().height), innerHeight),
  charts: document.querySelectorAll('.view.active canvas').length,
  theme: document.documentElement.dataset.theme })`);
const submit = (b, formSel, values) => b.evaluate(`(() => { const f = document.querySelector('.view.active ' + ${JSON.stringify(formSel)}) || document.querySelector(${JSON.stringify(formSel)}); if (!f) return 'missing form';
  for (const [k, v] of Object.entries(${JSON.stringify(values)})) { const el = f.querySelector('[name="' + k + '"], #' + k); if (!el) return 'missing field ' + k; el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true })); }
  f.requestSubmit(); return 'ok'; })()`);
// serialised in the page: objects resolved from an awaited promise don't always survive returnByValue intact
async function settingsTab(b, tab) {
  await b.evaluate(`document.querySelector('.view.active [data-stab=${tab}]').click(); 1`);
  return b.waitFor(`document.querySelector('.view.active [data-stab=${tab}]')?.getAttribute('aria-selected') === 'true'
    && document.querySelector('.view.active .set-body')?.innerText.trim().length > 20`, 30);
}
const apiGet = async (b, path) => JSON.parse(await b.evaluate(`(async () => { const r = await fetch(${JSON.stringify(path)}); const t = await r.text();
  let body = null; try { body = JSON.parse(t); } catch { /* not JSON */ } return JSON.stringify({ status: r.status, body, raw: t.slice(0, 200) }); })()`));

const ROUTES = ["overview", "electricity/analytics", "electricity/anomalies", "electricity/alerts", "electricity/limit", "electricity/savings",
  "electricity/reports", "water/analytics", "water/anomalies", "water/alerts", "water/limit", "water/savings", "water/reports",
  "reports", "notifications", "settings"];

// ---------------- the user journey ----------------
async function journey(b, tmp, user) {
  begin("Journey: landing, register, logout, login");
  await b.viewport(1440, 900); await b.colorScheme("light");
  await b.goto(BASE + "/");
  const landing = await b.evaluate(`({ title: document.title, signIn: [...document.querySelectorAll('a')].filter((a) => /sign in/i.test(a.textContent) && a.offsetParent).length })`);
  check("landing page renders", /PowerPulse/.test(landing.title), landing.title);
  check("exactly one visible 'Sign in' link on desktop", landing.signIn === 1, landing.signIn);
  const entry = await b.evaluate(`[...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /dashboard|register|login/.test(h))`);
  check("logged out: every way in goes to sign-in or registration, never straight to the dashboard",
    entry.length >= 4 && entry.every((h) => h.startsWith("/login") || h.startsWith("/register")), entry.join(" "));
  check("Sign in leads to the login page", await b.evaluate("document.querySelector('.nav-signin').getAttribute('href')") === "/login");
  await b.evaluate("document.querySelector('[data-cta]').click(); 1");
  check("Get Started opens registration", await b.waitFor("location.pathname === '/register' && !!document.querySelector('#f')", 15), await b.evaluate("location.pathname"));
  await b.goto(BASE + "/");

  await b.goto(BASE + "/register");
  check("register form submitted", (await submit(b, "#f", { name: user.name, email: user.email, password: user.password, confirm: user.password })) === "ok");
  check("registration lands on the Overview dashboard", await b.waitFor(`location.pathname === '/dashboard' && ${ACTIVE_READY}`, 60)
    && (await b.evaluate("document.querySelector('.view.active').id")) === "v-overview", await b.evaluate("location.pathname + location.hash"));
  await b.goto(BASE + "/");
  check("signed in: the landing page offers Continue to dashboard instead of Sign in",
    await b.waitFor("/Continue to dashboard/.test(document.querySelector('.nav-cta')?.textContent || '') && !document.querySelector('.nav-signin')", 10));
  await b.goto(BASE + "/login");
  check("signed in: /login goes straight to the dashboard (no second sign-in)", await b.waitFor("location.pathname === '/dashboard'", 15), await b.evaluate("location.pathname"));
  await b.waitFor(ACTIVE_READY, 60);

  await b.evaluate("document.querySelector('#logout').click(); 1");
  check("sign out returns to the public landing page", await b.waitFor("location.pathname === '/' && !!document.querySelector('.hero')", 20), await b.evaluate("location.pathname"));
  await b.send("Page.navigateToHistoryEntry", { entryId: (await b.send("Page.getNavigationHistory")).result.entries.slice(-2)[0].id });
  await sleep(1500);
  check("Back after sign out doesn't show the dashboard", await b.waitFor("location.pathname !== '/dashboard' || !document.querySelector('.view.active')", 15),
    await b.evaluate("location.pathname"));
  const meOut = await apiGet(b, "/api/auth/me");
  check("session is gone after sign out", meOut.status === 401, JSON.stringify(meOut).slice(0, 200));
  await b.goto(BASE + "/dashboard");
  check("/dashboard redirects to sign-in when signed out", await b.waitFor("location.pathname === '/login'", 10), await b.evaluate("location.pathname"));

  await b.goto(BASE + "/login");
  await submit(b, "#f", { email: user.email, password: "WrongPass99" });
  check("wrong password shows an error and stays on /login", await b.waitFor("document.querySelector('#msg')?.textContent.trim().length > 0", 15)
    && (await b.evaluate("location.pathname")) === "/login", await b.evaluate("document.querySelector('#msg')?.textContent.trim()"));
  await submit(b, "#f", { email: user.email, password: user.password });
  check("sign in lands on the Overview dashboard", await b.waitFor(`location.pathname === '/dashboard' && ${ACTIVE_READY}`, 60)
    && (await b.evaluate("document.querySelector('.view.active').id")) === "v-overview");

  begin("Journey: navigate every section");
  for (const r of ROUTES) {
    const ok = await route(b, r), s = await pageState(b);
    check(`#${r} renders`, ok && !s.error && s.overflow <= 1, `title="${s.title}" overflow=${s.overflow}${s.error ? " ERROR TEXT" : ""}`);
  }

  begin("Journey: upload an electricity dataset");
  const ePath = join(tmp, "e2e-electricity.csv"); writeFileSync(ePath, electricityCsv());
  await route(b, "settings");
  await settingsTab(b, "data");
  check("data tab opens", await b.waitFor("!!document.querySelector('#file')", 30));
  await b.setFile("#file", ePath);
  const validated = await b.waitFor("!!document.querySelector('#go-analyse')", 60);
  check("upload is validated before analysis", validated, validated ? "" : await b.evaluate("document.querySelector('.modal')?.innerText.slice(0, 300) || 'no modal'"));
  if (validated) await b.evaluate("document.querySelector('#go-analyse').click(); 1");
  const ds = await b.waitFor("fetch('/api/datasets').then((r) => r.json()).then((d) => (d.items || d).some?.((x) => x.name === 'e2e-electricity.csv' && x.active))", 120);
  check("uploaded file becomes the active electricity dataset", ds);

  begin("Journey: electricity analytics");
  await route(b, "electricity/analytics");
  let s = await pageState(b);
  check("analytics shows the uploaded file as its data source", await b.evaluate("document.querySelector('.view.active').innerText.includes('e2e-electricity.csv')"));
  check("analytics charts are drawn", s.charts >= 2, `${s.charts} canvases`);
  const active = await apiGet(b, "/api/datasets/active");
  check("detection found anomalies in the uploaded data", active.body?.events?.length > 0, `status ${active.status} ${active.raw.slice(0, 80)} / ${active.body?.events?.length} events: ${(active.body?.events || []).map((e) => e.type).join(",")}`);
  begin("Journey: custom date range");
  await b.evaluate("document.querySelector('#date-dd [data-dd-toggle]').click(); 1"); await sleep(300);
  const dr = await b.evaluate(`(() => { const f = document.querySelector('#date-form'); const max = f.elements.to.max, min = f.elements.from.min;
    f.elements.from.value = max; f.elements.to.value = min; f.requestSubmit(); return JSON.stringify({ msg: f.elements.to.validationMessage, max, min }); })()`);
  const drj = JSON.parse(dr);
  check("an end date before the start date is refused with a message", /on or after/.test(drj.msg), drj.msg);
  await b.evaluate(`(() => { const f = document.querySelector('#date-form'); f.elements.from.value = '${iso(daysAgo(30))}'; f.elements.from.dispatchEvent(new Event('input'));
    f.elements.to.value = '${iso(daysAgo(10))}'; f.elements.to.dispatchEvent(new Event('input')); f.requestSubmit(); return 1; })()`);
  check("after fixing the dates the range applies", await b.waitFor("/–/.test(document.querySelector('#date-label').textContent)", 10), await b.evaluate("document.querySelector('#date-label').textContent"));
  await b.evaluate("document.querySelector('#date-dd [data-dd-toggle]').click(); 1"); await sleep(200);
  await b.evaluate("document.querySelector('#date-pop [data-range=\"30\"]')?.click(); 1");

  begin("Journey: unread anomaly badge");
  const nEvents = active.body?.events?.length || 0;
  const badge = () => b.evaluate("document.querySelector('#nav-count')?.textContent.trim() || ''");
  const counts = async () => (await apiGet(b, "/api/anomalies/counts")).body;
  await b.waitFor(`document.querySelector('#nav-count')?.textContent.trim() === '${nEvents > 99 ? "99+" : nEvents}'`, 15);
  check("badge shows the number of unread electricity anomalies", (await badge()) === String(nEvents), `badge "${await badge()}", events ${nEvents}`);
  for (let i = 0; i < 3; i++) await apiGet(b, "/api/anomalies/electricity");
  check("loading anomaly data in the background marks nothing read", (await counts()).electricity.unread === nEvents);
  await route(b, "electricity/anomalies");
  check("anomaly page shows total / unread / read and the new columns", await b.evaluate(
    "['Anomalies detected', 'Unread', 'Read', 'Actual', 'Expected', 'Deviation'].every((w) => document.querySelector('.view.active').innerText.includes(w))"));
  check("anomaly list renders the detected events", await b.evaluate("document.querySelectorAll('.view.active tr[data-key]').length") === nEvents);
  check("viewed anomalies are marked read and the badge disappears",
    await b.waitFor("document.querySelector('#nav-count').textContent.trim() === ''", 15) && (await counts()).electricity.unread === 0, `badge "${await badge()}"`);
  await b.shot("journey-electricity-anomalies.png");
  await b.evaluate("location.reload(); 1"); await sleep(300);
  await b.waitFor(ACTIVE_READY, 60); await sleep(1500);
  check("read status survives a page refresh", (await badge()) === "" && (await counts()).electricity.read === nEvents);
  await b.evaluate("document.querySelector('.view.active tr[data-key] [data-toggle-read]').click(); 1");
  check("an anomaly can be marked unread again (badge returns)", await b.waitFor("document.querySelector('#nav-count').textContent.trim() === '1'", 10));
  await b.evaluate("document.querySelector('.view.active #read-all').click(); 1");
  check("Mark all as read clears the badge", await b.waitFor("document.querySelector('#nav-count').textContent.trim() === ''", 10)
    && (await counts()).electricity.unread === 0);
  check("water badge is independent (no water data yet)", (await b.evaluate("document.querySelector('#nav-count-water').textContent.trim()")) === "");

  begin("Journey: manual electricity entry");
  const todayIso = iso(daysAgo(0)), yIso = iso(daysAgo(1));
  await route(b, "electricity/analytics");
  check("Add Electricity Usage is offered on Consumption Analytics", await b.evaluate("!!document.querySelector('.view.active [data-add-usage]')"));
  const openForm = async () => { await b.evaluate("document.querySelector('.view.active [data-add-usage]').click(); 1"); return b.waitFor("!!document.querySelector('#usage-form')", 10); };
  check("the form opens with date, time, kWh, source and notes", await openForm() && await b.evaluate(
    "['date', 'time', 'kwh', 'source', 'notes'].every((n) => document.querySelector('#usage-form').elements[n])"));
  await submit(b, "#usage-form", { date: todayIso, kwh: "-5" });
  check("a negative value is rejected in the form, with a message", await b.waitFor("/negative/i.test(document.querySelector('#err-kwh')?.textContent || '')", 5)
    && (await apiGet(b, "/api/electricity/readings")).body.total === 0);
  await submit(b, "#usage-form", { date: todayIso, kwh: "9" });
  check("a valid reading saves and confirms", await b.waitFor("!document.querySelector('#usage-form') && [...document.querySelectorAll('.toast')].some((x) => /Saved 9(\\.0+)? kWh/.test(x.innerText))", 15),
    await b.evaluate("[...document.querySelectorAll('.toast')].map((x) => x.innerText).join(' | ') || document.querySelector('#usage-err')?.innerText || ''"));
  const r1 = (await apiGet(b, "/api/electricity/readings")).body;
  check("the reading is stored for this user and counted", r1.total === 1 && r1.items[0].counted && r1.items[0].day === todayIso);
  await openForm();
  await submit(b, "#usage-form", { date: todayIso, kwh: "3" });
  check("a duplicate for the same day is refused with an explanation", await b.waitFor("/already entered/.test(document.querySelector('#usage-err:not([hidden])')?.innerText || '')", 10));
  await b.evaluate("document.querySelector('.modal [data-modal-close]').click(); 1");
  await openForm();
  await submit(b, "#usage-form", { date: yIso, kwh: "11" });
  await b.waitFor("!document.querySelector('#usage-form')", 15);
  const r2 = (await apiGet(b, "/api/electricity/readings")).body;
  const ySaved = r2.items.find((x) => x.day === yIso);
  check("a day already covered by imported data is saved but not counted twice", ySaved && ySaved.counted === false, JSON.stringify(ySaved || {}).slice(0, 160));
  await route(b, "electricity/analytics");
  check("analytics lists manual readings with their status", await b.waitFor("/Not counted/.test(document.querySelector('.view.active #manual-readings')?.innerText || '') && /Counted/.test(document.querySelector('.view.active #manual-readings').innerText)", 20));
  check("daily consumption chart includes the manual day", await b.evaluate("!!document.querySelector('.view.active #ch-usage-daily canvas')")
    && (await apiGet(b, "/api/electricity/usage")).body.daily.source.at(-1) === "manual");
  // edit today's reading up to a clear spike: detection runs and the badge counts the new anomaly
  const todayRow = r2.items.find((x) => x.day === todayIso);
  await b.evaluate(`[...document.querySelectorAll('.view.active [data-edit-er]')].find((x) => JSON.parse(x.dataset.editEr).id === ${todayRow.id}).click(); 1`);
  await b.waitFor("!!document.querySelector('#usage-form')", 10);
  check("edit opens with the saved values", await b.evaluate("document.querySelector('#usage-form').elements.kwh.value") === "9");
  await submit(b, "#usage-form", { kwh: "60" });
  await b.waitFor("!document.querySelector('#usage-form')", 15);
  check("edited value is saved", (await apiGet(b, "/api/electricity/readings")).body.items.find((x) => x.id === todayRow.id)?.kwh === 60);
  check("a new anomaly from the manual reading shows as unread in the badge", await b.waitFor("document.querySelector('#nav-count').textContent.trim() === '1'", 15),
    `badge "${await badge()}"`);
  await route(b, "electricity/anomalies");
  const pgErr = await pageState(b);
  check("the manual-reading anomaly renders on the Anomaly Detection page", !pgErr.error && await b.evaluate(
    `!!document.querySelector('.view.active tr[data-key="manual:spike:${todayIso}"]') && /Manual readings/.test(document.querySelector('.view.active').innerText)`),
    pgErr.error ? await b.evaluate("document.querySelector('.view.active').innerText.slice(0, 200)") : "");
  await b.evaluate(`document.querySelector('.view.active tr[data-key="manual:spike:${todayIso}"]').click(); 1`);
  check("its detail shows actual, expected, deviation, explanation and suggested checks", await b.waitFor(
    "['daily use', 'expected', 'deviation', 'why it was flagged', 'suggested checks'].every((w) => document.querySelector('.view.active #detail').innerText.toLowerCase().includes(w))", 10));
  check("opening it marks it read (badge cleared)", await b.waitFor("document.querySelector('#nav-count').textContent.trim() === ''", 10));
  await route(b, "electricity/analytics");
  const ov = (await apiGet(b, "/api/household/summary")).body.electricity;
  check("overview uses the manual reading for today (no double counting)", ov.latest_day === todayIso && Math.abs(ov.latest_value - 60) < 0.01,
    JSON.stringify({ latest_day: ov.latest_day, latest_value: ov.latest_value }));
  await b.evaluate(`document.querySelector('.view.active [data-del-er="${ySaved.id}"]').click(); 1`);
  await b.waitFor("!!document.querySelector('.modal #yes')", 10);
  await b.evaluate("document.querySelector('.modal #yes').click(); 1");
  check("delete removes the reading", await b.waitFor(`fetch('/api/electricity/readings').then((r) => r.json()).then((d) => d.total === 1)`, 15));

  begin("Journey: add water data");
  const wPath = join(tmp, "e2e-water.csv"); writeFileSync(wPath, waterCsv());
  const ePath2 = join(tmp, "e2e-electricity-as-water.csv"); writeFileSync(ePath2, "timestamp,kwh\n" + `${iso(daysAgo(2))} 10:00,0.5\n`);
  const dsBefore = JSON.stringify((await apiGet(b, "/api/datasets")).body);
  await route(b, "water/analytics");
  check("Water Usage Analytics has a Manage water data card with Add Water CSV",
    await b.evaluate("!!document.querySelector('.view.active #w-manage [data-csv-pick]') && document.querySelector('.view.active #wa-csv')?.type === 'file'"));
  // the button must open the operating system's file picker (Chrome reports it when interception is on)
  await b.send("Page.setInterceptFileChooserDialog", { enabled: true });
  const fcBefore = b.fileChoosers.length;
  await b.evaluate("document.querySelector('.view.active [data-csv-pick]').click(); 1");
  for (let i = 0; i < 25 && b.fileChoosers.length === fcBefore; i++) await sleep(200);
  check("Add Water CSV opens the native file picker", b.fileChoosers.length > fcBefore, `${b.fileChoosers.length - fcBefore} file chooser(s), mode ${b.fileChoosers.at(-1)?.mode}`);
  await b.send("Page.setInterceptFileChooserDialog", { enabled: false });
  const accept = await b.evaluate("document.querySelector('.view.active #wa-csv').accept");
  check("file picker is filtered to CSV files", /\.csv/.test(accept) && /text\/csv/.test(accept), accept);

  // an electricity file offered as water is refused, with nothing stored
  await b.setFile(".view.active #wa-csv", ePath2);
  check("electricity CSV is refused as water, with a clear message",
    await b.waitFor("/electricity/i.test(document.querySelector('.modal .imp-body')?.innerText || '') && !document.querySelector('#imp-go')", 30),
    await b.evaluate("document.querySelector('.modal')?.innerText.slice(0, 200)"));
  await b.evaluate("document.querySelector('.modal [data-modal-close]').click(); 1");
  check("nothing was imported from the refused file", (await apiGet(b, "/api/water/readings")).body?.total === 0);

  // valid file: preview first, cancel stores nothing, confirm imports
  await b.setFile(".view.active #wa-csv", wPath);
  check("preview shows the file, row counts and a data preview before import",
    await b.waitFor("!!document.querySelector('#imp-go') && document.querySelectorAll('.modal .imp-table tbody tr').length > 0", 60),
    await b.evaluate("document.querySelector('.modal .imp-summary')?.innerText.split(String.fromCharCode(10)).join(' ')"));
  check("preview names the selected file", await b.evaluate("document.querySelector('.modal .imp-file')?.innerText.includes('e2e-water.csv')"));
  await b.evaluate("[...document.querySelectorAll('.modal [data-modal-close]')].at(-1).click(); 1");
  check("cancelling the preview stores nothing", (await apiGet(b, "/api/water/readings")).body?.total === 0);
  await b.setFile(".view.active #wa-csv", wPath);
  await b.waitFor("!!document.querySelector('#imp-go')", 60);
  await b.evaluate("document.querySelector('#imp-go').click(); 1");
  check("import confirms with the number of records imported",
    await b.waitFor("/Imported 45 new readings/.test(document.querySelector('.modal')?.innerText || '')", 60),
    await b.evaluate("document.querySelector('.modal')?.innerText.slice(0, 200)"));
  await b.evaluate("document.querySelector('.modal [data-modal-close]')?.click(); 1");
  const wsum0 = (await apiGet(b, "/api/water/summary")).body;
  check("water CSV imported (45 daily readings) and analytics refreshed",
    wsum0?.days >= 45 && await b.waitFor("/45 days of water readings/.test(document.querySelector('.view.active .source-line')?.innerText || '')", 30), `days=${wsum0?.days}`);
  const dsAfter = JSON.stringify((await apiGet(b, "/api/datasets")).body);
  check("water import did not touch electricity data", dsAfter === dsBefore, `${dsBefore?.slice(0, 120)} -> ${dsAfter?.slice(0, 120)}`);

  check("manual water entry submitted", (await submit(b, "#w-entry", { date: iso(daysAgo(2)), value: "430" })) === "ok");
  await b.waitFor(`fetch('/api/water/readings?limit=200').then((r) => r.json()).then((d) => JSON.stringify(d).includes('${iso(daysAgo(2))}'))`, 20);
  const readings = await apiGet(b, "/api/water/readings?limit=200");
  check("manual reading stored", JSON.stringify(readings.body || "").includes(iso(daysAgo(2))), `status ${readings.status}`);

  begin("Journey: set daily limits");
  await route(b, "water/limit");
  check("limit page has overview, progress/period, history and configuration sections", await b.evaluate(
    "!!document.querySelector('.view.active .lim-overview') && !!document.querySelector('.view.active .lim-main') && !!document.querySelector('.view.active #ch-limit canvas') && !!document.querySelector('.view.active #lim-config')"));
  await b.evaluate("const f = document.querySelector('.view.active #lim-water'); f.elements.default.value = '999'; f.reset(); 1");
  check("Cancel discards unsaved limit changes", await b.waitFor("document.querySelector('.view.active #lim-water').elements.default.value !== '999'", 5));
  check("water limit form submitted", (await submit(b, "#lim-water", { default: "600" })) === "ok");
  await b.waitFor("fetch('/api/settings').then((r) => r.json()).then((s) => JSON.stringify(s.limits?.water || s.water || {}).includes('600'))", 20);
  const lim = await apiGet(b, "/api/limits/water/history?days=30");
  check("water limit saved as 600 L", lim.body?.unit === "L" && (lim.body?.daily?.limit || []).some((x) => x === 600), JSON.stringify(lim.body?.limits || "").slice(0, 120));
  await route(b, "electricity/limit");
  check("electricity limit form submitted", (await submit(b, "#lim-electricity", { default: "15" })) === "ok");
  await b.waitFor("fetch('/api/limits/electricity/history?days=30').then((r) => r.json()).then((h) => (h.daily?.limit || []).some((x) => x === 15))", 20);
  check("electricity limit saved as 15 kWh", (await apiGet(b, "/api/limits/electricity/history?days=30")).body?.unit === "kWh");
  await route(b, "electricity/limit");
  check("limit overview shows the saved limit, today's use, remaining, % and status", await b.evaluate(
    "(() => { const t = document.querySelector('.view.active .lim-overview').innerText; return /15[.,]0 kWh/.test(t) && /Status/.test(t) && /%/.test(t); })()"),
    await b.evaluate("document.querySelector('.view.active .lim-overview').innerText.replace(/\\s+/g, ' ')"));
  check("progress bar shows the warning threshold and the limit", await b.evaluate("document.querySelectorAll('.view.active .limit-bar.big .lb-mark').length === 2"));

  begin("Journey: trigger a water anomaly");
  const before = (await apiGet(b, "/api/notifications")).body?.total ?? 0;
  await route(b, "water/analytics");
  await b.waitFor("!!document.querySelector('#w-entry')", 20);
  check("spike reading entered (2,600 L - 4x normal and over the 600 L limit)", (await submit(b, "#w-entry", { date: iso(daysAgo(1)), value: "2600" })) === "ok");
  await b.waitFor(`fetch('/api/notifications').then((r) => r.json()).then((n) => n.total > ${before})`, 30);
  await route(b, "water/anomalies");
  const wsum = (await apiGet(b, "/api/water/summary")).body;
  const spike = (wsum?.anomalies || []).find((e) => e.type === "spike" && e.start?.startsWith(iso(daysAgo(1))));
  check("water spike detected on the spike day", !!spike, (wsum?.anomalies || []).map((e) => `${e.type}@${e.start}`).join(", "));
  const notes = (await apiGet(b, "/api/notifications")).body;
  check("a new notification was created", (notes?.total ?? 0) > before, `${before} -> ${notes?.total}`);
  check("notification mentions water", (notes?.items || []).some((n) => /water/i.test(`${n.title} ${n.body} ${n.utility}`)), (notes?.items || []).slice(0, 4).map((n) => n.title).join(" | "));
  await route(b, "notifications");
  check("notification centre lists the alert", await b.evaluate("[...document.querySelectorAll('.view.active li.nc')].some((li) => /water/i.test(li.innerText))"));
  check("unread badge is shown", await b.evaluate("(document.querySelector('#notif-badge')?.textContent || document.querySelector('#nav-unread')?.textContent || '').trim() !== ''"));
  await b.shot("journey-notifications.png");

  begin("Journey: water anomaly read state");
  const wBefore = (await apiGet(b, "/api/anomalies/counts")).body;
  check("water badge counts unread water anomalies, independent of electricity",
    wBefore.water.unread > 0 && (await b.evaluate("document.querySelector('#nav-count-water').textContent.trim()")) === String(wBefore.water.unread),
    JSON.stringify(wBefore));
  await b.viewport(1440, 700);
  await route(b, "water/anomalies");
  await b.evaluate("scrollTo(0, 0); 1"); await sleep(2500);
  check("opening the page doesn't mark off-screen water anomalies read", (await apiGet(b, "/api/anomalies/counts")).body.water.unread === wBefore.water.unread);
  await b.evaluate("document.querySelector('.view.active .wa-card summary').scrollIntoView({ block: 'center' }); 1");
  check("a water anomaly scrolled into view is marked read",
    await b.waitFor(`fetch('/api/anomalies/counts').then((r) => r.json()).then((c) => c.water.unread === ${wBefore.water.unread - 1})`, 15));
  check("electricity read state untouched by water", (await apiGet(b, "/api/anomalies/counts")).body.electricity.unread === wBefore.electricity.unread);
  await b.viewport(1440, 900);

  begin("Journey: reports");
  const dlDir = join(tmp, "downloads");
  mkdirSync(dlDir, { recursive: true });
  await b.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir });
  await route(b, "reports");
  const lay = await b.evaluate(`(() => { const c = document.querySelector('.view.active #rep-config').getBoundingClientRect(), p = document.querySelector('.view.active #rep-preview').getBoundingClientRect();
    return JSON.stringify({ cfgH: Math.round(c.height), below: p.top >= c.bottom - 1, sameWidth: Math.abs(c.width - p.width) < 2 }); })()`);
  const layj = JSON.parse(lay);
  check("configuration is a compact bar with the report full width below it", layj.below && layj.sameWidth && layj.cfgH < 260, lay);
  const genRep = async (kind, start, end) => {
    await b.evaluate(`(() => { const f = document.querySelector('.view.active #gen'); document.querySelector('.view.active [data-kind=${kind}]').click();
      f.elements.start.value = '${start}'; f.elements.start.dispatchEvent(new Event('change')); f.elements.end.value = '${end}'; f.elements.end.dispatchEvent(new Event('change'));
      f.requestSubmit(); return 1; })()`);
  };
  const shownReady = (re) => b.waitFor(`/${re}/i.test(document.querySelector('.view.active #rep-preview .rep-head')?.innerText || '')`, 30);
  const dlBefore = b.downloads.length;
  await genRep("electricity", iso(daysAgo(20)), iso(daysAgo(1)));
  const okToast = b.waitFor("[...document.querySelectorAll('.toast')].some((x) => /report is ready/.test(x.innerText))", 15);
  check("Generate shows an electricity report below the configuration", await shownReady("Electricity report")
    && await b.waitFor("!!document.querySelector('.view.active #rep-preview [data-rep-chart=electricity] canvas')", 20));
  const sawToast = await okToast;
  await sleep(1500);
  check("Generate does not start a download or leave the page", b.downloads.length === dlBefore && (await b.evaluate("location.hash")) === "#reports",
    `${b.downloads.length - dlBefore} download(s), hash ${await b.evaluate("location.hash")}`);
  check("a success message confirms the report", sawToast);
  const rep = (await apiGet(b, "/api/reports")).body.custom[0];
  const full = (await apiGet(b, `/api/reports/custom/${rep.id}`)).body.data;
  check("the report shows the stored figures", (await b.evaluate("document.querySelector('.view.active #rep-preview').innerText"))
    .includes(full.electricity.total_kwh.toLocaleString("en-IN", { maximumFractionDigits: 1 })));
  const fileDownloaded = async (ext) => {
    const n = b.downloads.length;
    await b.evaluate(`document.querySelector('.view.active #rep-preview [data-dl=${ext}]').click(); 1`);
    for (let k = 0; k < 75 && !(b.downloads.length > n && b.downloads.at(-1).state === "completed"); k++) await sleep(200);
    const d = b.downloads.at(-1);
    return b.downloads.length > n && d.state === "completed" ? d : null;
  };
  const pdfDl = await fileDownloaded("pdf");
  const pdfFile = pdfDl ? readFileSync(join(dlDir, pdfDl.suggestedFilename)) : Buffer.alloc(0);
  check("PDF button downloads a real PDF with a meaningful name", !!pdfDl && /^PowerPulse_Electricity_Report_.+\.pdf$/.test(pdfDl.suggestedFilename)
    && pdfFile.subarray(0, 5).toString() === "%PDF-" && pdfFile.length > 1500, pdfDl?.suggestedFilename);
  const csvDl = await fileDownloaded("csv");
  const csvText = csvDl ? readFileSync(join(dlDir, csvDl.suggestedFilename), "utf8") : "";
  const csvRows = csvText.split(/\r?\n/).filter((l) => /^\d{4}-/.test(l));
  check("CSV button downloads the report's daily figures", !!csvDl && csvDl.suggestedFilename.endsWith(".csv") && csvRows.length === full.daily.length
    && Math.abs(csvRows.reduce((a, l) => a + +l.split(",")[1], 0) - full.electricity.total_kwh) < 0.11, `${csvDl?.suggestedFilename} ${csvRows.length} rows`);
  check("the report stays on screen after downloading", (await b.evaluate("location.hash")) === "#reports"
    && await b.evaluate("/Electricity report/i.test(document.querySelector('.view.active #rep-preview .rep-head').innerText)"));
  await genRep("water", iso(daysAgo(20)), iso(daysAgo(1)));
  check("water report generated and shown", await shownReady("Water report"));
  await genRep("combined", iso(daysAgo(20)), iso(daysAgo(1)));
  check("combined report shows electricity and water in separate sections", await shownReady("Combined")
    && await b.evaluate("document.querySelectorAll('.view.active #rep-preview .rep-util.elec, .view.active #rep-preview .rep-util.water').length === 2"));
  await genRep("water", iso(daysAgo(1)), iso(daysAgo(20)));
  check("an end date before the start date is refused with a message", await b.waitFor("/on or after/.test(document.querySelector('.view.active #gen-err:not([hidden])')?.innerText || '')", 10));
  await genRep("water", iso(daysAgo(400)), iso(daysAgo(380)));
  check("a period with no data says so (no invented figures)", await b.waitFor("/no water data/i.test(document.querySelector('.view.active #gen-err:not([hidden])')?.innerText || '') && /No data for this period/.test(document.querySelector('.view.active #rep-preview').innerText)", 20),
    await b.evaluate("document.querySelector('.view.active #gen-err')?.innerText"));
  await b.evaluate("document.querySelector('.view.active [data-view]').click(); 1");
  check("an earlier report reopens from Recent reports", await b.waitFor("!!document.querySelector('.view.active #rep-preview .rep-head')", 20));
  await b.shot("journey-reports.png");

  begin("Journey: change theme");
  await b.evaluate("document.querySelector('#theme-dd [data-dd-toggle]').click(); 1"); await sleep(250);
  await b.evaluate("document.querySelector('[data-theme-set=dark]').click(); 1");
  check("theme menu switches to dark", await b.waitFor("document.documentElement.dataset.theme === 'dark'", 10));
  await b.evaluate("location.reload(); 1"); await sleep(120);
  check("dark theme applied before the app loads (no flash)", (await b.evaluate("document.documentElement.dataset.theme")) === "dark");
  await b.waitFor(ACTIVE_READY, 60);
  await b.shot("journey-dark-notifications.png");

  begin("Journey: settings");
  await route(b, "settings");
  await settingsTab(b, "account");
  await submit(b, "#profile", { name: user.name + " Updated" });
  check("profile name saved", await b.waitFor(`fetch('/api/auth/me').then((r) => r.json()).then((u) => u.name === ${JSON.stringify(user.name + " Updated")})`, 20));
  check("WhatsApp is gone from settings, the account menu and the notification centre", await b.evaluate(
    "!document.querySelector('[data-stab=whatsapp], [data-settings-tab=whatsapp]') && !/whatsapp/i.test(document.querySelector('.view.active').innerText + document.querySelector('#user-dd').innerText)"));
  check("settings show a section heading and readable device names", await b.evaluate(
    "/Account/.test(document.querySelector('.view.active .set-head h2')?.textContent) && !/Mozilla\\/5/.test(document.querySelector('.view.active .sess-table')?.innerText || 'x')"));
  await settingsTab(b, "reports");
  check("monthly report settings: switch in the header, day and type side by side, Save + Open reports", await b.evaluate(
    "(() => { const c = document.querySelector('.view.active .rep-settings'); const g = c?.querySelectorAll('.rep-set-grid .field'); return !!c?.querySelector('.card-h #rep-enabled') && g?.length === 2 && Math.abs(g[0].getBoundingClientRect().top - g[1].getBoundingClientRect().top) < 2 && !!c.querySelector('#rep-save') && !!c.querySelector('[data-goto=reports]'); })()"));
  await b.evaluate("const c = document.querySelector('.view.active .rep-settings'); c.querySelector('#rep-day').value = '5'; c.querySelector('#rep-kind').value = 'water'; c.querySelector('#rep-save').click(); 1");
  check("report settings save for this user", await b.waitFor("fetch('/api/settings').then((r) => r.json()).then((s) => s.settings.reports.day === 5 && s.settings.reports.include_water && !s.settings.reports.include_electricity)", 15));
  await b.evaluate("location.reload(); 1"); await sleep(400);
  await b.waitFor(ACTIVE_READY, 60);
  await settingsTab(b, "reports");
  check("report settings persist after refresh", await b.evaluate("document.querySelector('.view.active #rep-day').value === '5' && document.querySelector('.view.active #rep-kind').value === 'water'"));
  for (const tab of ["appearance", "notifications", "reports", "electricity", "water", "detection", "data", "privacy"]) {
    const ok = await settingsTab(b, tab) && !(await b.evaluate("/Couldn't load/.test(document.querySelector('.view.active .set-body').innerText)"));
    check(`settings tab "${tab}" renders`, ok);
  }

  begin("Journey: sign out");
  await b.evaluate("document.querySelector('#logout').click(); 1");
  check("signed out to the landing page", await b.waitFor("location.pathname === '/'", 20));
  check("API rejects the old session", (await apiGet(b, "/api/auth/me")).status === 401);
}

// ---------------- responsive + theme matrix ----------------
const VIEWPORTS = [[1920, 1080], [1440, 900], [1024, 768], [768, 1024], [390, 844], [360, 800]];
async function responsive(b, user) {
  begin("Responsive: setup");
  await b.viewport(1440, 900); await b.colorScheme("light");
  await b.goto(BASE + "/login");
  await submit(b, "#f", { email: user.email, password: user.password });
  if (!(await b.waitFor(`location.pathname === '/dashboard' && ${ACTIVE_READY}`, 60))) {
    // responsive-only run: create a fresh account with clearly labelled demo data
    await b.goto(BASE + "/register");
    await submit(b, "#f", { name: user.name, email: user.email, password: user.password, confirm: user.password });
    await b.waitFor(`location.pathname === '/dashboard' && ${ACTIVE_READY}`, 60);
    await b.evaluate(`(async () => { const h = { 'X-Requested-With': 'PowerPulse', 'Content-Type': 'application/json' };
      await fetch('/api/datasets/scenario', { method: 'POST', headers: h, body: JSON.stringify({ scenario: 'mixed', seed: 3 }) });
      await fetch('/api/water/demo', { method: 'POST', headers: h }); return 1; })()`);
  }
  check("signed in for the responsive run", await b.waitFor("location.pathname === '/dashboard'", 5));

  for (const [w, h] of VIEWPORTS) {
    begin(`Responsive: ${w}x${h}`);
    await b.viewport(w, h);
    await b.evaluate("try { localStorage.setItem('powerpulse.theme', 'light') } catch {} ; location.reload(); 1");
    await b.waitFor(ACTIVE_READY, 60);
    const bad = [];
    for (const r of ROUTES) {
      const ok = await route(b, r), s = await pageState(b);
      if (!ok || s.error || s.overflow > 1 || s.phantom > 2) bad.push(`${r}(${!ok ? "timeout" : s.error ? "error: " + (await b.evaluate("document.querySelector('.view.active').innerText.slice(0, 120)")) : s.phantom > 2 ? "page " + s.phantom + "px taller than its content" : "overflow " + s.overflow + "px"})`);
    }
    check(`all ${ROUTES.length} sections render without horizontal scroll`, bad.length === 0, bad.join(", "));
    const nav = await b.evaluate(`({ menu: getComputedStyle(document.querySelector('#menu')).display !== 'none',
      sidebarOnScreen: document.querySelector('#sidebar').getBoundingClientRect().right > 4 })`);
    if (w < 1024) {
      check("phone/tablet: menu button shown and sidebar off-canvas", nav.menu && !nav.sidebarOnScreen, JSON.stringify(nav));
      await b.evaluate("document.querySelector('#menu').click(); 1"); await sleep(450);
      const open = await b.evaluate("document.querySelector('#sidebar').getBoundingClientRect().left >= -1 && document.querySelector('#menu').getAttribute('aria-expanded') === 'true'");
      check("menu button opens the navigation drawer", open);
      await b.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1"); await sleep(450);
      check("Escape closes the drawer", await b.evaluate("document.querySelector('#menu').getAttribute('aria-expanded') !== 'true'"));
    } else {
      check("desktop: sidebar visible", nav.sidebarOnScreen, JSON.stringify(nav));
    }
    for (const [mode, os, expect] of [["light", "dark", "light"], ["dark", "light", "dark"], ["system", "dark", "dark"], ["system", "light", "light"]]) {
      await b.colorScheme(os);
      await b.evaluate(`try { ${mode === "system" ? "localStorage.removeItem('powerpulse.theme')" : `localStorage.setItem('powerpulse.theme', '${mode}')`} } catch {} ; location.hash = 'overview'; location.reload(); 1`);
      await b.waitFor(ACTIVE_READY, 60); await sleep(600);
      const s = await pageState(b);
      check(`theme ${mode}${mode === "system" ? ` (OS ${os})` : ""} -> ${expect}`, s.theme === expect && !s.error && s.overflow <= 1, `got ${s.theme}, overflow ${s.overflow}`);
      if (os === (expect === "dark" ? "light" : "dark") || mode === "system") await b.shot(`overview-${w}x${h}-${mode}${mode === "system" ? "-" + os : ""}.png`);
    }
    await b.colorScheme("light");
    // landing page at this size
    await b.goto(BASE + "/");
    const l = await b.evaluate(`({ overflow: document.documentElement.scrollWidth - innerWidth,
      signIn: [...document.querySelectorAll('a')].filter((a) => /sign in/i.test(a.textContent) && a.offsetParent).length })`);
    check("landing page: no horizontal scroll, at most one visible 'Sign in'", l.overflow <= 1 && l.signIn <= 1, JSON.stringify(l));
    await b.goto(BASE + "/dashboard#overview"); await b.waitFor(ACTIVE_READY, 60);
  }
}

// ---------------- main ----------------
const tmp = mkdtempSync(join(tmpdir(), "powerpulse-e2e-"));
const user = { name: "E2E Tester", email: `e2e-${Date.now()}@example.test`, password: "Monsoon2026e2e" };
let server, browser, crashed = null;
const started = Date.now();
try {
  console.log(`PowerPulse E2E - server ${BASE}, temp ${tmp}`);
  server = await startServer(tmp);
  browser = await startBrowser(join(tmp, "chrome-profile"));
  if (ONLY !== "responsive") await journey(browser, tmp, user);
  if (ONLY !== "journey") await responsive(browser, user);
  begin("Browser console");
  const csp = browser.problems.filter((p) => /Content Security Policy|Refused to/i.test(p));
  check("no Content-Security-Policy violations", csp.length === 0, csp.slice(0, 5).join(" | "));
  // expected: the deliberate wrong-password attempt and the post-logout /api/auth/me probe log failed requests
  const other = browser.problems.filter((p) => !csp.includes(p) && !/status of 40[13]/.test(p)
    && !/status of 404 .*\/api\/datasets\/active$/.test(p)
    && !/status of 409 .*\/api\/electricity\/readings$/.test(p)   // the deliberate duplicate-entry check
    && !/status of 422 .*\/api\/reports\/custom$/.test(p));      // the deliberate "period with no data" check
  check("no JavaScript exceptions or console errors", other.length === 0, other.slice(0, 8).join(" | "));
} catch (e) {
  crashed = e;
  check("runner completed", false, e.stack || e.message);
} finally {
  browser?.close();
  if (server) { server.proc.kill(); writeFileSync(join(OUT, "server.log"), server.log()); }
  await sleep(500);
  if (!process.env.E2E_KEEP) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may still hold the db */ } }
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, "results.json"), JSON.stringify({ when: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), mode: ONLY,
  passed: results.length - failed.length, failed: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed in ${Math.round((Date.now() - started) / 1000)}s - details in e2e/output/results.json`);
if (failed.length) for (const f of failed) console.log(`  FAILED [${f.section}] ${f.name}: ${f.detail.slice(0, 300)}`);
process.exit(failed.length || crashed ? 1 : 0);
