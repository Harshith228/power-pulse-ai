"""Regression tests for the production-readiness audit: security hardening, caching, migrations, operations."""
import sqlite3
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app import auth, config, db, electricity, household, security, worker
from app.main import app
from conftest import PASSWORD, make_client


def anon():
    return TestClient(app, headers={"X-Requested-With": "PowerPulse"})


# ---------------- rate limiting ----------------
def test_register_is_rate_limited_per_ip(monkeypatch):
    monkeypatch.setattr(auth, "register_limiter", security.RateLimiter(limit=2, window_s=3600))
    c = anon()
    codes = [c.post("/api/auth/register", json={"name": "X", "email": f"rl{i}@example.com", "password": PASSWORD}).status_code for i in range(3)]
    assert codes == [201, 201, 429]


def test_login_is_rate_limited_per_ip_across_emails(monkeypatch):
    monkeypatch.setattr(auth, "login_ip_limiter", security.RateLimiter(limit=3, window_s=900))
    c = anon()
    codes = [c.post("/api/auth/login", json={"email": f"nobody{i}@example.com", "password": "Wrong1234"}).status_code for i in range(4)]
    assert codes == [401, 401, 401, 429]  # spraying different accounts from one IP is blocked


def test_current_password_checks_are_rate_limited(monkeypatch):
    monkeypatch.setattr(auth, "password_check_limiter", security.RateLimiter(limit=3, window_s=900))
    c = make_client()
    codes = [c.post("/api/auth/password", json={"current_password": "Nope12345", "new_password": "Another123"}).status_code for _ in range(4)]
    assert codes == [400, 400, 400, 429]
    assert c.post("/api/auth/delete-account", json={"password": PASSWORD}).status_code == 429  # same budget


# ---------------- headers, compression, errors ----------------
def test_security_headers_and_csp():
    c = anon()
    for path in ("/", "/login", "/api/health"):
        h = c.get(path).headers
        assert h["x-content-type-options"] == "nosniff" and h["x-frame-options"] == "DENY"
        assert "script-src 'self'" in h["content-security-policy"] and "unsafe-eval" not in h["content-security-policy"]
        assert "frame-ancestors 'none'" in h["content-security-policy"] and "camera=()" in h["permissions-policy"]
    assert "strict-transport-security" not in c.get("/").headers  # plain http locally


def test_hsts_on_https(monkeypatch):
    monkeypatch.setattr(config, "SECURE_COOKIES", True)
    assert anon().get("/").headers["strict-transport-security"].startswith("max-age=31536000")


def test_no_inline_scripts_so_csp_can_forbid_them():
    import re
    for page in ("index.html", "auth.html", "dashboard.html"):
        html = (config.ROOT / "frontend" / page).read_text(encoding="utf-8")
        assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html), page
        assert not re.search(r"\son[a-z]+=", html), page


def test_large_json_is_gzipped(client):
    client.post("/api/datasets/scenario", json={"scenario": "spike"})
    r = client.get("/api/datasets/active", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip"


def test_unexpected_errors_do_not_leak_internals(monkeypatch):
    c = make_client()
    raw = TestClient(app, raise_server_exceptions=False)
    raw.cookies = c.cookies

    def boom(*a, **k):
        raise RuntimeError("secret internal detail /etc/passwd")
    monkeypatch.setattr(household, "_utility", boom)
    r = raw.get("/api/household/summary")
    assert r.status_code == 500 and "reference" in r.json()["detail"]
    assert "secret internal" not in r.text and "Traceback" not in r.text


# ---------------- operations ----------------
def test_health_reports_database_and_fails_closed(monkeypatch):
    r = anon().get("/api/health").json()
    assert r["ok"] and r["database"].startswith("ok (schema v") and r["worker"] == "disabled"

    def broken():
        raise sqlite3.OperationalError("disk I/O error")
    monkeypatch.setattr(db, "connect", broken)
    r = anon().get("/api/health")
    assert r.status_code == 503 and r.json()["database"] == "error"


def test_cleanup_purges_expired_sessions_and_used_reset_tokens():
    c = make_client()
    uid = c.get("/api/auth/me").json()["id"]
    with db.connect() as conn:
        conn.execute("INSERT INTO sessions VALUES ('expired-x', ?, '2020-01-01', '2020-01-02', 'old')", (uid,))
        conn.execute("INSERT INTO password_resets VALUES ('used-x', ?, '2020-01-01', '2999-01-01', '2020-01-01')", (uid,))
    s, r = worker.cleanup()
    assert s >= 1 and r >= 1
    assert c.get("/api/auth/me").status_code == 200  # live session untouched


def test_csv_export_neutralises_formulas(client):
    client.post("/api/water/readings", json={"date": (date.today() - timedelta(days=1)).isoformat(), "value": 300, "notes": "=HYPERLINK(\"http://x\")"})
    text = client.get("/api/water/export.csv").text
    assert "'=HYPERLINK" in text and ",=HYPERLINK" not in text


# ---------------- database migrations ----------------
def test_migration_from_v1_preserves_data(tmp_path):
    path = tmp_path / "v1.db"
    conn = sqlite3.connect(path)
    conn.executescript("BEGIN;" + db.MIGRATIONS[0] + "; PRAGMA user_version = 1; COMMIT;")
    conn.execute("INSERT INTO users (id, email, name, password_hash, created_at, whatsapp_number, whatsapp_verified_at, whatsapp_verified_mode) "
                 "VALUES (1, 'a@x.io', 'A', 'h', '2026-01-01', '+911234567890', '2026-01-02', 'test')")
    conn.execute("INSERT INTO users (id, email, name, password_hash, created_at, whatsapp_number, whatsapp_verified_at, whatsapp_verified_mode) "
                 "VALUES (2, 'b@x.io', 'B', 'h', '2026-01-01', '+911234567891', '2026-01-02', 'live')")
    conn.execute("INSERT INTO water_readings (user_id, ts, granularity, litres, source, created_at, updated_at) VALUES (1, '2026-01-01', 'day', 400, 'manual', 'x', 'x')")
    conn.execute("INSERT INTO deliveries (user_id, channel, status, to_number, payload, created_at, updated_at) VALUES (1, 'whatsapp', 'test_mode', '+91', '{}', 'x', 'x')")
    conn.commit()
    conn.row_factory = sqlite3.Row
    db.migrate(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(db.MIGRATIONS)
    users = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM users")}
    assert users[1]["whatsapp_verified_at"] is None          # fake test-mode verification removed
    assert users[2]["whatsapp_verified_at"] == "2026-01-02"  # real verification kept
    assert conn.execute("SELECT litres FROM water_readings").fetchone()[0] == 400
    assert conn.execute("SELECT status FROM deliveries").fetchone()[0] == "not_configured"
    idx = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    assert {"ix_anomalies_user_util_start", "ix_notifications_user_read", "ix_deliveries_user"} <= idx
    db.migrate(conn)  # idempotent
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(db.MIGRATIONS)


def test_fresh_database_has_every_table_and_foreign_keys(tmp_path):
    conn = sqlite3.connect(tmp_path / "fresh.db")
    conn.row_factory = sqlite3.Row
    db.migrate(conn)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"users", "sessions", "datasets", "water_readings", "anomalies", "notifications", "deliveries", "monthly_reports"} <= tables
    for t in ("sessions", "datasets", "water_readings", "anomalies", "notifications", "deliveries", "monthly_reports", "device_keys"):
        fks = conn.execute(f"PRAGMA foreign_key_list({t})").fetchall()
        assert any(fk["table"] == "users" and fk["on_delete"] == "CASCADE" for fk in fks), t


# ---------------- detection cache & stored anomalies ----------------
def test_identical_datasets_share_one_detection_and_survive_restart():
    a, b = make_client(), make_client()
    ra = a.post("/api/datasets/scenario", json={"scenario": "repeated", "seed": 5}).json()
    rb = b.post("/api/datasets/scenario", json={"scenario": "repeated", "seed": 5}).json()
    ha, hb = electricity._content_hash[ra["dataset"]["id"]], electricity._content_hash[rb["dataset"]["id"]]
    assert ha == hb and len(ra["events"]) == len(rb["events"])
    keys = [k for k in electricity._cache if k.startswith(ha)]
    assert len(keys) == 1                                       # one computation for both users
    assert list(electricity._cache_dir().glob("*.pkl"))         # persisted for the next restart
    electricity._cache.clear()                                  # simulate a restart
    assert len(a.get("/api/datasets/active").json()["events"]) == len(ra["events"])


def test_tampered_disk_cache_is_ignored():
    c = make_client()
    res = c.post("/api/datasets/scenario", json={"scenario": "spike", "seed": 13}).json()
    key = next(k for k in electricity._cache if k.startswith(electricity._content_hash[res["dataset"]["id"]]))
    import hashlib
    f = electricity._cache_dir() / (hashlib.sha256(key.encode()).hexdigest() + ".pkl")
    f.write_bytes(b"0" * 32 + b"not a pickle produced by us")
    electricity._cache.clear()
    assert electricity._disk_load(key) is None
    assert len(c.get("/api/datasets/active").json()["events"]) == len(res["events"])  # recomputed safely


def test_stored_anomalies_follow_each_users_detection_settings():
    a, b = make_client(), make_client()
    strict_cfg = {"detection": {"spike_z": 8.0, "if_rarity": 0.999, "min_excess_kwh": 5.0, "night_enabled": False}}
    a.post("/api/datasets/scenario", json={"scenario": "spike", "seed": 9})
    rb = b.post("/api/datasets/scenario", json={"scenario": "spike", "seed": 9}).json()
    a.patch("/api/settings", json=strict_cfg)
    a.get("/api/datasets/active")                 # warms the cache for this config
    b.patch("/api/settings", json=strict_cfg)     # b now hits that warm cache
    strict = b.get("/api/datasets/active").json()
    assert len(strict["events"]) != len(rb["events"])
    uid = b.get("/api/auth/me").json()["id"]
    with db.connect() as conn:
        stored = conn.execute("SELECT COUNT(*) FROM anomalies WHERE user_id = ? AND utility = 'electricity' AND dataset_id = ?",
                              (uid, rb["dataset"]["id"])).fetchone()[0]
    assert stored == len(strict["events"])


@pytest.mark.parametrize("path", ["/api/datasets", "/api/water/summary", "/api/household/summary", "/api/reports", "/api/notifications",
                                  "/api/settings", "/api/limits/water/history", "/api/water/export.csv"])
def test_every_data_endpoint_requires_a_session(path):
    assert TestClient(app).get(path).status_code == 401
