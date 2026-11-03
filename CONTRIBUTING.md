# Contributing to PowerPulse AI

Thanks for helping improve PowerPulse AI. This guide covers setup, conventions and what a pull request needs.

## Setup

```bash
git clone https://github.com/Harshith228/power-pulse-ai.git
cd power-pulse-ai
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt ruff mypy
.venv/bin/python run.py            # http://127.0.0.1:8000
```

Node.js 22+ and Chrome/Edge are needed only for the end-to-end tests.

## Workflow

1. Create a branch from `main`: `feature/<short-name>` or `fix/<short-name>`.
2. Keep each pull request focused on one change.
3. Run the checks below before pushing; CI runs the same ones.
4. Open a pull request using the template and describe how you tested it.

## Checks

```bash
ruff check backend
cd backend && ../.venv/bin/python -m mypy app --ignore-missing-imports && ../.venv/bin/python -m pytest -q && cd ..
npx oxlint@1.90.0 frontend/js e2e
node e2e/run.mjs        # for UI changes
```

## Conventions

- **Backend:** FastAPI routers in `backend/app/`, ML in `backend/app/engine/`. Every query must filter by `user_id`; another user's resource returns 404. State-changing endpoints rely on the `X-Requested-With: PowerPulse` CSRF header.
- **Database:** never edit an existing migration. Add a new script to the end of `MIGRATIONS` in `backend/app/db.py`; migrations must not drop user data. Add a test.
- **Frontend:** plain ES modules, no build step, no inline scripts or styles (the Content-Security-Policy forbids inline scripts). Use the design tokens in `css/base.css` and check light and dark themes and widths down to 360 px.
- **Data honesty:** never invent readings or figures; when data is missing, say so in the UI.
- **Tests:** add or update tests with every behaviour change. Tests must use temporary databases and must not send email or contact external services.
- **Style:** match the surrounding code; ruff settings are in `backend/ruff.toml`.

## Secrets and data

Never commit `.env`, credentials, tokens, databases (`*.db`), logs, or real household data. `.gitignore` covers the usual paths - check `git status` before committing. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
