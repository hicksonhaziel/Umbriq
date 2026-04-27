const test = require("node:test");
const assert = require("node:assert/strict");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const { buildServer } = require("../src/server");
const { buildAuthMessage } = require("../src/lib/auth-message");

const bs58Codec = bs58.default || bs58;

test("auth + Umbra setup integration flow", async () => {
  const app = await buildServer({
    logger: false,
    enableRedis: false,
  });

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
      role: "institution",
    },
  });
  assert.equal(verifyRes.statusCode, 200);
  const token = verifyRes.json().sessionToken;

  const initialUmbraRes = await app.inject({
    method: "GET",
    url: "/umbra/account",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(initialUmbraRes.statusCode, 200);
  assert.equal(initialUmbraRes.json().status, "not_initialized");

  const initializingUmbraRes = await app.inject({
    method: "POST",
    url: "/umbra/account",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      network: "devnet",
      status: "initializing",
      registrationSignatures: [],
      accountState: null,
      lastError: null,
    },
  });
  assert.equal(initializingUmbraRes.statusCode, 200);
  assert.equal(initializingUmbraRes.json().status, "initializing");

  const initializedUmbraRes = await app.inject({
    method: "POST",
    url: "/umbra/account",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      network: "devnet",
      status: "initialized",
      registrationSignatures: ["sigA", "sigB"],
      accountState: {
        isInitialised: true,
        isActiveForAnonymousUsage: true,
        isUserCommitmentRegistered: true,
        isUserAccountX25519KeyRegistered: true,
      },
      lastError: null,
    },
  });
  assert.equal(initializedUmbraRes.statusCode, 200);
  assert.equal(initializedUmbraRes.json().status, "initialized");

  const dashboardRes = await app.inject({
    method: "GET",
    url: "/dashboard",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(dashboardRes.statusCode, 200);
  assert.equal(dashboardRes.json().umbraReady, true);
  assert.equal(dashboardRes.json().view, "Institution dashboard");

  const mainnetUmbraRes = await app.inject({
    method: "GET",
    url: "/umbra/account?network=mainnet",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(mainnetUmbraRes.statusCode, 200);
  assert.equal(mainnetUmbraRes.json().network, "mainnet");
  assert.equal(mainnetUmbraRes.json().status, "not_initialized");

  const mainnetDashboardRes = await app.inject({
    method: "GET",
    url: "/dashboard?network=mainnet",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(mainnetDashboardRes.statusCode, 200);
  assert.equal(mainnetDashboardRes.json().network, "mainnet");
  assert.equal(mainnetDashboardRes.json().umbraReady, false);
  assert.equal(mainnetDashboardRes.json().view, "Complete Umbra initialization");

  await app.close();
});
