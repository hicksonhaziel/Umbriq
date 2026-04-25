const test = require("node:test");
const assert = require("node:assert/strict");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const { buildServer } = require("../src/server");
const { buildAuthMessage } = require("../src/lib/auth-message");
const { buildQuoteMessage } = require("../src/lib/quote-message");

const bs58Codec = bs58.default || bs58;

class RealtimeHubSpy {
  addClient() {}
  broadcast() {}
  broadcastRfqCreated() {}
  broadcastQuoteSubmitted() {}
  broadcastQuoteExpired() {}
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  settlementConstraints = {},
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
      settlementConstraints,
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

async function waitForSettlementStatus({
  app,
  token,
  settlementId,
  targetStatus,
  timeoutMs = 5000,
}) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const response = await app.inject({
      method: "GET",
      url: `/settlements/${settlementId}`,
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    assert.equal(response.statusCode, 200);
    const settlement = response.json();
    if (settlement.status === targetStatus) {
      return settlement;
    }
    await sleep(50);
  }

  throw new Error(`Timed out waiting for settlement status ${targetStatus}`);
}

test("settlement orchestration success flow", async () => {
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    settlementStartDelayMs: 20,
    settlementConfirmDelayMs: 40,
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

    const settled = await waitForSettlementStatus({
      app,
      token: institutionSession.token,
      settlementId: accepted.id,
      targetStatus: "settled",
    });

    assert.ok(settled.umbraTxSignature);
    assert.equal(settled.rfq.status, "settled");
    assert.equal(settled.quote.status, "accepted");
    assert.ok(settled.receipt.confirmedAt);
  } finally {
    await app.close();
  }
});

test("settlement orchestration failure updates statuses and error", async () => {
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    settlementStartDelayMs: 20,
    settlementConfirmDelayMs: 40,
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
      settlementConstraints: {
        simulateFailure: true,
      },
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

    const failed = await waitForSettlementStatus({
      app,
      token: institutionSession.token,
      settlementId: acceptRes.json().id,
      targetStatus: "failed",
    });

    assert.equal(failed.rfq.status, "failed");
    assert.equal(failed.quote.status, "rejected");
    assert.match(failed.errorMessage, /Simulated settlement failure/);
  } finally {
    await app.close();
  }
});

test("settlement access control and duplicate acceptance protection", async () => {
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    settlementStartDelayMs: 20,
    settlementConfirmDelayMs: 40,
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
