"""Runtime configuration from environment variables (optionally loaded from a project-root .env file).

Secrets (the SMTP password) are read here and never sent to the frontend.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv(path=ROOT / ".env"):
    """Minimal KEY=VALUE loader so no extra dependency is needed. Real env vars win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()


def env(name, default=""):
    return os.environ.get(name, default)


def env_bool(name, default=False):
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


def db_path():
    return Path(env("POWERPULSE_DB", str(ROOT / "data" / "powerpulse.db")))


APP_URL = env("POWERPULSE_APP_URL", "http://127.0.0.1:8000")
SECURE_COOKIES = env_bool("POWERPULSE_SECURE_COOKIES", APP_URL.startswith("https://"))
SESSION_DAYS = int(env("POWERPULSE_SESSION_DAYS", "7"))
REMEMBER_DAYS = 30
SCHEDULER_ENABLED = env_bool("POWERPULSE_SCHEDULER", True)


class SmtpConfig:
    @property
    def host(self): return env("SMTP_HOST")
    @property
    def port(self): return int(env("SMTP_PORT", "587"))
    @property
    def user(self): return env("SMTP_USER")
    @property
    def password(self): return env("SMTP_PASSWORD")
    @property
    def sender(self): return env("SMTP_FROM", env("SMTP_USER"))
    @property
    def live(self): return bool(self.host and self.sender)


SMTP = SmtpConfig()
