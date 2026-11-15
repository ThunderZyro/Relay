# Security review snapshot

**Review date:** 2026-11-14  
**Reviewed revision:** `03900ec8f8c0d0439be0fce8f642919e658eae98` (main before this documentation/security workflow change)

This is a source and repository-configuration review, not a penetration test or a guarantee that Relay is vulnerability-free.

## Scope

Reviewed the current `main` source tree for the client, API, database worker, storage adapter, Electron shell, Windows helper scripts, GitHub Actions workflows, environment examples, and Docker configuration. A limited pattern scan looked for dynamic code execution, unsafe HTML injection, common hard-coded credential formats, and private-key material in tracked source files.

The GitHub connection used for this review did not expose the repository's Dependabot, code-scanning, or secret-scanning alert panels. This review also does not prove that no secret was ever committed in earlier Git history or in an unreviewed branch.

## Controls observed

- SQL query values are passed as parameters to PostgreSQL; dynamic update-column names in reviewed routes come from Zod-validated object schemas.
- Session tokens are random and stored as keyed hashes; the browser cookie is HTTP-only.
- Mutating API requests check the allowed origin and a client request header.
- API input is validated in many routes with Zod; Helmet, CORS origin restrictions, request-size limits, authentication, and membership/permission checks are present.
- Socket.IO validates the session and checks access before joining channel, DM, or voice rooms.
- Uploads have file-count and size limits, file-type checks, ownership checks, and a production guard requiring persistent storage.
- The Electron window uses context isolation and sandboxing, disables Node integration, restricts navigation, and opens external HTTPS links in the system browser.
- No dynamic `eval`/Function construction, unsafe HTML assignment, common AWS/GitHub token format, or private-key block was found in the reviewed current-main client/server/desktop files. Test fixtures contain dummy credentials for isolated tests; they are not production secrets.

## Repository-level fixes in this change

1. The desktop build-and-test job previously inherited `contents: write` even for pull requests. The workflow now gives the build job read-only permissions and moves release publishing into a separate job with write permission.
2. The Docker ignore file previously excluded only the exact `.env` filename. It now excludes `.env.*` files and nested environment files too, preventing local environment files from entering a Docker build context.
3. PostgreSQL CI uses npm install while the checked-in lockfile is being brought back into sync, with read-only repository permissions and only runs on pull requests and pushes to `main`.
4. Dependabot and CodeQL workflows are added so dependency updates and static analysis run on a schedule.

## Follow-up hardening to consider

- The default Express rate-limit store is process-local. A shared store is needed if a request limit must apply globally across multiple serverless instances.
- Helmet Content Security Policy is explicitly disabled. Design and test a CSP that matches the built client before enabling it.
- Review WebSocket event rates and upload memory use under realistic concurrent load.
- Enable and periodically review GitHub secret scanning and push protection in repository settings. Rotate any credential that may have appeared in Git history.

## Branch review

The non-main branches present during this review each contained commits not present in `main`. They were preserved; no branch or commit history was deleted.
