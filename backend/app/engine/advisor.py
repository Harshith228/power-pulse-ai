"""INR slab-tariff costing and rule-based energy-saving recommendations."""
import pandas as pd

DAYS_PER_MONTH = 30.44
AVOIDABLE_SHARE = 0.8  # assume most anomalous excess is avoidable once the cause is fixed

DEFAULT_TARIFF = {
    "name": "Sample Indian domestic slab tariff",
    "fixed_monthly": 50.0,
    "slabs": [  # 'upto' = cumulative monthly kWh, None = everything above
        {"upto": 100, "rate": 3.00},
        {"upto": 200, "rate": 4.50},
        {"upto": 400, "rate": 6.00},
        {"upto": None, "rate": 7.50},
    ],
}


def validate_tariff(t, unit="kWh"):
    """Return a clean tariff dict or raise ValueError with a readable message. `unit` only affects messages."""
    t = t or DEFAULT_TARIFF
    slabs = t.get("slabs") or []
    if not slabs:
        raise ValueError("Tariff needs at least one slab.")
    clean, prev = [], 0
    for i, s in enumerate(slabs):
        rate = float(s.get("rate", -1))
        if rate < 0 or rate > 100:
            raise ValueError(f"Slab {i + 1}: rate must be between 0 and 100 INR/{unit}.")
        upto = s.get("upto")
        if i == len(slabs) - 1:
            upto = None
        elif upto is None or float(upto) <= prev:
            raise ValueError(f"Slab {i + 1}: 'up to' must be greater than {prev:g} {unit}.")
        else:
            upto = float(upto)
            prev = upto
        clean.append({"upto": upto, "rate": rate})
    fixed = float(t.get("fixed_monthly", 0) or 0)
    if fixed < 0:
        raise ValueError("Fixed charge cannot be negative.")
    return {"name": str(t.get("name", "Custom tariff"))[:80], "fixed_monthly": fixed, "slabs": clean}


def bill(kwh, tariff):
    """Monthly bill in INR for `kwh` units under a slab tariff (fixed charge included)."""
    total, lower = tariff["fixed_monthly"], 0.0
    for s in tariff["slabs"]:
        upper = s["upto"] if s["upto"] is not None else float("inf")
        if kwh > lower:
            total += (min(kwh, upper) - lower) * s["rate"]
        lower = upper
    return total


def marginal_rate(kwh, tariff):
    for s in tariff["slabs"]:
        upper = s["upto"] if s["upto"] is not None else float("inf")
        if kwh <= upper:
            return s["rate"]
    return tariff["slabs"][-1]["rate"]


# ---------------- recommendations ----------------

TIPS = {
    "geyser": ("Put the water heater on a timer",
               "Heat water for 15-20 minutes before use instead of leaving the geyser on, set its thermostat "
               "to 50-55 °C and insulate exposed hot-water pipes.", "flame"),
    "ac": ("Tune the air conditioner",
           "Set the AC to 24-26 °C (each degree higher saves about 6%), clean filters monthly, use sleep/timer "
           "mode at night and get the thermostat and refrigerant checked if usage keeps rising.", "snow"),
    "kitchen": ("Batch heavy kitchen appliances",
                "Oven, induction and microwave peaks were above normal. Cook in batches, use eco modes and avoid "
                "pre-heating longer than needed.", "kitchen"),
    "laundry": ("Run full laundry loads",
                "Washer / dryer use was unusually high. Run full loads on cold or eco cycles and air-dry when "
                "possible.", "laundry"),
    "pump": ("Automate the water pump",
             "A load was switching on at the same time on several nights. Fit an automatic water-level "
             "controller so the pump stops when the tank is full.", "pump"),
    "fault": ("Inspect for a faulty or new appliance",
              "Consumption stayed high for days, not hours - a typical sign of a failing fridge seal, a stuck "
              "thermostat, an AC low on refrigerant, or a newly added appliance.", "wrench"),
    "schedule": ("Check timers and scheduled loads",
                 "The same unusual load repeated at one clock-hour. Review appliance timers, inverter charging "
                 "and pump schedules for that time.", "clock"),
    "night": ("Find what runs overnight",
              "Extra energy was used late at night. Check heaters, pumps, chargers and appliances left on "
              "after bedtime.", "moon"),
    "evening": ("Spread out evening peak usage",
                "Several heavy appliances ran together in the evening. Stagger ironing, washing and water "
                "heating to keep peaks down.", "sunset"),
    "general": ("Review unusual daytime usage",
                "Daytime consumption spiked above normal. Check which appliances ran at those times.", "bolt"),
    "standby": ("Cut the always-on (standby) load",
                "Your home never drops below this load, even at 3 AM. Switch off set-top boxes, TVs, chargers "
                "and old appliances at the plug; a smart plug or switched power strip helps.", "plug"),
}


# step-by-step checklists shown on the Recommendations page (progress is saved per user and dataset)
CHECKLISTS = {
    "geyser": ["Check the geyser thermostat is set to 50-55 °C", "Fit or set a timer so it heats only before use",
               "Insulate exposed hot-water pipes", "Switch it off at the wall when not needed"],
    "ac": ["Set the AC to 24-26 °C", "Clean or replace the filters", "Use sleep / timer mode at night",
           "Book a service if usage keeps rising (refrigerant, thermostat)"],
    "kitchen": ["Batch oven / induction cooking", "Use eco modes on appliances", "Avoid long pre-heating"],
    "laundry": ["Run full loads only", "Use cold or eco cycles", "Air-dry when possible"],
    "pump": ["Check when the pump runs (look for a timer)", "Fit an automatic water-level controller",
             "Check the overhead tank for overflow"],
    "fault": ["List appliances added recently", "Check the fridge door seal and defrost", "Look for an appliance stuck on",
              "Ask an electrician to check if the rise continues"],
    "schedule": ["Review appliance and inverter timers", "Check pump / RO purifier schedules", "Note what runs at that clock-hour"],
    "night": ["Walk round at bedtime and note what is still on", "Unplug chargers and idle devices",
              "Check heaters, pumps and water heaters run only when needed"],
    "evening": ["Stagger ironing, washing and water heating", "Avoid running heavy appliances together"],
    "general": ["Check which appliances ran at the flagged times", "Switch off appliances left running"],
    "standby": ["Switch off set-top boxes and TVs at the plug", "Use a switched power strip for the entertainment unit",
                "Unplug chargers when not charging", "Consider smart plugs for always-on devices"],
}


def _cause(ev):
    label = ((ev.get("circuit") or {}).get("label") or "").lower()
    hours = ev.get("hours_of_day") or []
    if ev["type"] == "sustained":
        return "ac" if ("air" in label or "cool" in label) else "fault"
    if ev["type"] == "night":
        return "pump" if "pump" in label else "night"
    if "pump" in label:
        return "pump"
    if "water heater & air" in label:  # UCI shared circuit: decide by time of day
        return "geyser" if hours and min(hours) >= 4 and max(hours) <= 10 else "ac"
    if "water heater" in label or "geyser" in label:
        return "geyser"
    if "air" in label or "cool" in label:
        return "ac"
    if "kitchen" in label:
        return "kitchen"
    if "laundry" in label:
        return "laundry"
    if ev["type"] == "repeated":
        return "schedule"
    h = hours[0] if hours else 12
    return "night" if h <= 5 else "evening" if h >= 18 else "general"


def recommend(events, frame, tariff, days):
    s = frame["kwh"]
    typical_month = s.sum() / days * DAYS_PER_MONTH
    rate = marginal_rate(typical_month, tariff)
    per_month = DAYS_PER_MONTH / days
    recs = {}
    for ev in events:
        key = _cause(ev)
        r = recs.setdefault(key, {"key": key, "events": [], "excess_kwh": 0.0})
        r["events"].append(ev["id"])
        r["excess_kwh"] += ev["excess_kwh"]
        ev["recommendation"] = key

    out = []
    for key, r in recs.items():
        kwh_m = r["excess_kwh"] * per_month * AVOIDABLE_SHARE
        title, detail, icon = TIPS[key]
        out.append({"key": key, "title": title, "detail": detail, "icon": icon, "events": r["events"],
                    "kwh_month": round(kwh_m, 1), "inr_month": round(kwh_m * rate, 0), "basis": "anomalies",
                    "steps": CHECKLISTS[key], "assumption": f"{AVOIDABLE_SHARE:.0%} of the extra energy from linked anomalies is avoidable"})

    baseload = float(s.quantile(0.05))  # kWh per hour == average kW
    standby_kwh = baseload * 24 * DAYS_PER_MONTH
    if baseload > 0.08:
        kwh_m = standby_kwh * 0.2  # shortcut: 20% standby reduction is a generic BEE-style estimate
        title, detail, icon = TIPS["standby"]
        out.append({"key": "standby", "title": title,
                    "detail": f"Always-on load is about {baseload * 1000:.0f} W ({standby_kwh:.0f} kWh/month). " + detail,
                    "icon": icon, "events": [], "kwh_month": round(kwh_m, 1), "inr_month": round(kwh_m * rate, 0),
                    "basis": "baseload", "steps": CHECKLISTS["standby"], "assumption": "a 20% cut in the always-on load"})
    out.sort(key=lambda r: -r["inr_month"])
    for i, r in enumerate(out):
        r["priority"] = "high" if i < 2 and r["inr_month"] >= 50 else "medium" if r["inr_month"] >= 20 else "low"
    return out


def cost_summary(frame, events, tariff, days):
    s = frame["kwh"]
    month = s.index.to_period("M")
    excess_by_month = {}
    for ev in events:
        p = pd.Timestamp(ev["start"]).to_period("M")  # shortcut: whole event billed to its start month
        excess_by_month[p] = excess_by_month.get(p, 0) + ev["excess_kwh"]
    months = []
    for p, grp in s.groupby(month):
        kwh = float(grp.sum())
        hours = len(grp)
        full = hours >= 0.9 * p.days_in_month * 24
        ex = min(excess_by_month.get(p, 0.0), kwh)
        b = bill(kwh, tariff)
        months.append({"month": str(p), "kwh": round(kwh, 1), "bill": round(b, 0), "anomaly_kwh": round(ex, 1),
                       "avoidable_inr": round(b - bill(kwh - ex * AVOIDABLE_SHARE, tariff), 0), "complete": full})
    typical_month = s.sum() / days * DAYS_PER_MONTH
    total_excess = sum(ev["excess_kwh"] for ev in events)
    excess_month = total_excess / days * DAYS_PER_MONTH
    return {
        "typical_month_kwh": round(typical_month, 1),
        "typical_month_bill": round(bill(typical_month, tariff), 0),
        "effective_rate": round(bill(typical_month, tariff) / typical_month, 2) if typical_month else 0,
        "marginal_rate": marginal_rate(typical_month, tariff),
        "anomaly_kwh_total": round(total_excess, 1),
        "anomaly_kwh_month": round(excess_month, 1),
        "anomaly_inr_month": round(bill(typical_month, tariff) - bill(typical_month - excess_month * AVOIDABLE_SHARE, tariff), 0),
        "months": months,
    }
