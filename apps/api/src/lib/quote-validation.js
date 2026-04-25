const QUOTE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseUuid(value, fieldName) {
  if (typeof value !== "string" || !QUOTE_ID_PATTERN.test(value.trim())) {
    return {
      error: `${fieldName} must be a valid UUID`,
    };
  }

  return {
    value: value.trim(),
  };
}

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

function parseValidUntil(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      error: "validUntil is required",
    };
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return {
      error: "validUntil must be a valid ISO timestamp",
    };
  }

  return {
    value: new Date(timestamp).toISOString(),
  };
}

function parseObjectValue(value, fieldName, defaultValue) {
  if (value === undefined || value === null) {
    return {
      value: defaultValue,
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      error: `${fieldName} must be a JSON object`,
    };
  }

  return {
    value,
  };
}

function parseSignature(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      error: "signature is required",
    };
  }

  return {
    value: value.trim(),
  };
}

function validateQuoteCreatePayload(payload) {
  const rfqIdResult = parseUuid(payload?.rfqId, "rfqId");
  if (rfqIdResult.error) {
    return rfqIdResult;
  }

  const allInPriceResult = parsePositiveNumberString(payload?.allInPrice, "allInPrice");
  if (allInPriceResult.error) {
    return allInPriceResult;
  }

  const guaranteedSizeResult = parsePositiveNumberString(
    payload?.guaranteedSize,
    "guaranteedSize"
  );
  if (guaranteedSizeResult.error) {
    return guaranteedSizeResult;
  }

  const validUntilResult = parseValidUntil(payload?.validUntil);
  if (validUntilResult.error) {
    return validUntilResult;
  }

  const settlementConstraintsResult = parseObjectValue(
    payload?.settlementConstraints,
    "settlementConstraints",
    {}
  );
  if (settlementConstraintsResult.error) {
    return settlementConstraintsResult;
  }

  const encryptedPayloadResult = parseObjectValue(
    payload?.encryptedPayload,
    "encryptedPayload",
    {}
  );
  if (encryptedPayloadResult.error) {
    return encryptedPayloadResult;
  }

  const signatureResult = parseSignature(payload?.signature);
  if (signatureResult.error) {
    return signatureResult;
  }

  return {
    value: {
      rfqId: rfqIdResult.value,
      allInPrice: allInPriceResult.value,
      guaranteedSize: guaranteedSizeResult.value,
      validUntil: validUntilResult.value,
      settlementConstraints: settlementConstraintsResult.value,
      encryptedPayload: encryptedPayloadResult.value,
      signature: signatureResult.value,
    },
  };
}

module.exports = {
  validateQuoteCreatePayload,
};
