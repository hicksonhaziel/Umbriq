const test = require("node:test");
const assert = require("node:assert/strict");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const { buildServer } = require("../src/server");
const { buildAuthMessage } = require("../src/lib/auth-message");
const { buildQuoteMessage } = require("../src/lib/quote-message");

const bs58Codec = bs58.default || bs58;

class RfqRealtimeHubSpy {
  constructor() {
    this.broadcasts = [];
  }

  addClient() {}

  broadcastRfqCreated(rfq) {
    this.broadcasts.push(rfq);
  }

  broadcastQuoteSubmitted() {}

  broadcastQuoteExpired() {}
}

async function authenticate(app, role = "institution", keypair = nacl.sign.keyPair()) {
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
    keypair,
  };
}

test("rfq creation flow: API -> RFQ store -> realtime broadcast", async () => {
  const realtimeHubSpy = new RfqRealtimeHubSpy();
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    rfqRealtimeHub: realtimeHubSpy,
  });

  try {
    const { token, walletAddress } = await authenticate(app, "institution");
    const counterpartyA = bs58Codec.encode(nacl.sign.keyPair().publicKey);
    const counterpartyB = bs58Codec.encode(nacl.sign.keyPair().publicKey);

    const createRes = await app.inject({
      method: "POST",
      url: "/rfqs",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        pair: "SOL/USDC",
        side: "buy",
        notionalSize: "1250.50",
        minFillSize: "500.00",
        quoteExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        counterparties: [counterpartyA, counterpartyB],
        encryptedPayload: {
          algorithm: "AES-GCM",
          iv: "x5fJxT2h0Y7R5j9W",
          ciphertext: "ZmFrZS1jaXBoZXJ0ZXh0",
          version: "1",
        },
      },
    });

    assert.equal(createRes.statusCode, 201);
    const created = createRes.json();
    assert.equal(created.pair, "SOL/USDC");
    assert.equal(created.side, "buy");
    assert.equal(created.institutionWallet, walletAddress);
    assert.deepEqual(created.counterparties, [counterpartyA, counterpartyB]);
    assert.equal(created.status, "open");
    assert.ok(created.id);

    assert.equal(realtimeHubSpy.broadcasts.length, 1);
    assert.equal(realtimeHubSpy.broadcasts[0].id, created.id);
    assert.equal(realtimeHubSpy.broadcasts[0].institutionWallet, walletAddress);
  } finally {
    await app.close();
  }
});

test("institution RFQ list supports filters and active quote count", async () => {
  const realtimeHubSpy = new RfqRealtimeHubSpy();
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
    quoteExpiryPollMs: 50,
    rfqRealtimeHub: realtimeHubSpy,
  });

  try {
    const institution = await authenticate(app, "institution");
    const marketMakerKeypair = nacl.sign.keyPair();
    const marketMaker = await authenticate(app, "market_maker", marketMakerKeypair);

    const firstRfqRes = await app.inject({
      method: "POST",
      url: "/rfqs",
      headers: {
        authorization: `Bearer ${institution.token}`,
      },
      payload: {
        pair: "SOL/USDC",
        side: "buy",
        notionalSize: "1250.50",
        minFillSize: "500.00",
        quoteExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        counterparties: [marketMaker.walletAddress],
        encryptedPayload: {
          version: "1",
          ciphertext: "rfq-1",
        },
      },
    });
    assert.equal(firstRfqRes.statusCode, 201);
    const firstRfq = firstRfqRes.json();

    const secondRfqRes = await app.inject({
      method: "POST",
      url: "/rfqs",
      headers: {
        authorization: `Bearer ${institution.token}`,
      },
      payload: {
        pair: "BTC/USDC",
        side: "sell",
        notionalSize: "2000",
        minFillSize: "300",
        quoteExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        counterparties: [marketMaker.walletAddress],
        encryptedPayload: {
          version: "1",
          ciphertext: "rfq-2",
        },
      },
    });
    assert.equal(secondRfqRes.statusCode, 201);

    const validUntil = new Date(Date.now() + 60 * 1000).toISOString();
    const quoteSignature = nacl.sign.detached(
      new TextEncoder().encode(
        buildQuoteMessage({
          rfqId: firstRfq.id,
          marketMakerWallet: marketMaker.walletAddress,
          allInPrice: "101.20",
          guaranteedSize: "400",
          validUntil,
        })
      ),
      marketMaker.keypair.secretKey
    );

    const quoteRes = await app.inject({
      method: "POST",
      url: "/quotes",
      headers: {
        authorization: `Bearer ${marketMaker.token}`,
      },
      payload: {
        rfqId: firstRfq.id,
        allInPrice: "101.20",
        guaranteedSize: "400",
        validUntil,
        signature: bs58Codec.encode(quoteSignature),
        settlementConstraints: {},
        encryptedPayload: {
          version: "1",
          ciphertext: "quote-ciphertext",
        },
      },
    });
    assert.equal(quoteRes.statusCode, 201);

    const filteredListRes = await app.inject({
      method: "GET",
      url: "/rfqs?pair=SOL/USDC",
      headers: {
        authorization: `Bearer ${institution.token}`,
      },
    });
    assert.equal(filteredListRes.statusCode, 200);
    const filteredBody = filteredListRes.json();
    assert.equal(filteredBody.count, 1);
    assert.equal(filteredBody.rfqs[0].id, firstRfq.id);
    assert.equal(filteredBody.rfqs[0].activeQuoteCount, 1);

    const fullListRes = await app.inject({
      method: "GET",
      url: "/rfqs",
      headers: {
        authorization: `Bearer ${institution.token}`,
      },
    });
    assert.equal(fullListRes.statusCode, 200);
    const fullBody = fullListRes.json();
    assert.equal(fullBody.count, 2);
    const countById = Object.fromEntries(
      fullBody.rfqs.map((rfq) => [rfq.id, rfq.activeQuoteCount])
    );
    assert.equal(countById[firstRfq.id], 1);
    assert.equal(countById[secondRfqRes.json().id], 0);
  } finally {
    await app.close();
  }
});
