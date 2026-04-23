const { randomUUID } = require("node:crypto");
const fastify = require("fastify");
const cors = require("@fastify/cors");
const fastifyRedis = require("@fastify/redis");
const { PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");
const nacl = require("tweetnacl");
const { buildAuthMessage } = require("./lib/auth-message");
const { InMemorySessionStore, RedisSessionStore } = require("./lib/session-store");
const {
  VALID_UMBRA_STATUS,
  InMemoryUmbraAccountStore,
  RedisUmbraAccountStore,
} = require("./lib/umbra-account-store");

const VALID_ROLES = ["institution", "market_maker", "compliance"];
const NONCE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 8;
const bs58Codec = bs58.default || bs58;

function getAuthToken(request) {
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }

  const sessionHeader = request.headers["x-session-token"];
  if (typeof sessionHeader === "string" && sessionHeader.trim().length > 0) {
    return sessionHeader.trim();
  }

  return null;
}

async function buildServer(options = {}) {
  const app = fastify({
    logger: options.logger ?? true,
  });

  await app.register(cors, {
    origin: true,
  });

  const nonceStore = new Map();
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
  const useRedis = Boolean(redisUrl) && options.enableRedis !== false;

  if (useRedis) {
    await app.register(fastifyRedis, {
      url: redisUrl,
    });
  }

  const sessionStore = app.redis
    ? new RedisSessionStore(app.redis)
    : new InMemorySessionStore();
  const umbraAccountStore = app.redis
    ? new RedisUmbraAccountStore(app.redis)
    : new InMemoryUmbraAccountStore();

  async function authenticate(request, reply) {
    const token = getAuthToken(request);
    if (!token) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const session = await sessionStore.get(token);
    if (!session) {
      return reply.code(401).send({ error: "Invalid or expired session" });
    }

    request.session = {
      token,
      ...session,
    };
  }

  app.get("/health", async () => {
    return { ok: true };
  });

  app.post("/auth/nonce", async (request, reply) => {
    const walletAddress = request.body?.walletAddress;
    if (typeof walletAddress !== "string" || walletAddress.trim() === "") {
      return reply.code(400).send({ error: "walletAddress is required" });
    }

    try {
      new PublicKey(walletAddress);
    } catch {
      return reply.code(400).send({ error: "Invalid wallet address" });
    }

    const nonce = randomUUID();
    const expiresAt = Date.now() + NONCE_TTL_MS;
    const message = buildAuthMessage(walletAddress, nonce);

    nonceStore.set(walletAddress, {
      nonce,
      expiresAt,
      used: false,
    });

    return {
      walletAddress,
      nonce,
      message,
      expiresAt,
    };
  });

  app.post("/auth/verify", async (request, reply) => {
    const walletAddress = request.body?.walletAddress;
    const signature = request.body?.signature;
    const role = request.body?.role;

    if (
      typeof walletAddress !== "string" ||
      typeof signature !== "string" ||
      typeof role !== "string"
    ) {
      return reply.code(400).send({
        error: "walletAddress, signature and role are required",
      });
    }

    if (!VALID_ROLES.includes(role)) {
      return reply.code(400).send({
        error: `Invalid role. Valid roles: ${VALID_ROLES.join(", ")}`,
      });
    }

    const nonceRecord = nonceStore.get(walletAddress);
    if (!nonceRecord || nonceRecord.used || nonceRecord.expiresAt <= Date.now()) {
      return reply.code(401).send({
        error: "Nonce missing or expired. Request a new nonce.",
      });
    }

    const message = buildAuthMessage(walletAddress, nonceRecord.nonce);

    let isValid = false;
    try {
      const publicKey = new PublicKey(walletAddress);
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = bs58Codec.decode(signature);
      isValid = nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKey.toBytes()
      );
    } catch {
      isValid = false;
    }

    if (!isValid) {
      return reply.code(401).send({ error: "Signature verification failed" });
    }

    nonceRecord.used = true;

    const ttlSeconds = Number(process.env.SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
    const { token, expiresAt } = await sessionStore.create(
      {
        walletAddress,
        role,
      },
      ttlSeconds
    );

    return {
      sessionToken: token,
      walletAddress,
      role,
      expiresAt,
    };
  });

  app.get("/auth/session", { preHandler: authenticate }, async (request) => {
    return {
      walletAddress: request.session.walletAddress,
      role: request.session.role,
      expiresAt: request.session.expiresAt,
    };
  });

  app.post("/auth/logout", { preHandler: authenticate }, async (request) => {
    await sessionStore.destroy(request.session.token);
    return { ok: true };
  });

  app.get("/umbra/account", { preHandler: authenticate }, async (request) => {
    const state = await umbraAccountStore.get(
      request.session.walletAddress,
      request.session.role
    );
    return state;
  });

  app.post("/umbra/account", { preHandler: authenticate }, async (request, reply) => {
    const status = request.body?.status;
    const network = request.body?.network;
    const registrationSignatures = request.body?.registrationSignatures;
    const accountState = request.body?.accountState;
    const lastError = request.body?.lastError;

    if (typeof status !== "string" || !VALID_UMBRA_STATUS.includes(status)) {
      return reply.code(400).send({
        error: `Invalid status. Valid values: ${VALID_UMBRA_STATUS.join(", ")}`,
      });
    }

    const updated = await umbraAccountStore.upsert(
      request.session.walletAddress,
      request.session.role,
      {
        status,
        network: typeof network === "string" ? network : "devnet",
        registrationSignatures: Array.isArray(registrationSignatures)
          ? registrationSignatures.filter((value) => typeof value === "string")
          : [],
        accountState:
          accountState && typeof accountState === "object"
            ? {
                isInitialised: Boolean(accountState.isInitialised),
                isActiveForAnonymousUsage: Boolean(
                  accountState.isActiveForAnonymousUsage
                ),
                isUserCommitmentRegistered: Boolean(
                  accountState.isUserCommitmentRegistered
                ),
                isUserAccountX25519KeyRegistered: Boolean(
                  accountState.isUserAccountX25519KeyRegistered
                ),
              }
            : null,
        lastError: typeof lastError === "string" ? lastError : null,
      }
    );

    return updated;
  });

  app.get("/dashboard", { preHandler: authenticate }, async (request) => {
    const role = request.session.role;
    const umbraAccount = await umbraAccountStore.get(
      request.session.walletAddress,
      request.session.role
    );
    const umbraReady = umbraAccount.status === "initialized";
    const viewByRole = {
      institution: "Institution dashboard",
      market_maker: "Market maker dashboard",
      compliance: "Compliance dashboard",
    };

    return {
      walletAddress: request.session.walletAddress,
      role,
      view: umbraReady ? viewByRole[role] : "Complete Umbra initialization",
      umbraReady,
      umbraStatus: umbraAccount.status,
    };
  });

  return app;
}

module.exports = {
  buildServer,
  VALID_ROLES,
};
