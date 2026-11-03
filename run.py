"""Start PowerPulse: python run.py  ->  http://127.0.0.1:8000 (dashboard at /dashboard)

Host, port and trusted proxies come from the environment / .env (see .env.example and docs/DEPLOYMENT.md).
Always one process: sessions live in SQLite, but the rate limiters, detection cache and the background worker
(monthly-report scheduler) are in-process, so several workers would each run their own copy.
"""
import sys
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).parent / "backend"))

from app import config  # noqa: E402  - loads .env before reading the settings below

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=config.env("POWERPULSE_HOST", "127.0.0.1"),
        port=int(config.env("POWERPULSE_PORT", "8000")),
        workers=1,
        # Behind a reverse proxy, trust its X-Forwarded-For / -Proto so rate limits see the real client IP.
        proxy_headers=True,
        forwarded_allow_ips=config.env("POWERPULSE_TRUSTED_PROXIES", "127.0.0.1"),
        server_header=False,
    )
