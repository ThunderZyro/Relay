# Relay architecture

This document describes the current repository architecture. See [PRODUCTION_INTEGRATIONS.md](PRODUCTION_INTEGRATIONS.md) for hosting configuration.

## Overview

Relay is one shared application with a web client, API, PostgreSQL database, realtime transport, object storage, and an optional desktop shell.

```text
Browser ───────┐
               ├── HTTPS / Socket.IO ──> Relay server
Electron app ──┘                           │
                                          ├── PostgreSQL
                                          │    ├── accounts and sessions
                                          │    ├── conversations and messages
                                          │    ├── communities and permissions
                                          │    └── notifications and metadata
                                          │
                                          └── Private S3-compatible object storage
                                               └── uploaded attachments
```

## Web client — `client/`

- React 18 and TypeScript.
- Vite development server and production build.
- Calls the API through `client/src/api.ts`.
- Uses Socket.IO for realtime events and conversation updates.
- The client is not an authorization boundary: the API must verify every protected action.

## API — `server/`

- Express handles JSON endpoints, cookies, file uploads, and production static hosting.
- Zod schemas validate request bodies.
- Authentication reads the HTTP-only `relay_session` cookie and checks the corresponding server-side session.
- Mutating API requests must come from an allowed origin and include the Relay request header.
- Socket.IO authenticates the session cookie and checks membership/permissions before joining channel, DM, or voice rooms.

## Database

PostgreSQL stores user accounts, session records, settings, friendships, DMs, communities, roles, channels, messages, reports, events, and upload metadata.

Migrations live in `server/migrations/` and are applied by the API at startup. They are numbered and tracked in `schema_migrations`. Use a separate database for tests and previews; never experiment against production data.

## Realtime

Socket.IO carries typing indicators, notifications, message updates, and WebRTC voice signaling. The PostgreSQL Socket.IO adapter shares room/broadcast state across server instances. The adapter requires a direct PostgreSQL connection that supports `LISTEN/NOTIFY`; a transaction-pooler URL is not suitable for that connection.

Clients reconnect and refresh recent message history after interruptions. The desktop and browser clients use the same account and backend.

## Upload storage

Uploads are staged before being attached to a message. PostgreSQL tracks ownership, expiry, metadata, and quota reservations. Development can use local disk. Hosted production instances require persistent S3-compatible object storage; Relay deliberately returns an upload error instead of silently using temporary serverless disk.

## Desktop — `desktop/`

The Electron app is a secure wrapper around the hosted Relay website, not a second backend. The current shell enables context isolation and sandboxing, disables Node integration in the webpage, restricts navigation to the configured Relay origin, and opens external HTTPS links in the system browser.

## Environment boundaries

Keep these environments separate:

- **Local development:** your own PostgreSQL database and local-only secrets.
- **Preview:** a separate database and storage configuration, never production credentials or user data.
- **Production:** managed secrets, persistent private object storage, and the live database.

A code change should not require manually editing production data. Database structure changes belong in migrations and should be tested against a disposable database first.
