## Summary

<!-- What does this change and why? Link the issue: Fixes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor / tooling

## How was it tested?

- [ ] `ruff check backend` and `mypy app --ignore-missing-imports`
- [ ] `python -m pytest -q` (backend)
- [ ] `npx oxlint@1.90.0 frontend/js e2e`
- [ ] `node e2e/run.mjs` (UI changes)
- [ ] Checked light and dark themes and narrow screens (UI changes)

## Checklist

- [ ] No secrets, `.env`, databases or real user data committed
- [ ] New database changes are a new migration at the end of `MIGRATIONS`, and drop no user data
- [ ] Documentation updated (README / `docs/`) where behaviour changed
- [ ] CHANGELOG.md updated for user-visible changes
