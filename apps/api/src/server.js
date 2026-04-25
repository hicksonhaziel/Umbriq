const { randomUUID } = require("node:crypto");
const fastify = require("fastify");
const cors = require("@fastify/cors");
const fastifyRedis = require("@fastify/redis");
const fastifyWebsocket = require("@fastify/websocket");
const { PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");
const nacl = require("tweetnacl");
const { buildAuthMessage } = require("./lib/auth-message");
const { InMemorySessionStore, RedisSessionStore } = require("./lib/session-store");
const { validateRfqCreatePayload } = require("./lib/rfq-validation");
const { InMemoryRfqStore, createPostgresRfqStore } = require("./lib/rfq-store");
const { validateQuoteCreatePayload } = require("./lib/quote-validation");
const { verifyQuoteSignature } = require("./lib/quote-message");
const { rankQuotes } = require("./lib/quote-ranking");
const { InMemoryQuoteStore, createPostgresQuoteStore } = require("./lib/quote-store");
const { QuoteExpiryService } = require("./lib/quote-expiry-service");
const { RfqRealtimeHub } = require("./lib/rfq-realtime");
const {
  VALID_UMBRA_STATUS,
  InMemoryUmbraAccountStore,
  RedisUmbraAccountStore,
} = require("./lib/umbra-account-store");

const VALID_ROLES = ["institution", "market_maker", "compliance"];
const NONCE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 8;
const DEFAULT_QUOTE_EXPIRY_POLL_MS = 1000;
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

function resolveWebsocketConnection(connection) {
  if (connection && typeof connection.send === "function") {
    return connection;
  }
  if (connection && connection.socket && typeof connection.socket.send === "function") {
    return connection.socket;
  }
  return null;
}

function closeWebsocket(socket, code, reason) {
  if (!socket || typeof socket.close !== "function") {
    return;
  }
  try {
    socket.close(code, reason);
  } catch {}
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NaN;
}

async function buildServer(options = {}) {
  const app = fastify({
    logger: options.logger ?? true,
  });

  await app.register(cors, {
    origin: true,
  });
  await app.register(fastifyWebsocket);

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
  const rfqStore = options.rfqStore
    ? options.rfqStore
    : options.enablePostgres === false || !(options.databaseUrl || process.env.DATABASE_URL)
      ? new InMemoryRfqStore()
      : createPostgresRfqStore({
          connectionString: options.databaseUrl || process.env.DATABASE_URL,
        });
  const quoteStore = options.quoteStore
    ? options.quoteStore
    : options.enablePostgres === false || !(options.databaseUrl || process.env.DATABASE_URL)
      ? new InMemoryQuoteStore()
      : createPostgresQuoteStore({
          connectionString: options.databaseUrl || process.env.DATABASE_URL,
        });
  const rfqRealtimeHub = options.rfqRealtimeHub || new RfqRealtimeHub();
  const quoteExpiryService = new QuoteExpiryService({
    quoteStore,
    redis: app.redis || null,
    pollMs: options.quoteExpiryPollMs || DEFAULT_QUOTE_EXPIRY_POLL_MS,
    onQuoteExpired: async (quote) => {
      rfqRealtimeHub.broadcastQuoteExpired(quote);
    },
    logger: app.log,
  });
  quoteExpiryService.start();

  app.addHook("onClose", async () => {
    quoteExpiryService.stop();
    if (typeof rfqStore.close === "function") {
      await rfqStore.close();
    }
    if (typeof quoteStore.close === "function") {
      await quoteStore.close();
    }
  });

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

  app.post("/rfqs", { preHandler: authenticate }, async (request, reply) => {
    const validated = validateRfqCreatePayload(request.body);
    if (validated.error) {
      return reply.code(400).send({ error: validated.error });
    }

    try {
      const created = await rfqStore.create({
        institutionWallet: request.session.walletAddress,
        ...validated.value,
      });
      rfqRealtimeHub.broadcastRfqCreated(created);
      return reply.code(201).send(created);
    } catch (error) {
      request.log.error({ error }, "Failed to create RFQ");
      const detail =
        error && typeof error.message === "string" ? error.message : "Unknown error";
      const code = error && typeof error.code === "string" ? error.code : null;
      return reply.code(500).send({
        error: "Failed to create RFQ",
        ...(process.env.NODE_ENV !== "production"
          ? {
              detail,
              code,
            }
          : {}),
      });
    }
  });

  app.post("/quotes", { preHandler: authenticate }, async (request, reply) => {
    if (request.session.role !== "market_maker") {
      return reply.code(403).send({
        error: "Only market_maker role can submit quotes",
      });
    }

    const validated = validateQuoteCreatePayload(request.body);
    if (validated.error) {
      return reply.code(400).send({ error: validated.error });
    }

    const rfq = await rfqStore.getById(validated.value.rfqId);
    if (!rfq) {
      return reply.code(404).send({ error: "RFQ not found" });
    }

    if (!["open", "quoted"].includes(rfq.status)) {
      return reply.code(409).send({
        error: `RFQ is not quotable. Current status: ${rfq.status}`,
      });
    }

    const rfqExpiryMs = Date.parse(rfq.quoteExpiresAt);
    const validUntilMs = Date.parse(validated.value.validUntil);
    const nowMs = Date.now();

    if (validUntilMs <= nowMs) {
      return reply.code(400).send({
        error: "validUntil must be in the future",
      });
    }

    if (validUntilMs > rfqExpiryMs) {
      return reply.code(400).send({
        error: "validUntil cannot exceed RFQ quote expiry",
      });
    }

    if (rfqExpiryMs <= nowMs) {
      return reply.code(409).send({
        error: "RFQ quote window has expired",
      });
    }

    const allowedCounterparties = Array.isArray(rfq.counterparties) ? rfq.counterparties : [];
    if (!allowedCounterparties.includes(request.session.walletAddress)) {
      return reply.code(403).send({
        error: "Market maker is not allowlisted for this RFQ",
      });
    }

    const guaranteedSize = toNumber(validated.value.guaranteedSize);
    const notionalSize = toNumber(rfq.notionalSize);
    if (!Number.isFinite(guaranteedSize) || !Number.isFinite(notionalSize)) {
      return reply.code(400).send({
        error: "Invalid guaranteedSize or RFQ notional size",
      });
    }
    if (guaranteedSize > notionalSize) {
      return reply.code(400).send({
        error: "guaranteedSize cannot exceed RFQ notional size",
      });
    }

    const signatureValid = verifyQuoteSignature({
      rfqId: validated.value.rfqId,
      marketMakerWallet: request.session.walletAddress,
      allInPrice: validated.value.allInPrice,
      guaranteedSize: validated.value.guaranteedSize,
      validUntil: validated.value.validUntil,
      signature: validated.value.signature,
    });
    if (!signatureValid) {
      return reply.code(401).send({
        error: "Quote signature verification failed",
      });
    }

    try {
      const created = await quoteStore.create({
        rfqId: validated.value.rfqId,
        marketMakerWallet: request.session.walletAddress,
        allInPrice: validated.value.allInPrice,
        guaranteedSize: validated.value.guaranteedSize,
        validUntil: validated.value.validUntil,
        settlementConstraints: validated.value.settlementConstraints,
        encryptedPayload: validated.value.encryptedPayload,
        signature: validated.value.signature,
      });

      await rfqStore.markQuoted(validated.value.rfqId);
      await quoteExpiryService.scheduleQuote(created);
      rfqRealtimeHub.broadcastQuoteSubmitted(created);
      return reply.code(201).send(created);
    } catch (error) {
      request.log.error({ error }, "Failed to submit quote");
      if (error && error.code === "23505") {
        return reply.code(409).send({
          error: "Quote already submitted for this RFQ by this market maker",
        });
      }
      const detail =
        error && typeof error.message === "string" ? error.message : "Unknown error";
      const code = error && typeof error.code === "string" ? error.code : null;
      return reply.code(500).send({
        error: "Failed to submit quote",
        ...(process.env.NODE_ENV !== "production"
          ? {
              detail,
              code,
            }
          : {}),
      });
    }
  });

  app.get("/rfqs/:rfqId/quotes", { preHandler: authenticate }, async (request, reply) => {
    const rfqId = request.params?.rfqId;
    if (typeof rfqId !== "string" || rfqId.trim().length === 0) {
      return reply.code(400).send({
        error: "rfqId is required",
      });
    }

    await quoteExpiryService.sweepOnce();

    const rfq = await rfqStore.getById(rfqId);
    if (!rfq) {
      return reply.code(404).send({
        error: "RFQ not found",
      });
    }

    if (
      request.session.role === "institution" &&
      request.session.walletAddress !== rfq.institutionWallet
    ) {
      return reply.code(403).send({
        error: "Institutions can only view quotes for their own RFQs",
      });
    }

    if (!["institution", "compliance"].includes(request.session.role)) {
      return reply.code(403).send({
        error: "Only institution or compliance roles can view ranked quotes",
      });
    }

    const activeQuotes = await quoteStore.getActiveByRfqId(rfqId);
    const ranked = rankQuotes(activeQuotes, rfq.side);

    return {
      rfqId,
      rfqSide: rfq.side,
      count: ranked.length,
      quotes: ranked,
    };
  });

  app.get("/ws/rfqs", { websocket: true }, async (connection, request) => {
    const socket = resolveWebsocketConnection(connection);

    const queryToken =
      request.query && typeof request.query.token === "string"
        ? request.query.token.trim()
        : "";
    const token = queryToken || getAuthToken(request);
    if (!token) {
      closeWebsocket(socket, 1008, "Unauthorized");
      return;
    }

    const session = await sessionStore.get(token);
    if (!session) {
      closeWebsocket(socket, 1008, "Invalid or expired session");
      return;
    }

    if (!socket) {
      request.log.error("Websocket route failed to resolve socket instance");
      return;
    }

    rfqRealtimeHub.addClient(socket, session);
    socket.send(
      JSON.stringify({
        event: "rfq.subscribed",
        payload: {
          walletAddress: session.walletAddress,
          role: session.role,
        },
      })
    );
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
