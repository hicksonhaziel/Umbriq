const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");

const ACTIVE_STATUSES = new Set(["active"]);

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

function mapQuoteRow(row) {
  return {
    id: row.id,
    rfqId: row.rfqId,
    marketMakerWallet: row.marketMakerWallet,
    allInPrice: row.allInPrice,
    guaranteedSize: row.guaranteedSize,
    validUntil:
      row.validUntil instanceof Date ? row.validUntil.toISOString() : String(row.validUntil),
    settlementConstraints: row.settlementConstraints,
    encryptedPayload: row.encryptedPayload,
    signature: row.signature,
    status: row.status,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

class InMemoryQuoteStore {
  constructor() {
    this.byId = new Map();
  }

  async create(input) {
    for (const quote of this.byId.values()) {
      if (quote.rfqId === input.rfqId && quote.marketMakerWallet === input.marketMakerWallet) {
        const error = new Error("Quote already submitted for this RFQ by this market maker");
        error.code = "23505";
        throw error;
      }
    }

    const now = new Date().toISOString();
    const quote = {
      id: randomUUID(),
      rfqId: input.rfqId,
      marketMakerWallet: input.marketMakerWallet,
      allInPrice: input.allInPrice,
      guaranteedSize: input.guaranteedSize,
      validUntil: input.validUntil,
      settlementConstraints: input.settlementConstraints || {},
      encryptedPayload: input.encryptedPayload || {},
      signature: input.signature,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    this.byId.set(quote.id, quote);
    return quote;
  }

  async getActiveByRfqId(rfqId) {
    const now = Date.now();
    const quotes = [];
    for (const quote of this.byId.values()) {
      if (quote.rfqId !== rfqId) {
        continue;
      }
      if (!ACTIVE_STATUSES.has(quote.status)) {
        continue;
      }
      if (Date.parse(quote.validUntil) <= now) {
        continue;
      }
      quotes.push(quote);
    }
    return quotes;
  }

  async getActiveCountByRfqIds(rfqIds) {
    if (!Array.isArray(rfqIds) || rfqIds.length === 0) {
      return {};
    }

    const rfqIdSet = new Set(rfqIds);
    const now = Date.now();
    const counts = {};

    for (const quote of this.byId.values()) {
      if (!rfqIdSet.has(quote.rfqId)) {
        continue;
      }
      if (!ACTIVE_STATUSES.has(quote.status)) {
        continue;
      }
      if (Date.parse(quote.validUntil) <= now) {
        continue;
      }

      counts[quote.rfqId] = (counts[quote.rfqId] || 0) + 1;
    }

    return counts;
  }

  async expireByIds(quoteIds) {
    if (!Array.isArray(quoteIds) || quoteIds.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    const expired = [];
    for (const quoteId of quoteIds) {
      const quote = this.byId.get(quoteId);
      if (!quote || quote.status !== "active") {
        continue;
      }
      quote.status = "expired";
      quote.updatedAt = now;
      expired.push({ ...quote });
    }
    return expired;
  }

  async expireDue(nowIso = new Date().toISOString()) {
    const now = Date.parse(nowIso);
    const expired = [];
    for (const quote of this.byId.values()) {
      if (quote.status !== "active") {
        continue;
      }
      if (Date.parse(quote.validUntil) > now) {
        continue;
      }
      quote.status = "expired";
      quote.updatedAt = new Date(now).toISOString();
      expired.push({ ...quote });
    }
    return expired;
  }

  async close() {}
}

class PostgresQuoteStore {
  constructor({ pool, ownsPool = false }) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  async create(input) {
    const query = `
      INSERT INTO quotes (
        rfq_id,
        market_maker_wallet,
        all_in_price,
        guaranteed_size,
        valid_until,
        settlement_constraints,
        encrypted_payload,
        signature
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
      RETURNING
        id,
        rfq_id AS "rfqId",
        market_maker_wallet AS "marketMakerWallet",
        all_in_price::text AS "allInPrice",
        guaranteed_size::text AS "guaranteedSize",
        valid_until AS "validUntil",
        settlement_constraints AS "settlementConstraints",
        encrypted_payload AS "encryptedPayload",
        signature,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const values = [
      input.rfqId,
      input.marketMakerWallet,
      input.allInPrice,
      input.guaranteedSize,
      input.validUntil,
      JSON.stringify(input.settlementConstraints || {}),
      JSON.stringify(input.encryptedPayload || {}),
      input.signature,
    ];

    const result = await this.pool.query(query, values);
    return mapQuoteRow(result.rows[0]);
  }

  async getActiveByRfqId(rfqId) {
    const query = `
      SELECT
        id,
        rfq_id AS "rfqId",
        market_maker_wallet AS "marketMakerWallet",
        all_in_price::text AS "allInPrice",
        guaranteed_size::text AS "guaranteedSize",
        valid_until AS "validUntil",
        settlement_constraints AS "settlementConstraints",
        encrypted_payload AS "encryptedPayload",
        signature,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM quotes
      WHERE rfq_id = $1
        AND status = 'active'
        AND valid_until > NOW()
    `;
    const result = await this.pool.query(query, [rfqId]);
    return result.rows.map(mapQuoteRow);
  }

  async getActiveCountByRfqIds(rfqIds) {
    if (!Array.isArray(rfqIds) || rfqIds.length === 0) {
      return {};
    }

    const query = `
      SELECT rfq_id AS "rfqId", COUNT(*)::int AS "count"
      FROM quotes
      WHERE rfq_id = ANY($1::uuid[])
        AND status = 'active'
        AND valid_until > NOW()
      GROUP BY rfq_id
    `;

    const result = await this.pool.query(query, [rfqIds]);
    const counts = {};
    for (const row of result.rows) {
      counts[row.rfqId] = Number(row.count) || 0;
    }
    return counts;
  }

  async expireByIds(quoteIds) {
    if (!Array.isArray(quoteIds) || quoteIds.length === 0) {
      return [];
    }

    const query = `
      UPDATE quotes
      SET status = 'expired', updated_at = NOW()
      WHERE id = ANY($1::uuid[])
        AND status = 'active'
        AND valid_until <= NOW()
      RETURNING
        id,
        rfq_id AS "rfqId",
        market_maker_wallet AS "marketMakerWallet",
        all_in_price::text AS "allInPrice",
        guaranteed_size::text AS "guaranteedSize",
        valid_until AS "validUntil",
        settlement_constraints AS "settlementConstraints",
        encrypted_payload AS "encryptedPayload",
        signature,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const result = await this.pool.query(query, [quoteIds]);
    return result.rows.map(mapQuoteRow);
  }

  async expireDue(nowIso = new Date().toISOString()) {
    const query = `
      UPDATE quotes
      SET status = 'expired', updated_at = NOW()
      WHERE status = 'active'
        AND valid_until <= $1::timestamptz
      RETURNING
        id,
        rfq_id AS "rfqId",
        market_maker_wallet AS "marketMakerWallet",
        all_in_price::text AS "allInPrice",
        guaranteed_size::text AS "guaranteedSize",
        valid_until AS "validUntil",
        settlement_constraints AS "settlementConstraints",
        encrypted_payload AS "encryptedPayload",
        signature,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const result = await this.pool.query(query, [nowIso]);
    return result.rows.map(mapQuoteRow);
  }

  async close() {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

function createPostgresQuoteStore({ connectionString, pool } = {}) {
  if (pool) {
    return new PostgresQuoteStore({ pool, ownsPool: false });
  }

  const normalizedConnectionString = normalizeDatabaseUrl(
    connectionString || process.env.DATABASE_URL
  );
  if (!normalizedConnectionString) {
    throw new Error("DATABASE_URL is required for Postgres quote storage");
  }

  const createdPool = new Pool({
    connectionString: normalizedConnectionString,
  });
  return new PostgresQuoteStore({ pool: createdPool, ownsPool: true });
}

module.exports = {
  InMemoryQuoteStore,
  PostgresQuoteStore,
  createPostgresQuoteStore,
};
