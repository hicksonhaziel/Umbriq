const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");

function normalizeDatabaseUrl(connectionString) {
  if (typeof connectionString !== "string" || connectionString.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(connectionString);
    parsed.searchParams.delete("schema");
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

function mapRfqRow(row) {
  return {
    id: row.id,
    institutionWallet: row.institutionWallet,
    pair: row.pair,
    side: row.side,
    notionalSize: row.notionalSize,
    minFillSize: row.minFillSize,
    quoteExpiresAt:
      row.quoteExpiresAt instanceof Date
        ? row.quoteExpiresAt.toISOString()
        : String(row.quoteExpiresAt),
    status: row.status,
    encryptedPayload: row.encryptedPayload,
    counterparties: Array.isArray(row.counterparties) ? row.counterparties : [],
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

class InMemoryRfqStore {
  constructor() {
    this.records = new Map();
  }

  async create(input) {
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      institutionWallet: input.institutionWallet,
      pair: input.pair,
      side: input.side,
      notionalSize: input.notionalSize,
      minFillSize: input.minFillSize,
      quoteExpiresAt: input.quoteExpiresAt,
      status: "open",
      encryptedPayload: input.encryptedPayload,
      counterparties: input.counterparties,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return record;
  }

  async close() {}
}

class PostgresRfqStore {
  constructor({ pool, ownsPool = false }) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  async create(input) {
    const query = `
      INSERT INTO rfqs (
        institution_wallet,
        pair,
        side,
        notional_size,
        min_fill_size,
        quote_expires_at,
        encrypted_payload,
        counterparties
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
      RETURNING
        id,
        institution_wallet AS "institutionWallet",
        pair,
        side,
        notional_size::text AS "notionalSize",
        min_fill_size::text AS "minFillSize",
        quote_expires_at AS "quoteExpiresAt",
        status,
        encrypted_payload AS "encryptedPayload",
        counterparties AS "counterparties",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const values = [
      input.institutionWallet,
      input.pair,
      input.side,
      input.notionalSize,
      input.minFillSize,
      input.quoteExpiresAt,
      JSON.stringify(input.encryptedPayload),
      JSON.stringify(input.counterparties),
    ];

    const result = await this.pool.query(query, values);
    return mapRfqRow(result.rows[0]);
  }

  async close() {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

function createPostgresRfqStore({ connectionString, pool } = {}) {
  if (pool) {
    return new PostgresRfqStore({ pool, ownsPool: false });
  }

  const normalizedConnectionString = normalizeDatabaseUrl(
    connectionString || process.env.DATABASE_URL
  );
  if (!normalizedConnectionString) {
    throw new Error("DATABASE_URL is required for Postgres RFQ storage");
  }

  const createdPool = new Pool({
    connectionString: normalizedConnectionString,
  });
  return new PostgresRfqStore({ pool: createdPool, ownsPool: true });
}

module.exports = {
  InMemoryRfqStore,
  PostgresRfqStore,
  createPostgresRfqStore,
};
