"""Password hashing (scrypt), opaque tokens, and a small in-memory rate limiter. Stdlib only."""
import base64
import hashlib
import hmac
import re
import secrets
import threading
import time

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    def b64(b):
        return base64.b64encode(b).decode()
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64(salt)}${b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, dk = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(dk)
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=len(expected))
        return hmac.compare_digest(got, expected)
    except (ValueError, TypeError):
        return False


# a hash to compare against when the email doesn't exist, so login timing doesn't reveal accounts
DUMMY_HASH = hash_password(secrets.token_urlsafe(12))


def password_problem(password: str, email: str = "", name: str = ""):
    """Return a user-facing reason the password is too weak, or None."""
    if len(password) < 8:
        return "Password must be at least 8 characters."
    if len(password) > 128:
        return "Password must be at most 128 characters."
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        return "Password must contain at least one letter and one number."
    low = password.lower()
    if email and email.split("@")[0].lower() in low and len(email.split("@")[0]) >= 4:
        return "Password must not contain your email name."
    if low in {"password1", "password123", "12345678a", "qwerty123", "powerpulse1"}:
        return "That password is too common."
    return None


def new_token(nbytes=32) -> str:
    return secrets.token_urlsafe(nbytes)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_code(digits=6) -> str:
    return f"{secrets.randbelow(10 ** digits):0{digits}d}"


class RateLimiter:
    """Sliding-window counter per key (e.g. login attempts per IP+email). Process-local."""

    def __init__(self, limit: int, window_s: int):
        self.limit, self.window = limit, window_s
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> bool:
        """Record an attempt; return False when the key is over its limit."""
        t = time.monotonic()
        with self._lock:
            hits = [h for h in self._hits.get(key, []) if t - h < self.window]
            allowed = len(hits) < self.limit
            if allowed:
                hits.append(t)
            self._hits[key] = hits
            if len(self._hits) > 10000:  # bound memory
                self._hits = {k: v for k, v in self._hits.items() if v and t - v[-1] < self.window}
            return allowed

    def reset(self, key: str):
        with self._lock:
            self._hits.pop(key, None)
