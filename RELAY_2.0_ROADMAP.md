# Relay 2.0 — Upgrade Roadmap

Relay 2.0 is the next major release of the combined community and messaging app. This roadmap is based on the Discord and WhatsApp feature lists supplied for Relay.

## Delivered in the 2.0 work branch

- Versioned the app, client, and server as `2.0.0`.
- Direct-message organization is personal to each member: pin, archive, mute, and star conversations.
- Added All, Unread, Groups, Starred, and Archived chat filters (the Online filter remains available).
- Added persisted per-user chat preferences with access checks and migration 013.
- Earlier branch work also includes saved messages, message forwarding, rich message formatting, polls, channel/category management, read receipts, and session-expiry protection.

## Remaining 2.0 roadmap

### Messaging and groups
- Scheduled messages and local drafts across devices.
- Voice notes, video notes, message transcription, and media galleries.
- Disappearing messages and view-once media.
- Group invite links, join approvals, group roles, announcement-only groups, and member history controls.
- Better message search filters, unread markers, reminders, and chat export.

### WhatsApp-style sharing
- 24-hour Status updates with audience controls and reactions.
- Channel follow/unfollow, discovery, and announcement delivery.
- Events with richer RSVP, reminders, and attendance controls.
- Location sharing and contact cards.

### Discord-style communities
- Threads and forum channels.
- Private/role-restricted channels and granular channel overrides.
- Stage/live audio events and stronger voice controls.
- Auto-moderation, audit logs, raid protection, and moderation queues.
- Bot/app integrations, webhooks, and community onboarding.

### Account, privacy, and platform
- Passkeys and optional two-step verification.
- Linked-device management and safer session revocation.
- End-to-end encryption and encrypted backups (must be designed and audited before being advertised).
- Reliable persistent object storage, account recovery email, and mobile/desktop packaging.
- Accessibility, localization, notification, and device settings polish.

## Release rule

A feature is not considered complete just because its screen exists. It must have server-side authorization, database migration coverage where needed, useful failure states, and a passing production build. Features that need external credentials or a security review remain marked as incomplete until verified.
