const test = require("node:test");
const assert = require("node:assert/strict");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const { buildServer } = require("../src/server");
const { buildAuthMessage } = require("../src/lib/auth-message");
const bs58Codec = bs58.default || bs58;

test("auth flow end-to-end: nonce -> verify -> session -> dashboard -> logout", async () => {
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
  const signatureBase58 = bs58Codec.encode(signature);

  const verifyRes = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: {
      walletAddress,
      signature: signatureBase58,
      role: "institution",
    },
  });
  assert.equal(verifyRes.statusCode, 200);

  const verifyBody = verifyRes.json();
  assert.equal(verifyBody.role, "institution");
  assert.ok(verifyBody.sessionToken);

  const token = verifyBody.sessionToken;

  const sessionRes = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(sessionRes.statusCode, 200);
  assert.equal(sessionRes.json().walletAddress, walletAddress);

  const dashboardRes = await app.inject({
    method: "GET",
    url: "/dashboard",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(dashboardRes.statusCode, 200);
  assert.equal(dashboardRes.json().umbraReady, false);
  assert.equal(dashboardRes.json().view, "Complete Umbra initialization");

  const logoutRes = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(logoutRes.statusCode, 200);
  assert.equal(logoutRes.json().ok, true);

  const sessionAfterLogoutRes = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(sessionAfterLogoutRes.statusCode, 401);

  await app.close();
});
