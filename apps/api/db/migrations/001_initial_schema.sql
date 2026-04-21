BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS rfqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_wallet TEXT NOT NULL,
  pair TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  notional_size NUMERIC(30, 10) NOT NULL CHECK (notional_size > 0),
  min_fill_size NUMERIC(30, 10) CHECK (min_fill_size > 0 AND min_fill_size <= notional_size),
  quote_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'quoted', 'expired', 'cancelled', 'accepted', 'settling', 'settled', 'failed')
  ),
  encrypted_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  counterparties JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id UUID NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  market_maker_wallet TEXT NOT NULL,
  all_in_price NUMERIC(30, 10) NOT NULL CHECK (all_in_price > 0),
  guaranteed_size NUMERIC(30, 10) NOT NULL CHECK (guaranteed_size > 0),
  valid_until TIMESTAMPTZ NOT NULL,
  settlement_constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  encrypted_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'expired', 'rejected', 'accepted', 'withdrawn')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rfq_id, market_maker_wallet)
);

CREATE TABLE IF NOT EXISTS settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id UUID NOT NULL REFERENCES rfqs(id) ON DELETE RESTRICT,
  quote_id UUID NOT NULL UNIQUE REFERENCES quotes(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (
    status IN ('accepted', 'settling', 'settled', 'failed')
  ),
  umbra_tx_signature TEXT,
  receipt JSONB NOT NULL DEFAULT '{}'::jsonb,
  proof JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_rfqs_status_quote_expires_at
  ON rfqs (status, quote_expires_at);

CREATE INDEX IF NOT EXISTS idx_quotes_rfq_status_valid_until
  ON quotes (rfq_id, status, valid_until);

CREATE INDEX IF NOT EXISTS idx_settlements_status
  ON settlements (status);

DROP TRIGGER IF EXISTS trg_rfqs_set_updated_at ON rfqs;
CREATE TRIGGER trg_rfqs_set_updated_at
BEFORE UPDATE ON rfqs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_quotes_set_updated_at ON quotes;
CREATE TRIGGER trg_quotes_set_updated_at
BEFORE UPDATE ON quotes
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_settlements_set_updated_at ON settlements;
CREATE TRIGGER trg_settlements_set_updated_at
BEFORE UPDATE ON settlements
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
