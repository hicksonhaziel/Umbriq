const { PublicKey } = require("@solana/web3.js");

const VALID_RFQ_SIDES = ["buy", "sell"];

function parsePositiveNumberString(value, fieldName) {
  if (typeof value !== "string" && typeof value !== "number") {
    return {
      error: `${fieldName} is required`,
    };
  }

  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return {
      error: `${fieldName} must be a positive number`,
    };
  }

  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return {
      error: `${fieldName} must be greater than zero`,
    };
  }

  return {
    value: normalized,
  };
}

function parsePair(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      error: "pair is required",
    };
  }

  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(normalized)) {
    return {
      error: "pair must follow BASE/QUOTE format, for example SOL/USDC",
    };
  }

  return {
    value: normalized,
  };
}

function parseSide(value) {
  if (typeof value !== "string" || !VALID_RFQ_SIDES.includes(value)) {
    return {
      error: `side must be one of: ${VALID_RFQ_SIDES.join(", ")}`,
    };
  }

  return {
    value,
  };
}

function parseQuoteExpiresAt(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      error: "quoteExpiresAt is required",
    };
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return {
      error: "quoteExpiresAt must be a valid ISO timestamp",
    };
  }

  if (timestamp <= Date.now()) {
    return {
      error: "quoteExpiresAt must be in the future",
    };
  }

  return {
    value: new Date(timestamp).toISOString(),
  };
}

function parseCounterparties(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      error: "counterparties must be a non-empty array of wallet addresses",
    };
  }

  const deduped = [];
  const seen = new Set();

  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return {
        error: "Each counterparty must be a wallet address string",
      };
    }

    const walletAddress = item.trim();
    try {
      new PublicKey(walletAddress);
    } catch {
      return {
        error: `Invalid counterparty wallet address: ${walletAddress}`,
      };
    }

    if (!seen.has(walletAddress)) {
      seen.add(walletAddress);
      deduped.push(walletAddress);
    }
  }

  return {
    value: deduped,
  };
}

function parseEncryptedPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      error: "encryptedPayload must be a JSON object",
    };
  }

  return {
    value,
  };
}

function validateRfqCreatePayload(payload) {
  const pairResult = parsePair(payload?.pair);
  if (pairResult.error) {
    return pairResult;
  }

  const sideResult = parseSide(payload?.side);
  if (sideResult.error) {
    return sideResult;
  }

  const notionalSizeResult = parsePositiveNumberString(
    payload?.notionalSize,
    "notionalSize"
  );
  if (notionalSizeResult.error) {
    return notionalSizeResult;
  }

  const quoteExpiresAtResult = parseQuoteExpiresAt(payload?.quoteExpiresAt);
  if (quoteExpiresAtResult.error) {
    return quoteExpiresAtResult;
  }

  const counterpartiesResult = parseCounterparties(payload?.counterparties);
  if (counterpartiesResult.error) {
    return counterpartiesResult;
  }

  const encryptedPayloadResult = parseEncryptedPayload(payload?.encryptedPayload);
  if (encryptedPayloadResult.error) {
    return encryptedPayloadResult;
  }

  const minFillRaw = payload?.minFillSize;
  let minFillSize = null;
  if (minFillRaw !== null && minFillRaw !== undefined && String(minFillRaw).trim() !== "") {
    const minFillResult = parsePositiveNumberString(minFillRaw, "minFillSize");
    if (minFillResult.error) {
      return minFillResult;
    }

    if (Number(minFillResult.value) > Number(notionalSizeResult.value)) {
      return {
        error: "minFillSize cannot exceed notionalSize",
      };
    }
    minFillSize = minFillResult.value;
  }

  return {
    value: {
      pair: pairResult.value,
      side: sideResult.value,
      notionalSize: notionalSizeResult.value,
      minFillSize,
      quoteExpiresAt: quoteExpiresAtResult.value,
      counterparties: counterpartiesResult.value,
      encryptedPayload: encryptedPayloadResult.value,
    },
  };
}

module.exports = {
  VALID_RFQ_SIDES,
  validateRfqCreatePayload,
};
