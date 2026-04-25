const test = require("node:test");
const assert = require("node:assert/strict");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const { buildServer } = require("../src/server");
const { buildAuthMessage } = require("../src/lib/auth-message");
const { buildQuoteMessage } = require("../src/lib/quote-message");

const bs58Codec = bs58.default || bs58;

class RealtimeHubSpy {
  constructor() {
    this.rfqCreated = [];
    this.quoteSubmitted = [];
    this.quoteExpired = [];
  }

  addClient() {}

  broadcastRfqCreated(rfq) {
    this.rfqCreated.push(rfq);
  }

  broadcastQuoteSubmitted(quote) {
    this.quoteSubmitted.push(quote);
  }

  broadcastQuoteExpired(quote) {
    this.quoteExpired.push(quote);
  }
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
  const verifyBody = verifyRes.json();

  return {
    walletAddress,
    token: verifyBody.sessionToken,
  };
}

async function createRfq({
  app,
  token,
  counterparties,
  pair = "SOL/USDC",
  side = "buy",
  notionalSize = "1000",
}) {
  const createRes = await app.inject({
    method: "POST",
    url: "/rfqs",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      pair,
      side,
      notionalSize,
      minFillSize: "100",
      quoteExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      counterparties,
      encryptedPayload: {
        version: "1",
        algorithm: "AES-GCM",
        ciphertext: "base64-ciphertext",
      },
    },
  });

  assert.equal(createRes.statusCode, 201);
  return createRes.json();
}

async function submitQuote({
  app,
  token,
  marketMakerKeypair,
  marketMakerWallet,
  rfqId,
  allInPrice,
  guaranteedSize,
  validUntil,
}) {
  const quoteMessage = buildQuoteMessage({
    rfqId,
    marketMakerWallet,
    allInPrice,
    guaranteedSize,
    validUntil,
  });
  const signature = nacl.sign.detached(
    new TextEncoder().encode(quoteMessage),
    marketMakerKeypair.secretKey
  );

  return app.inject({
    method: "POST",
    url: "/quotes",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      rfqId,
      allInPrice,
      guaranteedSize,
      validUntil,
      signature: bs58Codec.encode(signature),
      settlementConstraints: {
        ttlSeconds: 30,
      },
      encryptedPayload: {
        version: "1",
        algorithm: "AES-GCM",
        ciphertext: "quote-ciphertext",
      },
    },
  });
}

test("quote submission and ranking flow", async () => {
  const realtimeHubSpy = new RealtimeHubSpy();
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    quoteExpiryPollMs: 50,
    rfqRealtimeHub: realtimeHubSpy,
  });

  try {
    const institution = nacl.sign.keyPair();
    const mm1 = nacl.sign.keyPair();
    const mm2 = nacl.sign.keyPair();

    const institutionSession = await authenticate(app, institution, "institution");
    const mm1Session = await authenticate(app, mm1, "market_maker");
    const mm2Session = await authenticate(app, mm2, "market_maker");

    const rfq = await createRfq({
      app,
      token: institutionSession.token,
      side: "buy",
      counterparties: [mm1Session.walletAddress, mm2Session.walletAddress],
    });

    const validUntil = new Date(Date.now() + 60 * 1000).toISOString();
    const quoteARes = await submitQuote({
      app,
      token: mm1Session.token,
      marketMakerKeypair: mm1,
      marketMakerWallet: mm1Session.walletAddress,
      rfqId: rfq.id,
      allInPrice: "101.20",
      guaranteedSize: "400",
      validUntil,
    });
    assert.equal(quoteARes.statusCode, 201);

    const quoteBRes = await submitQuote({
      app,
      token: mm2Session.token,
      marketMakerKeypair: mm2,
      marketMakerWallet: mm2Session.walletAddress,
      rfqId: rfq.id,
      allInPrice: "99.80",
      guaranteedSize: "350",
      validUntil,
    });
    assert.equal(quoteBRes.statusCode, 201);

    const rankedQuotesRes = await app.inject({
      method: "GET",
      url: `/rfqs/${rfq.id}/quotes`,
      headers: {
        authorization: `Bearer ${institutionSession.token}`,
      },
    });
    assert.equal(rankedQuotesRes.statusCode, 200);
    const rankedQuotesBody = rankedQuotesRes.json();
    assert.equal(rankedQuotesBody.count, 2);
    assert.equal(rankedQuotesBody.quotes[0].marketMakerWallet, mm2Session.walletAddress);
    assert.equal(rankedQuotesBody.quotes[0].rank, 1);
    assert.equal(rankedQuotesBody.quotes[1].marketMakerWallet, mm1Session.walletAddress);
    assert.equal(rankedQuotesBody.quotes[1].rank, 2);

    assert.equal(realtimeHubSpy.quoteSubmitted.length, 2);
  } finally {
    await app.close();
  }
});

test("quote expiry flow marks quote as expired and emits event", async () => {
  const realtimeHubSpy = new RealtimeHubSpy();
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    quoteExpiryPollMs: 50,
    rfqRealtimeHub: realtimeHubSpy,
  });

  try {
    const institution = nacl.sign.keyPair();
    const mm = nacl.sign.keyPair();

    const institutionSession = await authenticate(app, institution, "institution");
    const mmSession = await authenticate(app, mm, "market_maker");

    const rfq = await createRfq({
      app,
      token: institutionSession.token,
      side: "buy",
      counterparties: [mmSession.walletAddress],
    });

    const quoteRes = await submitQuote({
      app,
      token: mmSession.token,
      marketMakerKeypair: mm,
      marketMakerWallet: mmSession.walletAddress,
      rfqId: rfq.id,
      allInPrice: "100.10",
      guaranteedSize: "250",
      validUntil: new Date(Date.now() + 200).toISOString(),
    });
    assert.equal(quoteRes.statusCode, 201);

    await sleep(800);

    const rankedQuotesRes = await app.inject({
      method: "GET",
      url: `/rfqs/${rfq.id}/quotes`,
      headers: {
        authorization: `Bearer ${institutionSession.token}`,
      },
    });
    assert.equal(rankedQuotesRes.statusCode, 200);
    assert.equal(rankedQuotesRes.json().count, 0);
    assert.equal(realtimeHubSpy.quoteExpired.length, 1);
    assert.equal(realtimeHubSpy.quoteExpired[0].rfqId, rfq.id);
  } finally {
    await app.close();
  }
});

test("market maker can list incoming RFQs and own quotes", async () => {
  const realtimeHubSpy = new RealtimeHubSpy();
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    quoteExpiryPollMs: 50,
    rfqRealtimeHub: realtimeHubSpy,
  });

  try {
    const institution = nacl.sign.keyPair();
    const mm1 = nacl.sign.keyPair();
    const mm2 = nacl.sign.keyPair();
    const compliance = nacl.sign.keyPair();

    const institutionSession = await authenticate(app, institution, "institution");
    const mm1Session = await authenticate(app, mm1, "market_maker");
    const mm2Session = await authenticate(app, mm2, "market_maker");
    const complianceSession = await authenticate(app, compliance, "compliance");

    const rfqA = await createRfq({
      app,
      token: institutionSession.token,
      side: "sell",
      pair: "SOL/USDC",
      counterparties: [mm1Session.walletAddress, mm2Session.walletAddress],
    });
    await createRfq({
      app,
      token: institutionSession.token,
      side: "buy",
      pair: "BTC/USDC",
      counterparties: [mm2Session.walletAddress],
    });

    const incomingRes = await app.inject({
      method: "GET",
      url: "/rfqs/incoming",
      headers: {
        authorization: `Bearer ${mm1Session.token}`,
      },
    });
    assert.equal(incomingRes.statusCode, 200);
    const incomingBody = incomingRes.json();
    assert.equal(incomingBody.count, 1);
    assert.equal(incomingBody.rfqs[0].id, rfqA.id);
    assert.equal(incomingBody.rfqs[0].canSubmitQuote, true);
    assert.equal(incomingBody.rfqs[0].myQuote, null);

    const validUntil = new Date(Date.now() + 60 * 1000).toISOString();
    const quoteRes = await submitQuote({
      app,
      token: mm1Session.token,
      marketMakerKeypair: mm1,
      marketMakerWallet: mm1Session.walletAddress,
      rfqId: rfqA.id,
      allInPrice: "100.10",
      guaranteedSize: "250",
      validUntil,
    });
    assert.equal(quoteRes.statusCode, 201);

    const incomingAfterQuoteRes = await app.inject({
      method: "GET",
      url: "/rfqs/incoming",
      headers: {
        authorization: `Bearer ${mm1Session.token}`,
      },
    });
    assert.equal(incomingAfterQuoteRes.statusCode, 200);
    const incomingAfterQuoteBody = incomingAfterQuoteRes.json();
    assert.equal(incomingAfterQuoteBody.count, 1);
    assert.equal(incomingAfterQuoteBody.rfqs[0].id, rfqA.id);
    assert.equal(incomingAfterQuoteBody.rfqs[0].canSubmitQuote, false);
    assert.equal(incomingAfterQuoteBody.rfqs[0].myQuote.status, "active");

    const myQuotesRes = await app.inject({
      method: "GET",
      url: "/quotes/mine",
      headers: {
        authorization: `Bearer ${mm1Session.token}`,
      },
    });
    assert.equal(myQuotesRes.statusCode, 200);
    const myQuotesBody = myQuotesRes.json();
    assert.equal(myQuotesBody.count, 1);
    assert.equal(myQuotesBody.quotes[0].rfqId, rfqA.id);
    assert.equal(myQuotesBody.quotes[0].status, "active");
    assert.equal(myQuotesBody.quotes[0].rfq.pair, "SOL/USDC");
    assert.equal(myQuotesBody.quotes[0].rfq.side, "sell");

    const forbiddenIncomingRes = await app.inject({
      method: "GET",
      url: "/rfqs/incoming",
      headers: {
        authorization: `Bearer ${complianceSession.token}`,
      },
    });
    assert.equal(forbiddenIncomingRes.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("market maker own quotes endpoint supports expiry status filter", async () => {
  const realtimeHubSpy = new RealtimeHubSpy();
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    quoteExpiryPollMs: 50,
    rfqRealtimeHub: realtimeHubSpy,
  });

  try {
    const institution = nacl.sign.keyPair();
    const mm = nacl.sign.keyPair();

    const institutionSession = await authenticate(app, institution, "institution");
    const mmSession = await authenticate(app, mm, "market_maker");

    const rfq = await createRfq({
      app,
      token: institutionSession.token,
      side: "buy",
      counterparties: [mmSession.walletAddress],
    });

    const quoteRes = await submitQuote({
      app,
      token: mmSession.token,
      marketMakerKeypair: mm,
      marketMakerWallet: mmSession.walletAddress,
      rfqId: rfq.id,
      allInPrice: "100.20",
      guaranteedSize: "200",
      validUntil: new Date(Date.now() + 200).toISOString(),
    });
    assert.equal(quoteRes.statusCode, 201);

    await sleep(800);

    const expiredQuotesRes = await app.inject({
      method: "GET",
      url: "/quotes/mine?status=expired",
      headers: {
        authorization: `Bearer ${mmSession.token}`,
      },
    });
    assert.equal(expiredQuotesRes.statusCode, 200);
    const expiredQuotesBody = expiredQuotesRes.json();
    assert.equal(expiredQuotesBody.count, 1);
    assert.equal(expiredQuotesBody.quotes[0].status, "expired");

    const invalidStatusRes = await app.inject({
      method: "GET",
      url: "/quotes/mine?status=invalid",
      headers: {
        authorization: `Bearer ${mmSession.token}`,
      },
    });
    assert.equal(invalidStatusRes.statusCode, 400);
  } finally {
    await app.close();
  }
});
