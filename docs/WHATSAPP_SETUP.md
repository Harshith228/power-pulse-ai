# WhatsApp integration - status

**Status: removed. Not part of this release.**

An earlier development build of PowerPulse AI sent limit, anomaly and report alerts over WhatsApp. At the project owner's request the feature was removed completely before this release:

- no WhatsApp code, settings, screens, buttons or text remain in the application;
- no WhatsApp provider account, access token, phone number ID, message templates or webhook is needed - **do not add any WhatsApp credentials to `.env`**;
- notifications are delivered **in-app** (notification centre, sidebar badges) and password-reset links by **email** (SMTP) or the server log.

## What remains, and why

| Item | Status |
|---|---|
| `users.whatsapp_*` columns | Legacy, unused. Kept so databases created by earlier builds upgrade without dropping stored data |
| `deliveries`, `whatsapp_verifications` tables | Legacy, unused, for the same reason |
| Old WhatsApp-era notifications in existing databases | Hidden from the notification centre |
| Settings keys from earlier builds | Dropped automatically when settings are read |

See [DATABASE.md](DATABASE.md). A future migration may drop the legacy columns and tables once no older databases need upgrading.

## If WhatsApp is reintroduced later

This would be new development, not configuration. It would need at least:

1. A provider - e.g. the WhatsApp Business Platform (Meta Cloud API) or a business solution provider - with a verified business, a sender phone number and approved message templates for each alert type.
2. Server-side credentials supplied only through environment variables (never committed), plus a webhook endpoint with signature verification for delivery status and opt-outs.
3. Explicit user opt-in with phone verification, per-category preferences, and a test mode that never messages real numbers during automated tests.
4. A delivery queue with retries; the legacy `deliveries` table schema could be reused.

None of this exists in the current code.
