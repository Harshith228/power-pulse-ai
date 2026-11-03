"""PowerPulse API + static frontend.

Pages: / (landing), /login, /register, /forgot-password, /reset-password, /dashboard (signed-in only).
Run: python run.py  (or uvicorn app.main:app from backend/).
"""
import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from . import (anomaly_state, auth, config, db, electricity, electricity_manual, household, monthly, notify, settings_api, water_api, worker)
from .engine.loader import DataError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
FRONTEND = config.ROOT / "frontend"
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
# machine-to-machine endpoints authenticated by signature / device key instead of a browser session
CSRF_EXEMPT = ("/api/water/ingest",)
log = logging.getLogger("powerpulse")
# No inline scripts anywhere (theme boot code is js/boot.js); inline *styles* are used by templates and ECharts.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; "
       "base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
# the downloadable HTML report is a standalone page with an inline print button and inline styles
REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'"


@asynccontextmanager
async def lifespan(_app):
    db.init()
    if config.SCHEDULER_ENABLED:
        worker.start()
    yield
    worker.stop()


app = FastAPI(title="PowerPulse", version="3.1", lifespan=lifespan,
              docs_url=None if config.env_bool("POWERPULSE_HIDE_API_DOCS") else "/docs", redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=1024)  # the electricity analysis JSON is ~1.6 MB raw, ~0.4 MB gzipped


@app.middleware("http")
async def guard(request: Request, call_next):
    # CSRF: browsers can't add a custom header to a cross-site request without a CORS preflight, which this
    # app never allows, so requiring it on state-changing API calls blocks forged form posts.
    path = request.url.path
    if (request.method in UNSAFE and path.startswith("/api/") and not path.startswith(CSRF_EXEMPT)
            and request.headers.get("x-requested-with") != "PowerPulse"):
        return JSONResponse({"detail": "Missing request header. Reload the page and try again."}, status_code=403)
    response = await call_next(request)
    h = response.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("Referrer-Policy", "same-origin")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
    h.setdefault("Content-Security-Policy", REPORT_CSP if path.endswith("/report.html") else CSP)
    if config.SECURE_COOKIES:  # served over HTTPS
        h.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    if path.startswith("/api/"):
        h.setdefault("Cache-Control", "no-store")
    return response


@app.exception_handler(DataError)
async def data_error(_, exc):
    return PlainTextResponse(str(exc), status_code=422)


@app.exception_handler(Exception)
async def unexpected_error(request: Request, exc: Exception):
    """Never leak a stack trace to the client; log it with a reference the user can quote."""
    ref = uuid.uuid4().hex[:10]
    log.exception("unhandled error %s on %s %s", ref, request.method, request.url.path)
    return JSONResponse({"detail": f"Something went wrong on our side. If it keeps happening, quote reference {ref}."}, status_code=500)


@app.get("/api/health")
def health():
    """Liveness + readiness: database reachable and migrated, background worker running (when enabled)."""
    checks = {}
    try:
        with db.connect() as conn:
            conn.execute("SELECT 1").fetchone()
            checks["database"] = f"ok (schema v{conn.execute('PRAGMA user_version').fetchone()[0]})"
    except Exception as e:  # noqa: BLE001 - report, don't crash the probe
        log.error("health check: database error %s", e)
        checks["database"] = "error"
    checks["worker"] = ("running" if worker.alive() else "stopped") if config.SCHEDULER_ENABLED else "disabled"
    ok = checks["database"].startswith("ok") and checks["worker"] != "stopped"
    return JSONResponse({"ok": ok, **checks}, status_code=200 if ok else 503)


for r in (auth.router, electricity.router, electricity_manual.router, water_api.router, settings_api.router, notify.router,
          monthly.router, household.router, anomaly_state.router):
    app.include_router(r)


# ---------------- pages ----------------
AUTH_PAGES = ("/login", "/register", "/forgot-password", "/reset-password")


def _auth_page(request: Request):
    # a valid session never has to sign in or register again
    if request.url.path in ("/login", "/register") and auth.session_user(request):
        return RedirectResponse("/dashboard", status_code=303)
    return FileResponse(FRONTEND / "auth.html")


for _p in AUTH_PAGES:
    app.add_api_route(_p, _auth_page, include_in_schema=False)


@app.get("/dashboard", include_in_schema=False)
@app.get("/dashboard.html", include_in_schema=False)
def dashboard(request: Request):
    if not auth.session_user(request):
        return RedirectResponse("/login?next=/dashboard", status_code=303)
    return FileResponse(FRONTEND / "dashboard.html", headers={"Cache-Control": "no-store"})


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
