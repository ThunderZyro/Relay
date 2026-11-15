# Repository guide

Use this page to find the right place for a change without moving unrelated files.

| Path | Purpose |
|---|---|
| `client/src/App.tsx` | Client routes and application composition |
| `client/src/components/` | Shared shell and UI components |
| `client/src/pages/` | Screens for chat, core features, and settings |
| `client/src/api.ts` | Browser-to-API request helper |
| `client/src/state.tsx` | Client application state |
| `client/src/styles.css` | Application styling |
| `server/src/index.ts` | Express routes, Socket.IO events, and server startup |
| `server/src/db.ts` | PostgreSQL access and migration startup |
| `server/src/db-worker.ts` | PostgreSQL worker connection |
| `server/src/storage.ts` | Local and S3-compatible upload storage |
| `server/migrations/` | Numbered PostgreSQL schema migrations |
| `server/src/*.test.ts` | API and database-worker tests |
| `shared/types.ts` | Types shared across workspaces |
| `desktop/main.cjs` | Electron main process |
| `desktop/electron-builder.config.cjs` | Windows installer and update configuration |
| `.github/workflows/` | CI, static analysis, and desktop release workflows |
| `docs/` | Deployment and architecture documentation |
| Root `*.bat` files | Windows setup, build, and publish helpers |

## Where to make common changes

- **A screen or interaction:** start in the matching page under `client/src/pages/`.
- **Navigation or shared layout:** inspect `client/src/components/Shell.tsx`.
- **An API feature:** add or update a route in `server/src/index.ts`, validate input, and enforce server-side authorization.
- **A database change:** add the next numbered SQL migration and a regression test.
- **Upload behavior:** inspect both `server/src/index.ts` and `server/src/storage.ts`.
- **Desktop behavior:** update `desktop/main.cjs` and its documentation.

## Git workflow

- `main` is the integration branch.
- Create a short-lived branch for a focused change and open a pull request into `main`.
- Let the PostgreSQL integration, build, and CodeQL workflows finish before merging.
- Keep historical branches until their unique commits have been reviewed and either merged or intentionally abandoned. Do not delete a branch merely because it is old.
