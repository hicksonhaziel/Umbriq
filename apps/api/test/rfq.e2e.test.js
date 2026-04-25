const test = require("node:test");
const assert = require("node:assert/strict");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const { buildServer } = require("../src/server");
const { buildAuthMessage } = require("../src/lib/auth-message");

const bs58Codec = bs58.default || bs58;

class RfqRealtimeHubSpy {
  constructor() {
    this.broadcasts = [];
  }

  addClient() {}

  broadcastRfqCreated(rfq) {
    this.broadcasts.push(rfq);
  }
}

async function authenticate(app, role = "institution") {
  const keypair = nacl.sign.keyPair();
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
