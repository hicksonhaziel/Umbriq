#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set."
  exit 1
fi

# Prisma-style schema param is not a libpq connection option and breaks psql.
DB_URL="${DATABASE_URL/\?schema=public/}"
DB_URL="${DB_URL/\&schema=public/}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_FILE="${SCRIPT_DIR}/migrations/001_initial_schema.sql"

if command -v psql >/dev/null 2>&1; then
  psql "${DB_URL}" -v ON_ERROR_STOP=1 -f "${MIGRATION_FILE}"
elif command -v docker >/dev/null 2>&1; then
  REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
  COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"

  docker compose -f "${COMPOSE_FILE}" up -d db >/dev/null
  docker compose -f "${COMPOSE_FILE}" exec -T db sh -lc \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
    < "${MIGRATION_FILE}"
else
  echo "Neither psql nor docker is available to run migrations."
  exit 1
fi

echo "Applied migration: ${MIGRATION_FILE}"
