# Umbriq Repo Working Rules

## Product Context
- `apps/web` serves the waitlist at `/` (production-safe route).
- Active product development should happen under `/dev` until promoted.
- `apps/api` is the backend (auth, RFQ/quote/settlement services).
- Current target flow: connect wallet -> authenticate -> initialize Umbra account -> role dashboard.

## Monorepo Layout
- `apps/web`: Next.js frontend.
- `apps/api`: Fastify backend + DB migration scripts.
- `packages/*`: shared packages for cross-app code (types, solana utilities, contracts).

## Data Layer
- Canonical SQL migrations live in `apps/api/db/migrations/`.
- Migration runner: `apps/api/db/migrate.sh`.
- Keep schema changes additive and versioned by new migration files.

## Auth + Roles
- Wallet authentication must use signed nonce challenge/verify flow.
- Supported roles: `institution`, `market_maker`, `compliance`.
- Session state must be server-side (Redis preferred, in-memory fallback for local dev/tests).
- Auth routes currently implemented:
  - `POST /auth/nonce`
  - `POST /auth/verify`
  - `GET /auth/session`
  - `POST /auth/logout`

## Umbra Setup Context
- Frontend Umbra SDK integration lives in `apps/web/src/lib/umbra/*`.
- Backend Umbra state persistence routes:
  - `GET /umbra/account`
  - `POST /umbra/account`
- Dashboard route `GET /dashboard` is gated by Umbra readiness (`umbraReady`).
- Umbra account state storage:
  - Redis when available
  - In-memory fallback in local/test mode
- Current default registration mode is:
  - `confidential: true`
  - `anonymous: false`
- Reason: anonymous mode requires a browser zkProver dependency; do not enable anonymous mode until prover integration is added.
- Anonymous mode toggle:
  - `NEXT_PUBLIC_UMBRA_ENABLE_ANONYMOUS=true` enables anonymous registration attempts.
  - Leave unset/false for stable confidential-only initialization.

## Tests
- API auth test: `pnpm --filter api test:auth`
- API integration tests: `pnpm --filter api test:integration`
- Current integration coverage includes auth + Umbra state persistence flow.

## Active Env Variables
- API:
  - `PORT`, `HOST`
  - `DATABASE_URL`
  - `REDIS_URL`
  - `SESSION_TTL_SECONDS`
- Web:
  - `NEXT_PUBLIC_API_BASE_URL`
  - `NEXT_PUBLIC_UMBRA_NETWORK`
  - `NEXT_PUBLIC_SOLANA_RPC_URL`
  - `NEXT_PUBLIC_SOLANA_RPC_SUBSCRIPTIONS_URL`
  - `NEXT_PUBLIC_UMBRA_INDEXER_API_ENDPOINT`
  - `NEXT_PUBLIC_UMBRA_ENABLE_ANONYMOUS`

## Style + Preferences
- Avoid changing waitlist UX at `/` unless explicitly requested.
- Keep backend changes modular and testable.
- Add/update tests when changing auth, role checks, or Umbra setup logic.
- Do not use emojis in code, logs, or user-facing implementation text unless explicitly requested.
