# Changelog

All notable changes to PowerPulse AI are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-11-03

Initial release for TECH Quest 2.0 (team CodeBlitz).

### Added
- Electricity monitoring: CSV upload with automatic cleaning and data-quality report, public UCI sample household, hourly analytics, heatmaps, peaks and insights.
- Manual electricity readings (daily or hourly) combined with imported data without double counting.
- Water monitoring: manual entries, CSV import with server-side preview and row-level validation, demo data, smart-meter ingest with per-device keys.
- Anomaly detection: robust baseline + Isolation Forest + rules for spikes, sustained increases, repeated loads and night-time increases; water spikes, sustained rises, overnight use and continuous flow. Tunable thresholds per user.
- Unread anomaly badges with read tracking that survives re-detection.
- Daily consumption limits per utility with weekday overrides and warnings.
- In-app notification centre with de-duplication.
- Cost estimation with editable slab tariffs, bill history, simulator and savings recommendations.
- Monthly reports: Electricity, Water or Combined, any month or custom range, on-screen report with separate PDF and CSV downloads; automatic monthly report on a chosen day, never duplicated.
- Accounts: registration, sign-in, password reset (SMTP or server log), sessions management, data export and account deletion.
- Light, dark and system themes; responsive layout from 360 px to 1920 px.
- Validation lab with synthetic households and labelled injected anomalies.
- Documentation, CI workflow, issue and pull-request templates.

### Removed
- WhatsApp notifications (present in pre-release builds). Legacy database columns are kept for upgrade safety; see `docs/WHATSAPP_SETUP.md`.
