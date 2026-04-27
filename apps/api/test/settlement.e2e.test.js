const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const { buildServer } = require("../src/server");
const { buildAuthMessage } = require("../src/lib/auth-message");
const { buildQuoteMessage } = require("../src/lib/quote-message");
const {
  decimalToBaseUnits,
  getUmbraNetworkConfig,
} = require("../src/lib/umbra-network-config");

const bs58Codec = bs58.default || bs58;

class RealtimeHubSpy {
  addClient() {}
  broadcast() {}
  broadcastRfqCreated() {}
  broadcastQuoteSubmitted() {}
  broadcastQuoteExpired() {}
}

async function authenticate(app, keypair, role) {
  const walletAddress = bs58Codec.encode(keypair.publicKey);

  const nonceRes = await app.inject({
    method: "POST",
    url: "/auth/nonce",
    payload: { walletAddress },
  });
  assert.equal(nonceRes.statusCode, 200);
  const nonceBody = nonceRes.json();

  const message = buildAuthMessage(walletAddress, nonceBody.nonce);
  const signature = nacl.sign.detached(
    new TextEncoder().encode(message),
    keypair.secretKey
  );

  const verifyRes = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: {
      walletAddress,
      signature: bs58Codec.encode(signature),
      role,
    },
  });
  assert.equal(verifyRes.statusCode, 200);

  return {
    walletAddress,
    token: verifyRes.json().sessionToken,
  };
}

async function createRfq({ app, token, counterparties }) {
  const response = await app.inject({
    method: "POST",
    url: "/rfqs",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      pair: "SOL/USDC",
      side: "buy",
      notionalSize: "1000",
      minFillSize: "200",
      quoteExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      counterparties,
      encryptedPayload: {
        version: "1",
        algorithm: "AES-GCM",
        ciphertext: "rfq-ciphertext",
      },
    },
  });
  assert.equal(response.statusCode, 201);
  return response.json();
}

async function submitQuote({
  app,
  token,
  marketMakerKeypair,
  marketMakerWallet,
  rfqId,
}) {
  const validUntil = new Date(Date.now() + 60 * 1000).toISOString();
  const signature = nacl.sign.detached(
    new TextEncoder().encode(
      buildQuoteMessage({
        rfqId,
        marketMakerWallet,
        allInPrice: "100.10",
        guaranteedSize: "400",
        validUntil,
      })
    ),
    marketMakerKeypair.secretKey
  );

  const response = await app.inject({
    method: "POST",
    url: "/quotes",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      rfqId,
      allInPrice: "100.10",
      guaranteedSize: "400",
      validUntil,
      signature: bs58Codec.encode(signature),
      settlementConstraints: {},
      encryptedPayload: {
        version: "1",
        algorithm: "AES-GCM",
        ciphertext: "quote-ciphertext",
      },
    },
  });
  assert.equal(response.statusCode, 201);
  return response.json();
}

async function getSettlement(app, token, settlementId) {
  const response = await app.inject({
    method: "GET",
    url: `/settlements/${settlementId}`,
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(response.statusCode, 200);
  return response.json();
}

function buildCompletionPayload({
  settlementId,
  rfqId,
  quoteId,
  institutionWallet,
  marketMakerWallet,
  guaranteedSize,
  network = "devnet",
}) {
  const networkConfig = getUmbraNetworkConfig(network);
  const amountBaseUnits = decimalToBaseUnits(
    guaranteedSize,
    networkConfig.mintDecimals
  );

  const proofPayload = {
    settlementId,
    rfqId,
    quoteId,
    network,
    mint: networkConfig.mint,
    amountBaseUnits,
    signerAddress: institutionWallet,
    destinationAddress: marketMakerWallet,
    depositQueueSignature: "deposit_queue_sig",
    depositCallbackSignature: "deposit_callback_sig",
    withdrawQueueSignature: "withdraw_queue_sig",
    withdrawCallbackSignature: "withdraw_callback_sig",
  };

  return {
    network,
    umbraTxSignature: "withdraw_callback_sig",
    receipt: {
      provider: "umbra-sdk",
      executionModel: "browser",
      network,
      mint: networkConfig.mint,
      mintDecimals: networkConfig.mintDecimals,
      amountBaseUnits,
      signerAddress: institutionWallet,
      destinationAddress: marketMakerWallet,
      registrationCheckedAt: new Date().toISOString(),
      deposit: {
        queueSignature: "deposit_queue_sig",
        callbackStatus: "finalized",
        callbackSignature: "deposit_callback_sig",
        callbackElapsedMs: 10,
        rentClaimSignature: null,
        rentClaimError: null,
      },
      withdraw: {
        queueSignature: "withdraw_queue_sig",
        callbackStatus: "finalized",
        callbackSignature: "withdraw_callback_sig",
        callbackElapsedMs: 12,
        rentClaimSignature: null,
        rentClaimError: null,
      },
    },
    proof: {
      type: "umbra-settlement-proof-v1",
      mode: "sdk-browser",
      hashAlgorithm: "sha256",
      digest: createHash("sha256")
        .update(JSON.stringify(proofPayload))
        .digest("hex"),
      payload: proofPayload,
    },
  };
}

test("settlement acceptance creates intent and does not auto-execute", async () => {
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    rfqRealtimeHub: new RealtimeHubSpy(),
  });

  try {
    const institution = nacl.sign.keyPair();
    const mm = nacl.sign.keyPair();

    const institutionSession = await authenticate(app, institution, "institution");
    const mmSession = await authenticate(app, mm, "market_maker");

    const rfq = await createRfq({
      app,
      token: institutionSession.token,
      counterparties: [mmSession.walletAddress],
    });
    const quote = await submitQuote({
      app,
      token: mmSession.token,
      marketMakerKeypair: mm,
      marketMakerWallet: mmSession.walletAddress,
      rfqId: rfq.id,
    });

    const acceptRes = await app.inject({
      method: "POST",
      url: "/settlements/accept",
      headers: {
        authorization: `Bearer ${institutionSession.token}`,
      },
      payload: {
        quoteId: quote.id,
      },
    });
    assert.equal(acceptRes.statusCode, 201);
    const accepted = acceptRes.json();
    assert.equal(accepted.status, "accepted");

    const settlement = await getSettlement(app, institutionSession.token, accepted.id);
    assert.equal(settlement.status, "accepted");
    assert.equal(settlement.rfq.status, "accepted");
    assert.equal(settlement.quote.status, "accepted");
    assert.equal(settlement.umbraTxSignature, null);
  } finally {
    await app.close();
  }
});

test("browser settlement completion flow persists receipt and proof", async () => {
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    rfqRealtimeHub: new RealtimeHubSpy(),
  });

  try {
    const institution = nacl.sign.keyPair();
    const mm = nacl.sign.keyPair();

    const institutionSession = await authenticate(app, institution, "institution");
    const mmSession = await authenticate(app, mm, "market_maker");

    const rfq = await createRfq({
      app,
      token: institutionSession.token,
      counterparties: [mmSession.walletAddress],
    });
    const quote = await submitQuote({
      app,
      token: mmSession.token,
      marketMakerKeypair: mm,
      marketMakerWallet: mmSession.walletAddress,
      rfqId: rfq.id,
    });

    const acceptRes = await app.inject({
      method: "POST",
      url: "/settlements/accept",
      headers: {
        authorization: `Bearer ${institutionSession.token}`,
      },
      payload: {
        quoteId: quote.id,
      },
    });
    assert.equal(acceptRes.statusCode, 201);
    const accepted = acceptRes.json();

    const startRes = await app.inject({
      method: "POST",
      url: `/settlements/${accepted.id}/start`,
      headers: {
        authorization: `Bearer ${institutionSession.token}`,
      },
      payload: {
        network: "devnet",
      },
    });
    assert.equal(startRes.statusCode, 200);
    assert.equal(startRes.json().status, "settling");

    const payload = buildCompletionPayload({
      settlementId: accepted.id,
      rfqId: rfq.id,
      quoteId: quote.id,
      institutionWallet: institutionSession.walletAddress,
      marketMakerWallet: mmSession.walletAddress,
      guaranteedSize: quote.guaranteedSize,
    });

    const completeRes = await app.inject({
      method: "POST",
      url: `/settlements/${accepted.id}/complete`,
      headers: {
        authorization: `Bearer ${institutionSession.token}`,
      },
      payload,
    });
    assert.equal(completeRes.statusCode, 200);

    const settlement = await getSettlement(app, institutionSession.token, accepted.id);
    assert.equal(settlement.status, "settled");
    assert.equal(settlement.rfq.status, "settled");
    assert.equal(settlement.quote.status, "accepted");
    assert.equal(settlement.umbraTxSignature, "withdraw_callback_sig");
    assert.equal(settlement.receipt.provider, "umbra-sdk");
    assert.equal(settlement.proof.type, "umbra-settlement-proof-v1");
  } finally {
    await app.close();
  }
});

test("browser settlement failure keeps accepted quote for retry", async () => {
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    rfqRealtimeHub: new RealtimeHubSpy(),
  });

  try {
    const institution = nacl.sign.keyPair();
    const mm = nacl.sign.keyPair();

    const institutionSession = await authenticate(app, institution, "institution");
    const mmSession = await authenticate(app, mm, "market_maker");

    const rfq = await createRfq({
      app,
      token: institutionSession.token,
      counterparties: [mmSession.walletAddress],
    });
    const quote = await submitQuote({
      app,
      token: mmSession.token,
      marketMakerKeypair: mm,
      marketMakerWallet: mmSession.walletAddress,
      rfqId: rfq.id,
    });

    const acceptRes = await app.inject({
      method: "POST",
      url: "/settlements/accept",
      headers: {
        authorization: `Bearer ${institutionSession.token}`,
      },
      payload: {
        quoteId: quote.id,
      },
    });
    assert.equal(acceptRes.statusCode, 201);
    const accepted = acceptRes.json();

    const startRes = await app.inject({
      method: "POST",
      url: `/settlements/${accepted.id}/start`,
      headers: {
        authorization: `Bearer ${institutionSession.token}`,
      },
      payload: {
        network: "devnet",
      },
    });
    assert.equal(startRes.statusCode, 200);

    const failRes = await app.inject({
      method: "POST",
      url: `/settlements/${accepted.id}/fail`,
      headers: {
        authorization: `Bearer ${institutionSession.token}`,
      },
      payload: {
        network: "devnet",
        errorMessage: "User rejected wallet signature",
        failure: {
          source: "browser",
          retryable: true,
        },
      },
    });
    assert.equal(failRes.statusCode, 200);

    const settlement = await getSettlement(app, institutionSession.token, accepted.id);
    assert.equal(settlement.status, "failed");
    assert.equal(settlement.rfq.status, "accepted");
    assert.equal(settlement.quote.status, "accepted");
    assert.match(settlement.errorMessage, /wallet signature/i);
    assert.equal(settlement.receipt.failure.source, "browser");
    assert.equal(settlement.receipt.failure.retryable, true);
  } finally {
    await app.close();
  }
});

test("settlement access control and duplicate acceptance protection", async () => {
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    rfqRealtimeHub: new RealtimeHubSpy(),
  });

  try {
    const institution = nacl.sign.keyPair();
    const mm = nacl.sign.keyPair();
    const compliance = nacl.sign.keyPair();

    const institutionSession = await authenticate(app, institution, "institution");
    const mmSession = await authenticate(app, mm, "market_maker");
    const complianceSession = await authenticate(app, compliance, "compliance");

    const rfq = await createRfq({
      app,
      token: institutionSession.token,
      counterparties: [mmSession.walletAddress],
    });
    const quote = await submitQuote({
      app,
      token: mmSession.token,
      marketMakerKeypair: mm,
      marketMakerWallet: mmSession.walletAddress,
      rfqId: rfq.id,
    });

    const forbiddenRes = await app.inject({
      method: "POST",
      url: "/settlements/accept",
      headers: {
        authorization: `Bearer ${complianceSession.token}`,
      },
      payload: {
        quoteId: quote.id,
      },
    });
    assert.equal(forbiddenRes.statusCode, 403);

    const acceptRes = await app.inject({
      method: "POST",
      url: "/settlements/accept",
      headers: {
        authorization: `Bearer ${institutionSession.token}`,
      },
      payload: {
        quoteId: quote.id,
      },
    });
    assert.equal(acceptRes.statusCode, 201);
    const settlementId = acceptRes.json().id;

    const duplicateRes = await app.inject({
      method: "POST",
      url: "/settlements/accept",
      headers: {
        authorization: `Bearer ${institutionSession.token}`,
      },
      payload: {
        quoteId: quote.id,
      },
    });
    assert.equal(duplicateRes.statusCode, 409);

    const startAsComplianceRes = await app.inject({
      method: "POST",
      url: `/settlements/${settlementId}/start`,
      headers: {
        authorization: `Bearer ${complianceSession.token}`,
      },
      payload: {
        network: "devnet",
      },
    });
    assert.equal(startAsComplianceRes.statusCode, 403);

    const viewAsMmRes = await app.inject({
      method: "GET",
      url: `/settlements/${settlementId}`,
      headers: {
        authorization: `Bearer ${mmSession.token}`,
      },
    });
    assert.equal(viewAsMmRes.statusCode, 200);
  } finally {
    await app.close();
  }
});
