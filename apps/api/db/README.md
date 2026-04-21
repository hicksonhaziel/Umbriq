# API Database

## Migration

From the repo root:

```bash
pnpm --filter api run db:migrate
```

Or from `apps/api`:

```bash
pnpm run db:migrate
```

The migration script reads `DATABASE_URL` from environment and applies:

- `db/migrations/001_initial_schema.sql`

## Notes

- The current `.env` uses `?schema=public`; the migration script strips this for `psql`.
- Tables created: `rfqs`, `quotes`, `settlements`.
