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

function validateSettlementStartPayload(payload) {
  if (typeof payload?.network !== "string" || payload.network.trim().length === 0) {
    return {
      error: "network is required",
    };
  }

  return {
    value: {
      network: payload.network.trim(),
    },
  };
}

function validateSettlementCompletePayload(payload) {
  if (typeof payload?.network !== "string" || payload.network.trim().length === 0) {
    return {
      error: "network is required",
    };
  }

  if (typeof payload?.umbraTxSignature !== "string" || payload.umbraTxSignature.trim().length === 0) {
    return {
      error: "umbraTxSignature is required",
    };
  }

  if (!payload.receipt || typeof payload.receipt !== "object") {
    return {
      error: "receipt is required",
    };
  }

  if (!payload.proof || typeof payload.proof !== "object") {
    return {
      error: "proof is required",
    };
  }

  return {
    value: {
      network: payload.network.trim(),
      umbraTxSignature: payload.umbraTxSignature.trim(),
      receipt: payload.receipt,
      proof: payload.proof,
    },
  };
}

function validateSettlementFailPayload(payload) {
  if (typeof payload?.network !== "string" || payload.network.trim().length === 0) {
    return {
      error: "network is required",
    };
  }

  if (typeof payload?.errorMessage !== "string" || payload.errorMessage.trim().length === 0) {
    return {
      error: "errorMessage is required",
    };
  }

  return {
    value: {
      network: payload.network.trim(),
      errorMessage: payload.errorMessage.trim(),
      failure:
        payload.failure && typeof payload.failure === "object" ? payload.failure : {},
    },
  };
}

module.exports = {
  validateSettlementAcceptPayload,
  validateSettlementStartPayload,
  validateSettlementCompletePayload,
  validateSettlementFailPayload,
};
