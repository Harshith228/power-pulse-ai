"""Per-user electricity datasets: persistence, detection cache and the dataset API.

The ML pipeline (engine/) is unchanged. A dataset's cleaned hourly frame is stored gzip-compressed in SQLite,
daily totals go to electricity_daily (used by limits, the household dashboard and monthly reports), and the
expensive detection result is cached in memory and recomputed on demand after a restart.
"""
import gzip
import hashlib
import hmac
import io
import json
import logging
import pickle  # noqa: S403 - only for our own HMAC-signed cache files
import secrets
import threading
import uuid
from collections import OrderedDict

import pandas as pd
from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel

from . import anomaly_state, config, db, user_settings
from .auth import current_user
from .config import ROOT
from .engine import advisor, pipeline, synthetic
from .engine.loader import CIRCUIT_LABELS, MAX_BYTES, DataError, parse_csv
from .report import events_csv, events_html

log = logging.getLogger("powerpulse.electricity")
router = APIRouter(prefix="/api", tags=["electricity"])
UCI_FILE = ROOT / "data" / "uci_household_hourly.csv"
SAMPLES_DIR = ROOT / "data" / "samples"
SAMPLES = {  # published sample files (whitelist - names map to files, never to arbitrary paths)
    "sample_meter_export.csv": ("Messy 15-minute meter export", "electricity", "Gaps, a negative glitch, duplicates and an impossible value - shows the cleaning step."),
    "labelled_mixed_scenario.csv": ("Labelled synthetic household", "electricity", "Hourly data with injected anomalies and ground truth."),
    "edge_incomplete_data.csv": ("Edge case: incomplete data", "electricity", "Bad timestamps, N/A, a negative value, a duplicate and a 12-hour gap."),
    "edge_insufficient_data.csv": ("Edge case: too few readings", "electricity", "About one day of data - shows the 'not enough data' state."),
    "edge_constant_readings.csv": ("Edge case: constant readings", "electricity", "Every reading is identical - accepted with a warning."),
    "edge_invalid_columns.csv": ("Edge case: wrong columns", "electricity", "No timestamp or consumption column - rejected with a hint."),
    "water_daily_sample.csv": ("Water: 60 days of daily totals", "water", "Litres per day with a one-day spike and a week-long rise."),
}
MAX_DATASETS_PER_USER = 10
CACHE_SIZE = 6

_cache: "OrderedDict[str, dict]" = OrderedDict()  # dataset id -> {"df", "det"}
_cache_lock = threading.Lock()
_uci: dict = {}
_uci_lock = threading.Lock()


class ScenarioRequest(BaseModel):
    scenario: str = "mixed"
    base: str = "synthetic"  # synthetic | uci
    seed: int = 7


# ---------------- frame (de)serialisation ----------------
def _pack(df: pd.DataFrame) -> bytes:
    buf = io.StringIO()
    df.to_csv(buf, index_label="timestamp")
    return gzip.compress(buf.getvalue().encode(), compresslevel=6)


def _unpack(blob: bytes) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(gzip.decompress(blob)), index_col=0, parse_dates=True)
    df.index.name = None
    if "injected" in df.columns:
        df["injected"] = df["injected"].astype(bool)
    return df


def _uci_frame():
    with _uci_lock:
        if "df" not in _uci:
            if not UCI_FILE.exists():
                raise HTTPException(404, "UCI dataset not prepared. Run: python scripts/fetch_uci.py")
            _uci["df"], _uci["report"] = parse_csv(UCI_FILE.read_bytes(), UCI_FILE.name)
        return _uci["df"].copy(), dict(_uci["report"])


# ---------------- detection cache ----------------
# Detection is the expensive step (~10 s for the 4-year UCI home). Results are keyed by the *content* of the cleaned
# frame plus the detection config, so identical datasets (every user who loads UCI) share one computation, and they
# are persisted to disk (HMAC-signed) so a server restart doesn't make the next page load recompute.
_content_hash: dict[str, str] = {}   # dataset id -> sha256 of the cleaned frame
_stored_key: dict[str, str] = {}     # dataset id -> cache key its stored anomaly rows were produced with
DISK_CACHE_FILES = 30


def frame_hash(df: pd.DataFrame) -> str:
    return hashlib.sha256(df.to_csv(index_label="timestamp").encode()).hexdigest()


def _key(content_hash, cfg):
    return content_hash + "|" + json.dumps(cfg or {}, sort_keys=True)


def _cache_dir():
    d = config.db_path().parent / "cache" / "detections"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_secret():
    p = _cache_dir() / ".key"
    if not p.exists():
        p.write_bytes(secrets.token_bytes(32))
    return p.read_bytes()


def _disk_load(key):
    """Signed pickle written by this server; anything unsigned or tampered with is ignored and recomputed."""
    p = _cache_dir() / (hashlib.sha256(key.encode()).hexdigest() + ".pkl")
    try:
        blob = p.read_bytes()
    except OSError:
        return None
    sig, payload = blob[:32], blob[32:]
    if not hmac.compare_digest(sig, hmac.new(_cache_secret(), payload, hashlib.sha256).digest()):
        log.warning("ignoring detection cache file with a bad signature: %s", p.name)
        return None
    try:
        return pickle.loads(payload)  # noqa: S301 - integrity verified with our HMAC key above
    except Exception:  # noqa: BLE001 - a corrupt cache file must never break the request
        log.warning("ignoring unreadable detection cache file %s", p.name)
        return None


def _disk_save(key, det):
    try:
        payload = pickle.dumps(det, protocol=pickle.HIGHEST_PROTOCOL)
        d = _cache_dir()
        tmp = d / (hashlib.sha256(key.encode()).hexdigest() + ".tmp")
        tmp.write_bytes(hmac.new(_cache_secret(), payload, hashlib.sha256).digest() + payload)
        tmp.replace(d / (hashlib.sha256(key.encode()).hexdigest() + ".pkl"))
        files = sorted(d.glob("*.pkl"), key=lambda f: f.stat().st_mtime)
        for f in files[:-DISK_CACHE_FILES]:
            f.unlink(missing_ok=True)
    except OSError as e:  # caching is an optimisation; never fail the request because of it
        log.warning("could not write detection cache: %s", e)


def _frame_of(ds_id):
    with db.connect() as conn:
        r = conn.execute("SELECT frame FROM datasets WHERE id = ?", (ds_id,)).fetchone()
    if not r:
        raise HTTPException(404, "Dataset not found.")
    return _unpack(r["frame"])


def _hash_of(ds_id, df=None):
    if ds_id not in _content_hash:
        _content_hash[ds_id] = frame_hash(df if df is not None else _frame_of(ds_id))
    return _content_hash[ds_id]


def _cached(ds_id, df=None, cfg=None):
    """Detection result for a dataset under a detection config: memory, then disk, then compute."""
    key = _key(_hash_of(ds_id, df), cfg)
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return {**_cache[key], "key": key}
    det = _disk_load(key)
    if det is None:
        det = pipeline.run_detection(df if df is not None else _frame_of(ds_id), cfg)
        _disk_save(key, det)
    entry = {"det": det, "results": {}}
    with _cache_lock:
        _cache[key] = entry
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return {**entry, "key": key}


def _evict(ds_id):
    _content_hash.pop(ds_id, None)
    _stored_key.pop(ds_id, None)


def forget_user(user_id):
    """Called after account deletion; dataset rows are already gone. Shared results stay (they hold no user data)."""
    return None


# ---------------- data access helpers (always scoped by user) ----------------
def _owned(conn, user_id, ds_id):
    r = conn.execute("SELECT * FROM datasets WHERE id = ? AND user_id = ?", (ds_id, user_id)).fetchone()
    if not r:
        raise HTTPException(404, "Dataset not found.")  # same answer for "missing" and "someone else's"
    return db.row(r)


def active_dataset(conn, user_id):
    return db.row(conn.execute("SELECT * FROM datasets WHERE user_id = ? AND is_active = 1", (user_id,)).fetchone())


def daily_series(conn, user_id):
    """(Series of daily kWh, active dataset row or None).

    One figure per day from every source: the active dataset's days, plus manually entered readings for days the
    dataset doesn't cover (see electricity_manual for the rule). attrs: "hours" covered and "sources" per day.
    """
    from . import electricity_manual
    ds = active_dataset(conn, user_id)
    rows = conn.execute("SELECT day, kwh, hours FROM electricity_daily WHERE dataset_id = ? ORDER BY day", (ds["id"],)).fetchall() if ds else []
    manual, manual_hours = electricity_manual.manual_daily(conn, user_id)
    s = electricity_manual.combine({r["day"]: r["kwh"] for r in rows}, {r["day"]: r["hours"] for r in rows}, manual, manual_hours)
    return s, ds


def analysis(conn, user_id, ds=None):
    """Full pipeline result for the user's active (or given) dataset, or None if there is none."""
    ds = ds or active_dataset(conn, user_id)
    if not ds:
        return None
    s = user_settings.get(conn, user_id)
    entry = _cached(ds["id"], cfg=s["detection"])
    if _stored_key.get(ds["id"]) != entry["key"]:
        # stored anomaly rows drive notifications and reports: keep them produced by the same config the UI shows
        with db.transaction(conn):
            _store_anomalies(conn, user_id, ds["id"], entry["det"]["events"])
        _stored_key[ds["id"]] = entry["key"]
    tariff = s["electricity"]["tariff"]
    tkey = json.dumps(tariff, sort_keys=True)
    base = entry["results"].get(tkey)
    if base is None:  # building the JSON for 35k hours takes ~1 s; reuse it per tariff
        base = pipeline.build_result({}, entry["det"], tariff)
        entry["results"][tkey] = base
        while len(entry["results"]) > 4:
            entry["results"].pop(next(iter(entry["results"])))
    res = {**base, "dataset": {**db.loads(ds["meta"], {}), "id": ds["id"]}}
    done = s["checklists"].get(ds["id"], {})
    res["recommendations"] = [{**r, "done": [i for i in done.get(r["key"], []) if i < len(r.get("steps", []))]}
                              for r in base["recommendations"]]
    return res


def _store_anomalies(conn, user_id, ds_id, events):
    conn.execute("DELETE FROM anomalies WHERE user_id = ? AND utility = 'electricity' AND dataset_id = ?", (user_id, ds_id))
    conn.executemany(
        "INSERT OR IGNORE INTO anomalies (user_id, utility, dataset_id, event_key, type, severity, start_ts, end_ts, title, data, detected_at) "
        "VALUES (?, 'electricity', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(user_id, ds_id, f"{ds_id}:{e['type']}:{e['start']}", e["type"], e["severity"], e["start"], e["end"], e["title"],
          db.dumps({"excess_kwh": e["excess_kwh"], "peak_time": e.get("peak_time"), "origin": e.get("origin")}), db.now())
         for e in events])
    anomaly_state.remember(conn, user_id, "electricity", [f"{ds_id}:{e['type']}:{e['start']}" for e in events])


def _create(user_id, df, meta):
    with db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) FROM datasets WHERE user_id = ?", (user_id,)).fetchone()[0]
        if n >= MAX_DATASETS_PER_USER:
            raise HTTPException(409, f"You can keep up to {MAX_DATASETS_PER_USER} electricity datasets. Delete one in Dataset Management first.")
    ds_id = uuid.uuid4().hex[:12]
    with db.connect() as conn:
        cfg = user_settings.get(conn, user_id)["detection"]
    entry = _cached(ds_id, df, cfg)  # run detection before writing, so a failure leaves nothing behind
    daily = df["kwh"].resample("D").agg(["sum", "count"])
    meta = {**meta, "id": ds_id}
    with db.connect() as conn:
        with db.transaction(conn):
            conn.execute("UPDATE datasets SET is_active = 0 WHERE user_id = ?", (user_id,))
            conn.execute("INSERT INTO datasets (id, user_id, name, source, meta, frame, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
                         (ds_id, user_id, meta["name"][:200], meta["source"], db.dumps(meta), _pack(df), db.now()))
            conn.executemany("INSERT INTO electricity_daily VALUES (?, ?, ?, ?)",
                             [(ds_id, d.strftime("%Y-%m-%d"), round(float(r["sum"]), 4), int(r["count"]))
                              for d, r in daily.iterrows() if r["count"] > 0])
            _store_anomalies(conn, user_id, ds_id, entry["det"]["events"])
        _stored_key[ds_id] = entry["key"]
        _after_change(conn, user_id)
        return analysis(conn, user_id, _owned(conn, user_id, ds_id))


def _after_change(conn, user_id):
    """Which dataset is active decides which manual readings count, so manual-data checks re-run with it."""
    from . import electricity_manual, notify  # local import: both depend on this module
    if conn.execute("SELECT 1 FROM electricity_readings WHERE user_id = ? LIMIT 1", (user_id,)).fetchone():
        electricity_manual.refresh(conn, user_id)  # also evaluates notifications
    else:
        notify.evaluate_user(conn, user_id)


# ---------------- routes ----------------
@router.get("/sources")
def sources():
    return {"uci_available": UCI_FILE.exists(), "scenarios": synthetic.SCENARIOS, "default_tariff": advisor.DEFAULT_TARIFF}


@router.get("/samples")
def list_samples():
    return [{"name": n, "title": t, "utility": u, "description": d, "available": (SAMPLES_DIR / n).exists()} for n, (t, u, d) in SAMPLES.items()]


@router.get("/samples/{name}")
def get_sample(name: str):
    if name not in SAMPLES or not (SAMPLES_DIR / name).exists():
        raise HTTPException(404, "Unknown sample file.")
    return Response((SAMPLES_DIR / name).read_bytes(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/datasets/validate")
async def validate(file: UploadFile = File(...), user=Depends(current_user)):
    """Check a file without analysing or saving it: cleaning report, row-level issues and a preview."""
    content = await file.read(MAX_BYTES + 1)
    try:
        _, report = parse_csv(content, file.filename or "upload.csv")
        return {"ok": True, "report": report}
    except DataError as e:
        return {"ok": False, "error": str(e), "issues": e.details.get("issues", []), "issue_counts": e.details.get("issue_counts", {}),
                "columns": e.details.get("columns", []), "preview": e.details.get("preview", [])}


@router.get("/datasets")
def list_datasets(user=Depends(current_user)):
    with db.connect() as conn:
        rows = conn.execute("SELECT id, name, source, meta, created_at, is_active FROM datasets WHERE user_id = ? ORDER BY created_at DESC",
                            (user["id"],)).fetchall()
    out = []
    for r in rows:
        m = db.loads(r["meta"], {})
        out.append({"id": r["id"], "name": r["name"], "source": r["source"], "created_at": r["created_at"], "active": bool(r["is_active"]),
                    "start": m.get("start"), "end": m.get("end"), "days": m.get("days"), "rows_hourly": m.get("rows_hourly"),
                    "has_ground_truth": bool(m.get("has_ground_truth"))})
    return out


@router.get("/datasets/active")
def get_active(user=Depends(current_user)):
    with db.connect() as conn:
        res = analysis(conn, user["id"])
    if res is None:
        raise HTTPException(404, "No electricity dataset yet.")
    return res


@router.post("/datasets/upload")
async def upload(file: UploadFile = File(...), user=Depends(current_user)):
    if not (file.filename or "").lower().endswith((".csv", ".txt")):
        raise HTTPException(422, "Please upload a .csv file.")
    content = await file.read(MAX_BYTES + 1)
    df, report = parse_csv(content, file.filename or "upload.csv")
    return _create(user["id"], df, {"name": file.filename, "source": "upload", **report})


@router.post("/datasets/uci")
def load_uci(user=Depends(current_user)):
    df, report = _uci_frame()
    return _create(user["id"], df, {"name": "UCI Individual Household Electric Power Consumption", "source": "public",
                                    "citation": "Hebrail & Berard, UCI ML Repository (2012), CC BY 4.0 - one home near Paris", **report})


@router.post("/datasets/scenario")
def scenario(req: ScenarioRequest, user=Depends(current_user)):
    if req.scenario not in synthetic.SCENARIOS:
        raise HTTPException(422, f"Unknown scenario. Choose one of: {', '.join(synthetic.SCENARIOS)}")
    if req.base == "uci":
        base, _ = _uci_frame()
        base = base.iloc[-120 * 24:].copy()  # last 120 days of the real home
        name = f"UCI real home + injected: {req.scenario}"
    else:
        base = synthetic.generate_household(seed=req.seed)
        name = f"Synthetic household: {req.scenario}"
    df = synthetic.inject(base, req.scenario, seed=req.seed)
    meta = {
        "name": name, "source": "scenario", "scenario": req.scenario, "base": req.base,
        "description": synthetic.SCENARIOS[req.scenario], "start": df.index.min().isoformat(),
        "end": df.index.max().isoformat(), "days": round(len(df) / 24, 1), "rows_hourly": len(df),
        "circuits": [c.removeprefix("circuit:") for c in df.columns if c.startswith("circuit:")],
        "has_ground_truth": True,
    }
    return _create(user["id"], df, meta)


@router.get("/datasets/{ds_id}")
def get_result(ds_id: str, user=Depends(current_user)):
    with db.connect() as conn:
        return analysis(conn, user["id"], _owned(conn, user["id"], ds_id))


@router.post("/datasets/{ds_id}/activate")
def activate(ds_id: str, user=Depends(current_user)):
    with db.connect() as conn:
        _owned(conn, user["id"], ds_id)
        with db.transaction(conn):
            conn.execute("UPDATE datasets SET is_active = (id = ?) WHERE user_id = ?", (ds_id, user["id"]))
        _after_change(conn, user["id"])
        return analysis(conn, user["id"])


@router.delete("/datasets/{ds_id}")
def delete(ds_id: str, user=Depends(current_user)):
    with db.connect() as conn:
        ds = _owned(conn, user["id"], ds_id)
        with db.transaction(conn):
            conn.execute("DELETE FROM anomalies WHERE user_id = ? AND dataset_id = ?", (user["id"], ds_id))
            conn.execute("DELETE FROM datasets WHERE id = ? AND user_id = ?", (ds_id, user["id"]))
            if ds["is_active"]:  # promote the newest remaining dataset
                conn.execute("UPDATE datasets SET is_active = 1 WHERE id = (SELECT id FROM datasets WHERE user_id = ? "
                             "ORDER BY created_at DESC LIMIT 1)", (user["id"],))
        _after_change(conn, user["id"])
    _evict(ds_id)
    return {"ok": True}


@router.put("/datasets/{ds_id}/tariff")
def set_tariff(ds_id: str, tariff: dict = Body(...), user=Depends(current_user)):
    """Kept for compatibility: the tariff is a user setting, applied to every electricity dataset."""
    try:
        clean = advisor.validate_tariff(tariff)
    except (ValueError, TypeError) as e:
        raise HTTPException(422, str(e)) from e
    with db.connect() as conn:
        ds = _owned(conn, user["id"], ds_id)
        s = user_settings.get(conn, user["id"])
        s["electricity"]["tariff"] = clean
        user_settings.save(conn, user["id"], s)
        return analysis(conn, user["id"], ds)


@router.get("/datasets/{ds_id}/report.csv")
def report_csv(ds_id: str, user=Depends(current_user)):
    res = get_result(ds_id, user)
    return Response(events_csv(res), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="powerpulse-anomalies-{ds_id}.csv"'})


@router.get("/datasets/{ds_id}/report.html", response_class=HTMLResponse)
def report_html(ds_id: str, download: bool = False, user=Depends(current_user)):
    headers = {"Content-Disposition": f'attachment; filename="powerpulse-report-{ds_id}.html"'} if download else {}
    return HTMLResponse(events_html(get_result(ds_id, user)), headers=headers)


@router.get("/datasets/{ds_id}/data.csv")
def export_data(ds_id: str, user=Depends(current_user)):
    """Cleaned hourly data (with injected labels for scenarios) - can be re-uploaded."""
    with db.connect() as conn:
        _owned(conn, user["id"], ds_id)
    df = _frame_of(ds_id)  # the cleaned frame as stored
    keys = {label: key for key, label in CIRCUIT_LABELS.items()}
    df.columns = [f"circuit_{keys.get(c[8:], c[8:].lower().replace(' ', '_'))}_kwh"
                  if c.startswith("circuit:") else c for c in df.columns]
    df.index.name = "timestamp"
    return Response(df.round(4).to_csv(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="powerpulse-data-{ds_id}.csv"'})
