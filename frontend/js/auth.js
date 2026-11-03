// Login, registration, forgot-password and reset-password screens (one page, mode from the URL path).
import { hydrateIcons, icon, logo } from "./icons.js";
import { $, $$, applyMotionPref } from "./ui.js";
import { initTheme } from "./theme.js";

initTheme();
import { esc } from "./format.js";

applyMotionPref();
$$("[data-logo]").forEach((e) => { e.outerHTML = logo(36); });
hydrateIcons();

const params = new URLSearchParams(location.search);
const next = (() => { const n = params.get("next") || "/dashboard"; return n.startsWith("/") && !n.startsWith("//") ? n : "/dashboard"; })();
const MODES = { "/login": "login", "/register": "register", "/forgot-password": "forgot", "/reset-password": "reset" };
const mode = MODES[location.pathname] || "login";

async function call(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "PowerPulse" }, body: JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw new Error((data && (typeof data.detail === "string" ? data.detail : data.detail?.[0]?.msg)) || "Something went wrong. Please try again.");
  return data;
}

const field = ({ id, label, type = "text", auto, extra = "", toggle = false, hint = "" }) => `
  <div class="fld"><label for="${id}">${label}${extra}</label>
    <div class="inp"><input id="${id}" name="${id}" type="${type}" autocomplete="${auto}" ${toggle ? 'class="has-toggle"' : ""} required aria-describedby="${id}-err">
      ${toggle ? `<button type="button" class="eye" data-eye="${id}" aria-label="Show password" aria-pressed="false">${icon("eye")}</button>` : ""}</div>
    ${hint ? `<span class="hint">${hint}</span>` : ""}<span class="err" id="${id}-err"></span></div>`;

const strength = '<div class="strength" id="strength" data-score="0" aria-hidden="true"><span></span><span></span><span></span><span></span></div>';
const box = (kind, msg) => `<div class="alert-box ${kind}" role="${kind === "error" ? "alert" : "status"}">${icon(kind === "error" ? "alert" : kind === "success" ? "checkCircle" : "info")}<span>${msg}</span></div>`;

const VIEWS = {
  login: () => `<h1>Welcome back</h1><p class="sub">Sign in to your PowerPulse household.</p>
    ${params.get("reset") ? box("success", "Your password was changed. Sign in with the new one.") : ""}
    <form id="f" novalidate>
      <div id="msg"></div>
      ${field({ id: "email", label: "Email", type: "email", auto: "email" })}
      ${field({ id: "password", label: "Password", type: "password", auto: "current-password", toggle: true, extra: '<a href="/forgot-password">Forgot password?</a>' })}
      <label class="check"><input type="checkbox" id="remember"> Keep me signed in for 30 days</label>
      <button class="btn primary lg" type="submit">Sign in ${icon("arrowRight")}</button>
    </form><p class="alt">New to PowerPulse? <a href="/register${location.search}">Create an account</a></p>`,
  register: () => `<h1>Create your account</h1><p class="sub">Start monitoring electricity and water in minutes.</p>
    <form id="f" novalidate>
      <div id="msg"></div>
      ${field({ id: "name", label: "Full name", auto: "name" })}
      ${field({ id: "email", label: "Email", type: "email", auto: "email" })}
      ${field({ id: "password", label: "Password", type: "password", auto: "new-password", toggle: true, hint: "At least 8 characters with a letter and a number." })}
      ${strength}
      ${field({ id: "confirm", label: "Confirm password", type: "password", auto: "new-password", toggle: true })}
      <button class="btn primary lg" type="submit">Create account ${icon("arrowRight")}</button>
    </form><p class="alt">Already have an account? <a href="/login${location.search}">Sign in</a></p>`,
  forgot: () => `<h1>Reset your password</h1><p class="sub">Enter your account email and we'll send a single-use reset link.</p>
    <form id="f" novalidate>
      <div id="msg"></div>
      ${field({ id: "email", label: "Email", type: "email", auto: "email" })}
      <button class="btn primary lg" type="submit">Send reset link ${icon("mail")}</button>
    </form><p class="alt"><a href="/login">Back to sign in</a></p>`,
  reset: () => params.get("token") ? `<h1>Choose a new password</h1><p class="sub">This will sign you out of every other device.</p>
    <form id="f" novalidate>
      <div id="msg"></div>
      ${field({ id: "password", label: "New password", type: "password", auto: "new-password", toggle: true, hint: "At least 8 characters with a letter and a number." })}
      ${strength}
      ${field({ id: "confirm", label: "Confirm new password", type: "password", auto: "new-password", toggle: true })}
      <button class="btn primary lg" type="submit">Update password</button>
    </form>` : `<h1>Link missing</h1><p class="sub">Open the reset link from your email, or request a new one.</p>
    <a class="btn primary lg" href="/forgot-password">Request a new link</a>`,
};

document.title = { login: "Sign in", register: "Create account", forgot: "Forgot password", reset: "Reset password" }[mode] + " · PowerPulse";
const card = $("#card");
card.innerHTML = VIEWS[mode]();
const form = $("#f");

// show / hide password
$$("[data-eye]").forEach((b) => b.addEventListener("click", () => {
  const input = $("#" + b.dataset.eye), show = input.type === "password";
  input.type = show ? "text" : "password";
  b.setAttribute("aria-pressed", String(show));
  b.setAttribute("aria-label", show ? "Hide password" : "Show password");
  b.innerHTML = icon(show ? "eyeOff" : "eye");
}));

// password strength (guidance only - the server enforces the rules)
const pw = $("#password");
if ($("#strength") && pw) pw.addEventListener("input", () => {
  const v = pw.value;
  const score = !v ? 0 : Math.min(4, (v.length >= 8) + (v.length >= 12) + (/[A-Za-z]/.test(v) && /\d/.test(v)) + (/[^A-Za-z0-9]/.test(v) || /[a-z]/.test(v) && /[A-Z]/.test(v)));
  $("#strength").dataset.score = score;
});

const setErr = (id, msg) => {
  const el = $("#" + id + "-err"), input = $("#" + id);
  if (el) el.textContent = msg || "";
  if (input) input.setAttribute("aria-invalid", msg ? "true" : "false");
};
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

function validate() {
  let ok = true;
  const req = (id, test, msg) => { const el = $("#" + id); if (!el) return; const bad = !test(el.value.trim()); setErr(id, bad ? msg : ""); if (bad && ok) { el.focus(); ok = false; } };
  req("name", (v) => v.length >= 1 && v.length <= 80, "Enter your name.");
  req("email", (v) => EMAIL.test(v), "Enter a valid email address.");
  if (mode === "login") req("password", (v) => v.length > 0, "Enter your password.");
  if (mode === "register" || mode === "reset") {
    req("password", (v) => v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v), "Use at least 8 characters with a letter and a number.");
    req("confirm", (v) => v === $("#password").value, "Passwords don't match.");
  }
  return ok;
}

form?.addEventListener("input", (e) => { if (e.target.getAttribute("aria-invalid") === "true") setErr(e.target.id, ""); });
form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#msg").innerHTML = "";
  if (!validate()) return;
  const btn = form.querySelector("button[type=submit]"), label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin" aria-hidden="true"></span>Please wait…';
  const v = (id) => $("#" + id)?.value.trim();
  try {
    if (mode === "login") {
      await call("/api/auth/login", { email: v("email"), password: $("#password").value, remember: $("#remember").checked });
      location.replace(next);
      return;
    }
    if (mode === "register") {
      await call("/api/auth/register", { name: v("name"), email: v("email"), password: $("#password").value });
      location.replace(next);
      return;
    }
    if (mode === "forgot") {
      const r = await call("/api/auth/forgot", { email: v("email") });
      card.innerHTML = `<h1>Check your email</h1><p class="sub">${esc(r.message)}</p>
        ${box("info", "Running locally without an email server? The reset link is printed in the server console (email test mode) - it is never shown in the browser.")}
        <p class="alt"><a href="/login">Back to sign in</a></p>`;
      hydrateIcons(card);
      return;
    }
    await call("/api/auth/reset", { token: params.get("token"), password: $("#password").value });
    location.replace("/login?reset=1");
  } catch (err) {
    $("#msg").innerHTML = box("error", esc(err.message));
    btn.disabled = false;
    btn.innerHTML = label;
  }
});
($("#name") || $("#email") || $("#password"))?.focus();
