# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead: on the repository page open **Security → Report a vulnerability** (available once the repository is public and private vulnerability reporting is enabled). While the repository is private, contact the maintainers directly through GitHub. Include the affected version or commit, steps to reproduce, and the impact.

You can expect an acknowledgement within 7 days and a fix or mitigation plan once the report is confirmed. Please give us reasonable time to fix the issue before disclosing it.

## Supported versions

Only the latest commit on `main` receives security fixes.

## Security design

- Passwords hashed with scrypt; session and reset tokens stored only as SHA-256 hashes; reset tokens are single-use and expire after 30 minutes.
- Session cookies are HttpOnly and SameSite=Lax, and `Secure` when served over HTTPS.
- CSRF protection via a required custom header on every state-changing request.
- Rate limiting on sign-in, registration and password checks.
- Strict Content-Security-Policy (no inline scripts), X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy and HSTS on HTTPS.
- Every database query is scoped to the signed-in user; other users' resources return 404.
- CSV exports neutralise spreadsheet formulas; the detection cache is HMAC-signed so tampered files are ignored.
- Unexpected errors show the user only a reference code; details stay in the server log.

## Operator responsibilities

- Serve the app over **HTTPS** behind a reverse proxy and set `POWERPULSE_APP_URL=https://...`.
- Keep `.env` out of version control and readable only by the service account.
- Set `POWERPULSE_TRUSTED_PROXIES` correctly so rate limits see real client IPs.
- Set `POWERPULSE_HIDE_API_DOCS=1` in production.
- Back up `data/powerpulse.db` and keep dependencies updated (`pip-audit -r requirements.txt`).
