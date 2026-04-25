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

function mapSettlementRow(row) {
  return {
    id: row.id,
    rfqId: row.rfqId,
    quoteId: row.quoteId,
    status: row.status,
    umbraTxSignature: row.umbraTxSignature,
    receipt: row.receipt || {},
    proof: row.proof || {},
    errorMessage: row.errorMessage,
    startedAt:
      row.startedAt instanceof Date ? row.startedAt.toISOString() : row.startedAt || null,
    completedAt:
      row.completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt || null,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

class InMemorySettlementStore {
  constructor() {
    this.byId = new Map();
    this.byQuoteId = new Map();
  }

  async create(input) {
    if (this.byQuoteId.has(input.quoteId)) {
      const error = new Error("Settlement already exists for this quote");
      error.code = "23505";
      throw error;
    }

    const now = new Date().toISOString();
    const settlement = {
      id: randomUUID(),
      rfqId: input.rfqId,
      quoteId: input.quoteId,
      status: input.status || "accepted",
      umbraTxSignature: input.umbraTxSignature || null,
      receipt: input.receipt || {},
      proof: input.proof || {},
      errorMessage: input.errorMessage || null,
      startedAt: input.startedAt || null,
      completedAt: input.completedAt || null,
      createdAt: now,
      updatedAt: now,
    };

    this.byId.set(settlement.id, settlement);
    this.byQuoteId.set(settlement.quoteId, settlement.id);
    return { ...settlement };
  }

  async getById(settlementId) {
    const settlement = this.byId.get(settlementId);
    return settlement ? { ...settlement } : null;
  }

  async getByQuoteId(quoteId) {
    const settlementId = this.byQuoteId.get(quoteId);
    if (!settlementId) {
      return null;
    }
    return this.getById(settlementId);
  }

  async update(settlementId, patch) {
    const current = this.byId.get(settlementId);
    if (!current) {
      return null;
    }

    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(settlementId, next);
    return { ...next };
  }

  async close() {}
}

class PostgresSettlementStore {
  constructor({ pool, ownsPool = false }) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  async create(input) {
    const query = `
      INSERT INTO settlements (
        rfq_id,
        quote_id,
        status,
        umbra_tx_signature,
        receipt,
        proof,
        error_message,
        started_at,
        completed_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
      RETURNING
        id,
        rfq_id AS "rfqId",
        quote_id AS "quoteId",
        status,
        umbra_tx_signature AS "umbraTxSignature",
        receipt AS "receipt",
        proof AS "proof",
        error_message AS "errorMessage",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const values = [
      input.rfqId,
      input.quoteId,
      input.status || "accepted",
      input.umbraTxSignature || null,
      JSON.stringify(input.receipt || {}),
      JSON.stringify(input.proof || {}),
      input.errorMessage || null,
      input.startedAt || null,
      input.completedAt || null,
    ];

    const result = await this.pool.query(query, values);
    return mapSettlementRow(result.rows[0]);
  }

  async getById(settlementId) {
    const query = `
      SELECT
        id,
        rfq_id AS "rfqId",
        quote_id AS "quoteId",
        status,
        umbra_tx_signature AS "umbraTxSignature",
        receipt AS "receipt",
        proof AS "proof",
        error_message AS "errorMessage",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM settlements
      WHERE id = $1
      LIMIT 1
    `;
    const result = await this.pool.query(query, [settlementId]);
    if (result.rows.length === 0) {
      return null;
    }
    return mapSettlementRow(result.rows[0]);
  }

  async getByQuoteId(quoteId) {
    const query = `
      SELECT
        id,
        rfq_id AS "rfqId",
        quote_id AS "quoteId",
        status,
        umbra_tx_signature AS "umbraTxSignature",
        receipt AS "receipt",
        proof AS "proof",
        error_message AS "errorMessage",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM settlements
      WHERE quote_id = $1
      LIMIT 1
    `;
    const result = await this.pool.query(query, [quoteId]);
    if (result.rows.length === 0) {
      return null;
    }
    return mapSettlementRow(result.rows[0]);
  }

  async update(settlementId, patch) {
    const fields = [];
    const values = [settlementId];
    let index = 2;

    if (Object.hasOwn(patch, "status")) {
      fields.push(`status = $${index}`);
      values.push(patch.status);
      index += 1;
    }
    if (Object.hasOwn(patch, "umbraTxSignature")) {
      fields.push(`umbra_tx_signature = $${index}`);
      values.push(patch.umbraTxSignature || null);
      index += 1;
    }
    if (Object.hasOwn(patch, "receipt")) {
      fields.push(`receipt = $${index}::jsonb`);
      values.push(JSON.stringify(patch.receipt || {}));
      index += 1;
    }
    if (Object.hasOwn(patch, "proof")) {
      fields.push(`proof = $${index}::jsonb`);
      values.push(JSON.stringify(patch.proof || {}));
      index += 1;
    }
    if (Object.hasOwn(patch, "errorMessage")) {
      fields.push(`error_message = $${index}`);
      values.push(patch.errorMessage || null);
      index += 1;
    }
    if (Object.hasOwn(patch, "startedAt")) {
      fields.push(`started_at = $${index}`);
      values.push(patch.startedAt || null);
      index += 1;
    }
    if (Object.hasOwn(patch, "completedAt")) {
      fields.push(`completed_at = $${index}`);
      values.push(patch.completedAt || null);
      index += 1;
    }

    if (fields.length === 0) {
      return this.getById(settlementId);
    }

    const query = `
      UPDATE settlements
      SET ${fields.join(", ")}, updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        rfq_id AS "rfqId",
        quote_id AS "quoteId",
        status,
        umbra_tx_signature AS "umbraTxSignature",
        receipt AS "receipt",
        proof AS "proof",
        error_message AS "errorMessage",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const result = await this.pool.query(query, values);
    if (result.rows.length === 0) {
      return null;
    }
    return mapSettlementRow(result.rows[0]);
  }

  async close() {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

function createPostgresSettlementStore({ connectionString, pool } = {}) {
  if (pool) {
    return new PostgresSettlementStore({ pool, ownsPool: false });
  }

  const normalizedConnectionString = normalizeDatabaseUrl(
    connectionString || process.env.DATABASE_URL
  );
  if (!normalizedConnectionString) {
    throw new Error("DATABASE_URL is required for Postgres settlement storage");
  }

  const createdPool = new Pool({
    connectionString: normalizedConnectionString,
  });
  return new PostgresSettlementStore({ pool: createdPool, ownsPool: true });
}

module.exports = {
  InMemorySettlementStore,
  PostgresSettlementStore,
  createPostgresSettlementStore,
};
