"""Email + password authentication with server-side sessions.

Session token: 32 random bytes in an HttpOnly, SameSite=Lax cookie; only its SHA-256 is stored.
Passwords: scrypt. Resets: single-use tokens (hashed) valid for 30 minutes.
"""
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from . import config, db, mailer, security, user_settings

log = logging.getLogger("powerpulse.auth")
router = APIRouter(prefix="/api/auth", tags=["auth"])
COOKIE = "pp_session"
login_limiter = security.RateLimiter(limit=8, window_s=15 * 60)        # per IP + email (guessing one account)
# per-IP limits are configurable: many real users can share one IP (campus / office Wi-Fi, mobile NAT)
login_ip_limiter = security.RateLimiter(limit=int(config.env("POWERPULSE_LOGIN_LIMIT_PER_IP", "100")), window_s=15 * 60)
register_limiter = security.RateLimiter(limit=int(config.env("POWERPULSE_REGISTER_LIMIT_PER_IP", "30")), window_s=60 * 60)
forgot_limiter = security.RateLimiter(limit=5, window_s=60 * 60)
password_check_limiter = security.RateLimiter(limit=10, window_s=15 * 60)  # per user: change password / email / delete
RESET_MINUTES = 30


def _utc(minutes=0, days=0):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes, days=days)).replace(microsecond=0).isoformat()


def public_user(u):
    return {
        "id": u["id"], "name": u["name"], "email": u["email"], "created_at": u["created_at"],
    }


# ---------------- session plumbing ----------------
def _start_session(conn, response: Response, user_id: int, request: Request, remember=False):
    token = security.new_token()
    days = config.REMEMBER_DAYS if remember else config.SESSION_DAYS
    conn.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
                 (security.token_hash(token), user_id, db.now(), _utc(days=days), (request.headers.get("user-agent") or "")[:200]))
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (db.now(),))
    response.set_cookie(COOKIE, token, max_age=days * 86400, httponly=True, samesite="lax",
                        secure=config.SECURE_COOKIES, path="/")
    return token


def session_user(request: Request):
    """User row for the request's session cookie, or None."""
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    with db.connect() as conn:
        r = conn.execute("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
                         "WHERE s.token_hash = ? AND s.expires_at > ?", (security.token_hash(token), db.now())).fetchone()
    return db.row(r)


def current_user(request: Request):
    """FastAPI dependency for every protected endpoint."""
    u = session_user(request)
    if not u:
        raise HTTPException(401, "Please sign in to continue.")
    return u


def _client_ip(request: Request):
    return request.client.host if request.client else "?"


# ---------------- request models ----------------
class RegisterIn(BaseModel):
    name: str
    email: str
    password: str
    remember: bool = False


class LoginIn(BaseModel):
    email: str
    password: str
    remember: bool = False


class ResetIn(BaseModel):
    token: str
    password: str


class PasswordIn(BaseModel):
    current_password: str
    new_password: str


class ProfileIn(BaseModel):
    name: str | None = None
    email: str | None = None
    current_password: str | None = None


def _clean_email(email: str):
    email = (email or "").strip().lower()
    if not security.EMAIL_RE.match(email) or len(email) > 254:
        raise HTTPException(422, "Enter a valid email address.")
    return email


def _clean_name(name: str):
    name = " ".join((name or "").split())
    if not 1 <= len(name) <= 80:
        raise HTTPException(422, "Name must be between 1 and 80 characters.")
    return name


# ---------------- endpoints ----------------
@router.post("/register", status_code=201)
def register(body: RegisterIn, request: Request, response: Response):
    if not register_limiter.hit(_client_ip(request)):
        raise HTTPException(429, "Too many accounts created from this network. Try again later.")
    name, email = _clean_name(body.name), _clean_email(body.email)
    problem = security.password_problem(body.password, email, name)
    if problem:
        raise HTTPException(422, problem)
    with db.connect() as conn:
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise HTTPException(409, "An account with this email already exists. Sign in instead.")
        with db.transaction(conn):
            cur = conn.execute("INSERT INTO users (email, name, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)",
                               (email, name, security.hash_password(body.password), db.now(), db.now()))
            uid = cur.lastrowid
            user_settings.save(conn, uid, user_settings.get(conn, uid))
        _start_session(conn, response, uid, request, body.remember)
        return public_user(db.row(conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()))


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response):
    email = (body.email or "").strip().lower()
    key = f"{_client_ip(request)}|{email}"
    if not login_ip_limiter.hit(_client_ip(request)) or not login_limiter.hit(key):
        raise HTTPException(429, "Too many sign-in attempts. Wait 15 minutes and try again.")
    with db.connect() as conn:
        u = db.row(conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone())
        ok = security.verify_password(body.password, u["password_hash"] if u else security.DUMMY_HASH)
        if not (u and ok):
            raise HTTPException(401, "Incorrect email or password.")
        login_limiter.reset(key)
        _start_session(conn, response, u["id"], request, body.remember)
        return public_user(u)


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        with db.connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (security.token_hash(token),))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(user=Depends(current_user)):
    return public_user(user)


@router.post("/forgot")
def forgot(request: Request, email: str = Body(..., embed=True)):
    """Always answers the same way so it can't be used to discover which emails have accounts."""
    generic = {"ok": True, "message": "If an account exists for that email, a reset link is on its way. It expires in 30 minutes."}
    email = (email or "").strip().lower()
    if not forgot_limiter.hit(f"{_client_ip(request)}|{email}") or not security.EMAIL_RE.match(email):
        return generic
    with db.connect() as conn:
        u = db.row(conn.execute("SELECT id, name FROM users WHERE email = ?", (email,)).fetchone())
        if not u:
            return generic
        token = security.new_token()
        with db.transaction(conn):
            conn.execute("DELETE FROM password_resets WHERE user_id = ?", (u["id"],))
            conn.execute("INSERT INTO password_resets VALUES (?, ?, ?, ?, NULL)",
                         (security.token_hash(token), u["id"], db.now(), _utc(minutes=RESET_MINUTES)))
    link = f"{config.APP_URL}/reset-password?token={token}"
    try:
        mailer.send(email, "Reset your PowerPulse password",
                    f"Hi {u['name']},\n\nUse this link to choose a new PowerPulse password. It expires in {RESET_MINUTES} minutes "
                    f"and can be used once:\n\n{link}\n\nIf you didn't ask for this, you can ignore this email.")
    except Exception as e:  # noqa: BLE001 - never reveal mail failures to the requester
        log.error("Password reset email failed for user %s: %s", u["id"], e)
    return generic


@router.post("/reset")
def reset(body: ResetIn):
    with db.connect() as conn:
        r = db.row(conn.execute("SELECT * FROM password_resets WHERE token_hash = ?", (security.token_hash(body.token),)).fetchone())
        if not r or r["used_at"] or r["expires_at"] < db.now():
            raise HTTPException(400, "This reset link is invalid or has expired. Request a new one.")
        u = db.row(conn.execute("SELECT * FROM users WHERE id = ?", (r["user_id"],)).fetchone())
        problem = security.password_problem(body.password, u["email"], u["name"])
        if problem:
            raise HTTPException(422, problem)
        with db.transaction(conn):
            conn.execute("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?",
                         (security.hash_password(body.password), db.now(), u["id"]))
            conn.execute("UPDATE password_resets SET used_at = ? WHERE token_hash = ?", (db.now(), r["token_hash"]))
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (u["id"],))  # sign out everywhere
    return {"ok": True}


def _check_password(user, password, message):
    """Verify the user's current password, rate-limited so a stolen session can't brute-force it."""
    if not password_check_limiter.hit(f"pw|{user['id']}"):
        raise HTTPException(429, "Too many attempts. Wait 15 minutes and try again.")
    if not security.verify_password(password or "", user["password_hash"]):
        raise HTTPException(400, message)


@router.post("/password")
def change_password(body: PasswordIn, request: Request, user=Depends(current_user)):
    _check_password(user, body.current_password, "Your current password is incorrect.")
    problem = security.password_problem(body.new_password, user["email"], user["name"])
    if problem:
        raise HTTPException(422, problem)
    keep = security.token_hash(request.cookies.get(COOKIE, ""))
    with db.connect() as conn, db.transaction(conn):
        conn.execute("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?",
                     (security.hash_password(body.new_password), db.now(), user["id"]))
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user["id"], keep))
    return {"ok": True}


@router.patch("/profile")
def update_profile(body: ProfileIn, user=Depends(current_user)):
    name = _clean_name(body.name) if body.name is not None else user["name"]
    email = user["email"]
    if body.email is not None and body.email.strip().lower() != user["email"]:
        email = _clean_email(body.email)
        _check_password(user, body.current_password, "Enter your current password to change your email.")
    with db.connect() as conn:
        if email != user["email"] and conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise HTTPException(409, "That email is already used by another account.")
        conn.execute("UPDATE users SET name = ?, email = ? WHERE id = ?", (name, email, user["id"]))
        return public_user(db.row(conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()))


@router.get("/sessions")
def sessions(request: Request, user=Depends(current_user)):
    mine = security.token_hash(request.cookies.get(COOKIE, ""))
    with db.connect() as conn:
        rows = conn.execute("SELECT token_hash, created_at, expires_at, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? "
                            "ORDER BY created_at DESC", (user["id"], db.now())).fetchall()
    return [{"current": r["token_hash"] == mine, "created_at": r["created_at"], "expires_at": r["expires_at"],
             "user_agent": r["user_agent"]} for r in rows]


@router.post("/logout-others")
def logout_others(request: Request, user=Depends(current_user)):
    keep = security.token_hash(request.cookies.get(COOKIE, ""))
    with db.connect() as conn:
        n = conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user["id"], keep)).rowcount
    return {"ok": True, "signed_out": n}


@router.post("/delete-account")
def delete_account(response: Response, password: str = Body(..., embed=True), user=Depends(current_user)):
    _check_password(user, password, "Password is incorrect.")
    with db.connect() as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (user["id"],))  # cascades to every user-owned table
    response.delete_cookie(COOKIE, path="/")
    from . import electricity  # local import: avoid a cycle at module load
    electricity.forget_user(user["id"])
    return {"ok": True}


@router.get("/export")
def export(user=Depends(current_user)):
    """Everything stored about the user except secrets and raw electricity frames."""
    with db.connect() as conn:
        def q(sql):
            return [dict(r) for r in conn.execute(sql, (user["id"],))]
        return {
            "user": public_user(user),
            "settings": user_settings.get(conn, user["id"]),
            "limits": user_settings.limits(conn, user["id"]),
            "electricity_datasets": q("SELECT id, name, source, meta, created_at, is_active FROM datasets WHERE user_id = ?"),
            "water_readings": q("SELECT ts, granularity, litres, source, notes, created_at, updated_at FROM water_readings WHERE user_id = ? ORDER BY ts"),
            "anomalies": q("SELECT utility, type, severity, start_ts, end_ts, title, detected_at FROM anomalies WHERE user_id = ?"),
            "notifications": q("SELECT category, kind, severity, title, body, created_at, read_at FROM notifications WHERE user_id = ?"),
            "monthly_reports": q("SELECT period, status, generated_at, trigger FROM monthly_reports WHERE user_id = ?"),
        }
