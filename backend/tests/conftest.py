import os
import tempfile
import uuid
from pathlib import Path

# Must run before the app is imported: isolated database, no background worker.
_TMP = Path(tempfile.mkdtemp(prefix="powerpulse-tests-"))
os.environ["POWERPULSE_DB"] = str(_TMP / "test.db")
os.environ["POWERPULSE_SCHEDULER"] = "0"
# every test client shares one IP; the limiters themselves are tested in test_production.py
os.environ["POWERPULSE_REGISTER_LIMIT_PER_IP"] = "100000"
os.environ["POWERPULSE_LOGIN_LIMIT_PER_IP"] = "100000"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

PASSWORD = "Sunlight42"


def make_client(name="Test User", email=None, password=PASSWORD):
    c = TestClient(app, headers={"X-Requested-With": "PowerPulse"})
    email = email or f"{uuid.uuid4().hex[:10]}@example.com"
    r = c.post("/api/auth/register", json={"name": name, "email": email, "password": password})
    assert r.status_code == 201, r.text
    c.email = email
    return c


@pytest.fixture
def client():
    return make_client()


@pytest.fixture
def client_factory():
    return make_client
