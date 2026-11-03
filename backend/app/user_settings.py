"""Per-user settings (JSON document with defaults) and daily consumption limits."""
import copy

from . import db
from .engine import advisor, detector

NOTIFICATION_KINDS = {
    # kind: (category, label)
    "elec_limit_warning": ("electricity", "Electricity limit warning"),
    "elec_limit_reached": ("electricity", "Electricity limit reached"),
    "elec_anomaly": ("electricity", "Unusual electricity consumption"),
    "water_limit_warning": ("water", "Water limit warning"),
    "water_limit_reached": ("water", "Water limit reached"),
    "water_anomaly": ("water", "Unusual water consumption"),
    "report_electricity": ("report", "Monthly energy report"),
    "report_water": ("report", "Monthly water usage report"),
    "report_combined": ("report", "Monthly household utility report"),
}
SEVERITY_ORDER = ["low", "medium", "high", "critical"]

DEFAULT_WATER_TARIFF = {
    "name": "Sample municipal water tariff (per kL)",
    "fixed_monthly": 50.0,
    "slabs": [{"upto": 10, "rate": 7.0}, {"upto": 25, "rate": 12.0}, {"upto": None, "rate": 25.0}],
}

DEFAULTS = {
    "electricity": {"warn_pct": 80, "notify_limits": True, "tariff": advisor.DEFAULT_TARIFF},
    "water": {"warn_pct": 80, "notify_limits": True, "unit": "L", "tariff": DEFAULT_WATER_TARIFF},
    "anomaly_min_severity": "high",
    "notifications": {k: {"in_app": True} for k in NOTIFICATION_KINDS},
    "reports": {"enabled": True, "day": 1, "include_electricity": True, "include_water": True, "pdf": True},
    "detection": detector.DEFAULT_CONFIG,
    "checklists": {},   # {dataset_id | "water": {recommendation_key: [done step indexes]}}
    "appearance": {"theme": "system"},
}


def _merge(base, over):
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict) and k not in ("tariff", "checklists"):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def get(conn, user_id):
    r = conn.execute("SELECT data FROM user_settings WHERE user_id = ?", (user_id,)).fetchone()
    s = _merge(DEFAULTS, db.loads(r["data"], {}) if r else {})
    # settings saved before WhatsApp was removed may still carry its keys
    s.pop("whatsapp", None)
    s["reports"].pop("whatsapp", None)
    for prefs in s["notifications"].values():
        prefs.pop("whatsapp", None)
    return s


def save(conn, user_id, data):
    conn.execute("INSERT INTO user_settings (user_id, data) VALUES (?, ?) "
                 "ON CONFLICT(user_id) DO UPDATE SET data = excluded.data", (user_id, db.dumps(data)))


def _pct(v, name):
    try:
        v = int(v)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a whole number.") from None
    if not 10 <= v <= 99:
        raise ValueError(f"{name} must be between 10 and 99%.")
    return v


def apply_patch(current, patch):
    """Validate a partial settings update and return the new full settings. Raises ValueError."""
    s = copy.deepcopy(current)
    patch = patch or {}
    for util in ("electricity", "water"):
        p = patch.get(util)
        if not p:
            continue
        if "warn_pct" in p:
            s[util]["warn_pct"] = _pct(p["warn_pct"], "Warning threshold")
        if "notify_limits" in p:
            s[util]["notify_limits"] = bool(p["notify_limits"])
        if "tariff" in p:
            unit = "kWh" if util == "electricity" else "kL"
            s[util]["tariff"] = advisor.validate_tariff(p["tariff"], unit=unit)
        if util == "water" and "unit" in p:
            if p["unit"] not in ("L", "kL"):
                raise ValueError("Water unit must be L or kL.")
            s["water"]["unit"] = p["unit"]
    if "anomaly_min_severity" in patch:
        if patch["anomaly_min_severity"] not in SEVERITY_ORDER:
            raise ValueError("Unknown severity.")
        s["anomaly_min_severity"] = patch["anomaly_min_severity"]
    for kind, prefs in (patch.get("notifications") or {}).items():
        if kind not in NOTIFICATION_KINDS:
            raise ValueError(f"Unknown notification type: {kind}")
        if "in_app" in prefs:
            s["notifications"][kind]["in_app"] = bool(prefs["in_app"])
    r = patch.get("reports") or {}
    for k in ("enabled", "include_electricity", "include_water", "pdf"):
        if k in r:
            s["reports"][k] = bool(r[k])
    if "day" in r:
        try:
            day = int(r["day"])
        except (TypeError, ValueError):
            raise ValueError("Report day must be a number.") from None
        if not 1 <= day <= 28:
            raise ValueError("Report delivery day must be between 1 and 28 (so it exists in every month).")
        s["reports"]["day"] = day
    if "appearance" in patch:
        theme = (patch["appearance"] or {}).get("theme")
        if theme not in ("light", "dark", "system"):
            raise ValueError("Theme must be light, dark or system.")
        s["appearance"]["theme"] = theme
    if "detection" in patch:
        s["detection"] = detector.validate_config({**s["detection"], **(patch["detection"] or {})})
    if patch.get("reset_detection"):
        s["detection"] = dict(detector.DEFAULT_CONFIG)
    if not (s["reports"]["include_electricity"] or s["reports"]["include_water"]):
        raise ValueError("A monthly report must include electricity, water or both.")
    return s


# ---------------- daily limits ----------------
UNITS = {"electricity": "kWh", "water": "L"}
MAX_LIMIT = {"electricity": 500.0, "water": 50000.0}


def limits(conn, user_id):
    out = {u: {"default": None, "weekdays": {}} for u in UNITS}
    for r in conn.execute("SELECT utility, weekday, limit_value FROM daily_limits WHERE user_id = ?", (user_id,)):
        if r["weekday"] == -1:
            out[r["utility"]]["default"] = r["limit_value"]
        else:
            out[r["utility"]]["weekdays"][r["weekday"]] = r["limit_value"]
    return out


def _limit_value(v, utility):
    if v in (None, ""):
        return None
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise ValueError("Limit must be a number.") from None
    if not 0 < v <= MAX_LIMIT[utility]:
        raise ValueError(f"{utility.title()} limit must be above 0 and at most {MAX_LIMIT[utility]:g} {UNITS[utility]} a day.")
    return round(v, 3)


def set_limits(conn, user_id, utility, default, weekdays):
    """Replace one utility's limits. default None removes the limit; weekdays maps 0..6 -> value or None."""
    if utility not in UNITS:
        raise ValueError("Unknown utility.")
    default = _limit_value(default, utility)
    clean = {}
    for k, v in (weekdays or {}).items():
        wd = int(k)
        if not 0 <= wd <= 6:
            raise ValueError("Weekday must be 0 (Monday) to 6 (Sunday).")
        val = _limit_value(v, utility)
        if val is not None:
            clean[wd] = val
    with db.transaction(conn):
        conn.execute("DELETE FROM daily_limits WHERE user_id = ? AND utility = ?", (user_id, utility))
        if default is not None:
            conn.execute("INSERT INTO daily_limits VALUES (?, ?, -1, ?)", (user_id, utility, default))
        for wd, val in clean.items():
            conn.execute("INSERT INTO daily_limits VALUES (?, ?, ?, ?)", (user_id, utility, wd, val))
