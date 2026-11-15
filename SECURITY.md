# Security policy

Relay handles account credentials, private conversations, community membership, and uploaded files. Please report security problems responsibly.

## Reporting a vulnerability

**Do not publish an exploitable vulnerability, proof-of-concept exploit, private conversation, or credential in a public issue or pull request.**

Use GitHub's **Report a vulnerability** option in the repository's Security tab to send a private report when private vulnerability reporting is enabled. If that option is unavailable, contact the repository owner privately through the GitHub account rather than posting exploit details publicly.

A useful report includes:

- A clear description of the affected feature and impact.
- The affected commit, release, or deployment, if known.
- Reproduction steps using test accounts and non-production data.
- Any suggested mitigation.

Do not include real users' messages, passwords, session cookies, API keys, database URLs, or other private data.

## Supported versions

The project is under active development. Security fixes are made against the current default branch. There is no published long-term-support release policy yet.

## Security expectations

- Keep production secrets in the hosting provider's secret manager.
- Use separate databases for production, previews, and tests.
- Keep object-storage buckets private.
- Rotate a credential immediately if it may have been exposed.
- Never commit `.env` files or real credentials.
- Do not assume messages are end-to-end encrypted; Relay processes and stores message content on its backend.

## Current implementation notes

The application uses HTTP-only session cookies, hashed session tokens, origin checks on API mutations, input validation, Helmet security headers, parameterized SQL values, and authenticated Socket.IO room joins. These controls reduce risk but do not guarantee that the application is free of vulnerabilities.

The current HTTP rate limiters use the default in-process store. This is not a shared, global limit across multiple serverless instances; a shared rate-limit store should be considered before relying on these limits as a distributed abuse-control system.

The Helmet configuration currently disables Content Security Policy. Any future CSP should be designed and tested against the real client assets before being enforced.
