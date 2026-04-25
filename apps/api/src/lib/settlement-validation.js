const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseUuid(value, fieldName) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    return {
      error: `${fieldName} must be a valid UUID`,
    };
  }
  return {
    value: value.trim(),
  };
}

function validateSettlementAcceptPayload(payload) {
  const quoteIdResult = parseUuid(payload?.quoteId, "quoteId");
  if (quoteIdResult.error) {
    return quoteIdResult;
  }

  return {
    value: {
      quoteId: quoteIdResult.value,
    },
  };
}

module.exports = {
  validateSettlementAcceptPayload,
};
