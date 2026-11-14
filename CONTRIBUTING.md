# Contributing to Relay

Thanks for helping improve Relay. This guide describes the safest way to work on the project.

## Before you start

- Read the [README](README.md) and [architecture overview](docs/ARCHITECTURE.md).
- Search existing issues and pull requests before opening a duplicate.
- For a security vulnerability, follow [SECURITY.md](SECURITY.md) instead of creating a public issue.
- Do not commit passwords, API keys, database URLs, private user data, build output, or local environment files.

## Development setup

Relay requires Node.js 22+, npm 10+, and a PostgreSQL database.

```bash
npm ci
cp .env.example .env
npm run dev
```

Set `DATABASE_URL`, a private `SESSION_SECRET` of at least 32 characters, and `CLIENT_ORIGIN=http://localhost:5173` in your local `.env` file. On Windows PowerShell, use `Copy-Item .env.example .env` for the copy step.

Use a disposable development database. Relay runs migrations during API startup and may seed a sample community.

## Before opening a pull request

Run:

```bash
npm test
npm run build
```

The PostgreSQL integration test is opt-in locally. Only run it against a disposable test database with `RELAY_RUN_DB_TESTS=true`; never point tests or preview deployments at production.

For UI changes, include screenshots or a short description of what changed. For database changes, include a migration and explain how it behaves with existing data. Keep pull requests focused and describe any environment-variable or deployment changes.

## Pull request checklist

- [ ] The change has a clear purpose and a focused diff.
- [ ] Tests and the production build pass.
- [ ] User input is validated on the server.
- [ ] Database queries use parameters for values.
- [ ] Authorization is checked on the server, not only in the UI.
- [ ] No real credentials or personal data are included.
- [ ] Documentation and environment-variable examples are updated when needed.
- [ ] Any database migration is included and explained.

## Project conventions

- Keep client code in `client/`, API and database code in `server/`, and shared contracts in `shared/`.
- Use the existing TypeScript, React, Express, Zod, and PostgreSQL patterns.
- Keep migrations numbered and add regression tests for bug fixes.
- Avoid unrelated formatting churn and generated build artifacts.
- Do not change production data or hosting secrets as part of a code-only pull request.
