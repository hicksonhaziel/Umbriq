const { randomUUID, createHash } = require("node:crypto");
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
const {
  validateSettlementAcceptPayload,
  validateSettlementStartPayload,
  validateSettlementCompletePayload,
  validateSettlementFailPayload,
} = require("./lib/settlement-validation");
const {
  InMemorySettlementStore,
  createPostgresSettlementStore,
} = require("./lib/settlement-store");
const { SettlementOrchestrationService } = require("./lib/settlement-orchestration-service");
const { RfqRealtimeHub } = require("./lib/rfq-realtime");
const {
  VALID_UMBRA_STATUS,
  InMemoryUmbraAccountStore,
  RedisUmbraAccountStore,
} = require("./lib/umbra-account-store");
const {
  isSupportedUmbraNetwork,
  resolveUmbraNetwork,
  getUmbraNetworkConfig,
  getAllUmbraNetworkConfigs,
  decimalToBaseUnits,
} = require("./lib/umbra-network-config");

const VALID_ROLES = ["institution", "market_maker", "compliance"];
const VALID_QUOTE_STATUSES = ["active", "expired", "rejected", "accepted", "withdrawn"];
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

function getRequestedNetwork(value) {
  return resolveUmbraNetwork(typeof value === "string" ? value.trim() : undefined);
}

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildSettlementProofDigest(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function validateSettlementExecutionResult({
  settlement,
  institutionWallet,
  quote,
  network,
  umbraTxSignature,
  receipt,
  proof,
}) {
  if (!isSupportedUmbraNetwork(network)) {
    return `Unsupported settlement network: ${network}`;
  }

  if (typeof umbraTxSignature !== "string" || umbraTxSignature.trim().length === 0) {
    return "umbraTxSignature is required";
  }

  if (!isObjectRecord(receipt)) {
    return "receipt must be an object";
  }

  if (!isObjectRecord(proof)) {
    return "proof must be an object";
  }

  const networkConfig = getUmbraNetworkConfig(network);
  const expectedAmountBaseUnits = decimalToBaseUnits(
    quote.guaranteedSize,
    networkConfig.mintDecimals
  );

  if (receipt.provider !== "umbra-sdk") {
    return "receipt.provider must be umbra-sdk";
  }
  if (receipt.executionModel !== "browser") {
    return "receipt.executionModel must be browser";
  }
  if (receipt.network !== network) {
    return "receipt.network does not match the selected settlement network";
  }
  if (receipt.signerAddress !== institutionWallet) {
    return "receipt.signerAddress must match the authenticated institution wallet";
  }
  if (receipt.destinationAddress !== quote.marketMakerWallet) {
    return "receipt.destinationAddress must match the accepted market maker wallet";
  }
  if (receipt.mint !== networkConfig.mint) {
    return "receipt.mint does not match the configured settlement mint for this network";
  }
  if (Number(receipt.mintDecimals) !== Number(networkConfig.mintDecimals)) {
    return "receipt.mintDecimals does not match the configured settlement mint decimals";
  }
  if (String(receipt.amountBaseUnits) !== String(expectedAmountBaseUnits)) {
    return "receipt.amountBaseUnits does not match the accepted quote size";
  }

  if (proof.type !== "umbra-settlement-proof-v1") {
    return "proof.type must be umbra-settlement-proof-v1";
  }
  if (proof.hashAlgorithm !== "sha256") {
    return "proof.hashAlgorithm must be sha256";
  }
  if (!isObjectRecord(proof.payload)) {
    return "proof.payload must be an object";
  }

  const expectedDigest = buildSettlementProofDigest(proof.payload);
  if (proof.digest !== expectedDigest) {
    return "proof.digest does not match proof.payload";
  }

  if (proof.payload.network !== network) {
    return "proof payload network does not match the selected settlement network";
  }
  if (proof.payload.settlementId !== settlement.id) {
    return "proof payload settlementId does not match the settlement";
  }
  if (proof.payload.rfqId !== settlement.rfqId) {
    return "proof payload rfqId does not match the settlement";
  }
  if (proof.payload.quoteId !== settlement.quoteId) {
    return "proof payload quoteId does not match the settlement";
  }
  if (proof.payload.mint !== networkConfig.mint) {
    return "proof payload mint does not match the configured settlement mint";
  }
  if (String(proof.payload.amountBaseUnits) !== String(expectedAmountBaseUnits)) {
    return "proof payload amount does not match the accepted quote size";
  }
  if (proof.payload.signerAddress !== institutionWallet) {
    return "proof payload signerAddress must match the authenticated institution wallet";
  }
  if (proof.payload.destinationAddress !== quote.marketMakerWallet) {
    return "proof payload destinationAddress must match the accepted market maker wallet";
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
  const settlementStore = options.settlementStore
    ? options.settlementStore
    : options.enablePostgres === false || !(options.databaseUrl || process.env.DATABASE_URL)
      ? new InMemorySettlementStore()
      : createPostgresSettlementStore({
          connectionString: options.databaseUrl || process.env.DATABASE_URL,
        });
  const quoteExpiryService = new QuoteExpiryService({
    quoteStore,
    redis: app.redis || null,
    pollMs: options.quoteExpiryPollMs || DEFAULT_QUOTE_EXPIRY_POLL_MS,
    onQuoteExpired: async (quote) => {
      rfqRealtimeHub.broadcastQuoteExpired(quote);
    },
    logger: app.log,
  });
  const settlementOrchestrationService = new SettlementOrchestrationService({
    settlementStore,
    quoteStore,
    rfqStore,
    rfqRealtimeHub,
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
    if (typeof settlementStore.close === "function") {
      await settlementStore.close();
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

  app.get("/rfqs", { preHandler: authenticate }, async (request, reply) => {
    if (request.session.role !== "institution") {
      return reply.code(403).send({
        error: "Only institution role can view institution RFQ list",
      });
    }

    await quoteExpiryService.sweepOnce();

    const pair =
      typeof request.query?.pair === "string" ? request.query.pair : undefined;
    const side =
      typeof request.query?.side === "string" ? request.query.side : undefined;

    const rfqs = await rfqStore.listByInstitutionWallet(request.session.walletAddress, {
      pair,
      side,
    });

    const countsByRfqId = await quoteStore.getActiveCountByRfqIds(
      rfqs.map((rfq) => rfq.id)
    );

    return {
      count: rfqs.length,
      rfqs: rfqs.map((rfq) => ({
        ...rfq,
        activeQuoteCount: countsByRfqId[rfq.id] || 0,
      })),
    };
  });

  app.get("/rfqs/incoming", { preHandler: authenticate }, async (request, reply) => {
    if (request.session.role !== "market_maker") {
      return reply.code(403).send({
        error: "Only market_maker role can view incoming RFQs",
      });
    }

    await quoteExpiryService.sweepOnce();

    const pair =
      typeof request.query?.pair === "string" ? request.query.pair : undefined;
    const side =
      typeof request.query?.side === "string" ? request.query.side : undefined;

    const rfqs = await rfqStore.listIncomingForMarketMaker(request.session.walletAddress, {
      pair,
      side,
    });

    const myQuotes = await quoteStore.listByMarketMakerWallet(request.session.walletAddress);
    const quoteByRfqId = new Map();
    for (const quote of myQuotes) {
      if (!quoteByRfqId.has(quote.rfqId)) {
        quoteByRfqId.set(quote.rfqId, quote);
      }
    }

    return {
      count: rfqs.length,
      rfqs: rfqs.map((rfq) => {
        const myQuote = quoteByRfqId.get(rfq.id) || null;
        return {
          ...rfq,
          canSubmitQuote: !myQuote,
          myQuote: myQuote
            ? {
                id: myQuote.id,
                allInPrice: myQuote.allInPrice,
                guaranteedSize: myQuote.guaranteedSize,
                validUntil: myQuote.validUntil,
                status: myQuote.status,
                createdAt: myQuote.createdAt,
                updatedAt: myQuote.updatedAt,
              }
            : null,
        };
      }),
    };
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

  app.get("/quotes/mine", { preHandler: authenticate }, async (request, reply) => {
    if (request.session.role !== "market_maker") {
      return reply.code(403).send({
        error: "Only market_maker role can view own quotes",
      });
    }

    await quoteExpiryService.sweepOnce();

    const status =
      typeof request.query?.status === "string" ? request.query.status.trim() : "";
    if (status && !VALID_QUOTE_STATUSES.includes(status)) {
      return reply.code(400).send({
        error: `Invalid status. Valid values: ${VALID_QUOTE_STATUSES.join(", ")}`,
      });
    }

    const quotes = await quoteStore.listByMarketMakerWallet(request.session.walletAddress, {
      status: status || undefined,
    });

    const rfqIds = Array.from(new Set(quotes.map((quote) => quote.rfqId)));
    const rfqEntries = await Promise.all(
      rfqIds.map(async (rfqId) => [rfqId, await rfqStore.getById(rfqId)])
    );
    const rfqById = new Map(rfqEntries);

    return {
      count: quotes.length,
      quotes: quotes.map((quote) => {
        const rfq = rfqById.get(quote.rfqId) || null;
        return {
          ...quote,
          rfq: rfq
            ? {
                id: rfq.id,
                institutionWallet: rfq.institutionWallet,
                pair: rfq.pair,
                side: rfq.side,
                notionalSize: rfq.notionalSize,
                minFillSize: rfq.minFillSize,
                quoteExpiresAt: rfq.quoteExpiresAt,
                status: rfq.status,
              }
            : null,
        };
      }),
    };
  });

  app.post("/settlements/accept", { preHandler: authenticate }, async (request, reply) => {
    if (request.session.role !== "institution") {
      return reply.code(403).send({
        error: "Only institution role can accept quotes for settlement",
      });
    }

    const validated = validateSettlementAcceptPayload(request.body);
    if (validated.error) {
      return reply.code(400).send({ error: validated.error });
    }

    await quoteExpiryService.sweepOnce();

    const quote = await quoteStore.getById(validated.value.quoteId);
    if (!quote) {
      return reply.code(404).send({
        error: "Quote not found",
      });
    }

    if (quote.status !== "active") {
      return reply.code(409).send({
        error: `Quote is not active. Current status: ${quote.status}`,
      });
    }

    if (Date.parse(quote.validUntil) <= Date.now()) {
      return reply.code(409).send({
        error: "Quote has expired",
      });
    }

    const rfq = await rfqStore.getById(quote.rfqId);
    if (!rfq) {
      return reply.code(404).send({
        error: "RFQ not found for quote",
      });
    }

    if (rfq.institutionWallet !== request.session.walletAddress) {
      return reply.code(403).send({
        error: "Institutions can only accept quotes for their own RFQs",
      });
    }

    if (Date.parse(rfq.quoteExpiresAt) <= Date.now()) {
      return reply.code(409).send({
        error: "RFQ quote window has expired",
      });
    }

    const existingSettlement = await settlementStore.getByQuoteId(quote.id);
    if (existingSettlement) {
      return reply.code(409).send({
        error: "Settlement already exists for this quote",
        settlementId: existingSettlement.id,
      });
    }

    try {
      await quoteStore.updateStatus(quote.id, "accepted");
      await rfqStore.updateStatus(rfq.id, "accepted");

      const created = await settlementStore.create({
        rfqId: rfq.id,
        quoteId: quote.id,
        status: "accepted",
        receipt: {},
        proof: {},
      });

      if (typeof rfqRealtimeHub.broadcast === "function") {
        rfqRealtimeHub.broadcast("settlement.accepted", {
          id: created.id,
          rfqId: created.rfqId,
          quoteId: created.quoteId,
          status: created.status,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        });
      }
      return reply.code(201).send(created);
    } catch (error) {
      request.log.error({ error }, "Failed to accept quote for settlement");
      if (error && error.code === "23505") {
        return reply.code(409).send({
          error: "Settlement already exists for this quote",
        });
      }
      const detail =
        error && typeof error.message === "string" ? error.message : "Unknown error";
      const code = error && typeof error.code === "string" ? error.code : null;
      return reply.code(500).send({
        error: "Failed to accept quote",
        ...(process.env.NODE_ENV !== "production"
          ? {
              detail,
              code,
            }
          : {}),
      });
    }
  });

  app.post("/settlements/:settlementId/start", { preHandler: authenticate }, async (request, reply) => {
    if (request.session.role !== "institution") {
      return reply.code(403).send({
        error: "Only institution role can start settlement execution",
      });
    }

    const settlementId = request.params?.settlementId;
    if (typeof settlementId !== "string" || settlementId.trim().length === 0) {
      return reply.code(400).send({
        error: "settlementId is required",
      });
    }

    const validated = validateSettlementStartPayload(request.body);
    if (validated.error) {
      return reply.code(400).send({ error: validated.error });
    }

    const network = validated.value.network;
    if (!isSupportedUmbraNetwork(network)) {
      return reply.code(400).send({
        error: "network must be devnet or mainnet",
      });
    }

    const settlement = await settlementStore.getById(settlementId.trim());
    if (!settlement) {
      return reply.code(404).send({ error: "Settlement not found" });
    }

    const rfq = await rfqStore.getById(settlement.rfqId);
    const quote = await quoteStore.getById(settlement.quoteId);
    if (!rfq || !quote) {
      return reply.code(404).send({ error: "Settlement dependencies not found" });
    }

    if (rfq.institutionWallet !== request.session.walletAddress) {
      return reply.code(403).send({
        error: "Institutions can only start their own settlements",
      });
    }

    if (!["accepted", "failed"].includes(settlement.status)) {
      return reply.code(409).send({
        error: `Settlement cannot be started from status ${settlement.status}`,
      });
    }

    const started = await settlementOrchestrationService.start(settlement.id);
    return reply.send({
      ...started,
      executionModel: "browser",
      network,
      rfq: {
        id: rfq.id,
        institutionWallet: rfq.institutionWallet,
        pair: rfq.pair,
        side: rfq.side,
        status: rfq.status,
        quoteExpiresAt: rfq.quoteExpiresAt,
      },
      quote: {
        id: quote.id,
        marketMakerWallet: quote.marketMakerWallet,
        allInPrice: quote.allInPrice,
        guaranteedSize: quote.guaranteedSize,
        status: quote.status,
        validUntil: quote.validUntil,
      },
    });
  });

  app.post("/settlements/:settlementId/complete", { preHandler: authenticate }, async (request, reply) => {
    if (request.session.role !== "institution") {
      return reply.code(403).send({
        error: "Only institution role can complete settlement execution",
      });
    }

    const settlementId = request.params?.settlementId;
    if (typeof settlementId !== "string" || settlementId.trim().length === 0) {
      return reply.code(400).send({
        error: "settlementId is required",
      });
    }

    const validated = validateSettlementCompletePayload(request.body);
    if (validated.error) {
      return reply.code(400).send({ error: validated.error });
    }

    const settlement = await settlementStore.getById(settlementId.trim());
    if (!settlement) {
      return reply.code(404).send({ error: "Settlement not found" });
    }

    const rfq = await rfqStore.getById(settlement.rfqId);
    const quote = await quoteStore.getById(settlement.quoteId);
    if (!rfq || !quote) {
      return reply.code(404).send({ error: "Settlement dependencies not found" });
    }

    if (rfq.institutionWallet !== request.session.walletAddress) {
      return reply.code(403).send({
        error: "Institutions can only complete their own settlements",
      });
    }

    if (settlement.status !== "settling") {
      return reply.code(409).send({
        error: `Settlement cannot be completed from status ${settlement.status}`,
      });
    }

    const verificationError = validateSettlementExecutionResult({
      settlement,
      institutionWallet: request.session.walletAddress,
      quote,
      network: validated.value.network,
      umbraTxSignature: validated.value.umbraTxSignature,
      receipt: validated.value.receipt,
      proof: validated.value.proof,
    });
    if (verificationError) {
      return reply.code(400).send({ error: verificationError });
    }

    const completed = await settlementOrchestrationService.complete(settlement.id, {
      umbraTxSignature: validated.value.umbraTxSignature,
      receipt: validated.value.receipt,
      proof: validated.value.proof,
    });
    return reply.send(completed);
  });

  app.post("/settlements/:settlementId/fail", { preHandler: authenticate }, async (request, reply) => {
    if (request.session.role !== "institution") {
      return reply.code(403).send({
        error: "Only institution role can fail settlement execution",
      });
    }

    const settlementId = request.params?.settlementId;
    if (typeof settlementId !== "string" || settlementId.trim().length === 0) {
      return reply.code(400).send({
        error: "settlementId is required",
      });
    }

    const validated = validateSettlementFailPayload(request.body);
    if (validated.error) {
      return reply.code(400).send({ error: validated.error });
    }

    if (!isSupportedUmbraNetwork(validated.value.network)) {
      return reply.code(400).send({
        error: "network must be devnet or mainnet",
      });
    }

    const settlement = await settlementStore.getById(settlementId.trim());
    if (!settlement) {
      return reply.code(404).send({ error: "Settlement not found" });
    }

    const rfq = await rfqStore.getById(settlement.rfqId);
    if (!rfq) {
      return reply.code(404).send({ error: "Settlement RFQ not found" });
    }

    if (rfq.institutionWallet !== request.session.walletAddress) {
      return reply.code(403).send({
        error: "Institutions can only fail their own settlements",
      });
    }

    if (!["accepted", "settling", "failed"].includes(settlement.status)) {
      return reply.code(409).send({
        error: `Settlement cannot be marked failed from status ${settlement.status}`,
      });
    }

    const failed = await settlementOrchestrationService.fail(settlement.id, {
      errorMessage: validated.value.errorMessage,
      failure: {
        ...validated.value.failure,
        network: validated.value.network,
      },
    });
    return reply.send(failed);
  });

  app.get("/settlements/:settlementId", { preHandler: authenticate }, async (request, reply) => {
    const settlementId = request.params?.settlementId;
    if (typeof settlementId !== "string" || settlementId.trim().length === 0) {
      return reply.code(400).send({
        error: "settlementId is required",
      });
    }

    const settlement = await settlementStore.getById(settlementId.trim());
    if (!settlement) {
      return reply.code(404).send({
        error: "Settlement not found",
      });
    }

    const rfq = await rfqStore.getById(settlement.rfqId);
    const quote = await quoteStore.getById(settlement.quoteId);

    if (!rfq || !quote) {
      return reply.code(404).send({
        error: "Settlement dependencies not found",
      });
    }

    const role = request.session.role;
    if (role === "institution" && rfq.institutionWallet !== request.session.walletAddress) {
      return reply.code(403).send({
        error: "Institutions can only view their own settlements",
      });
    }
    if (role === "market_maker" && quote.marketMakerWallet !== request.session.walletAddress) {
      return reply.code(403).send({
        error: "Market makers can only view their own settlements",
      });
    }
    if (!["institution", "market_maker", "compliance"].includes(role)) {
      return reply.code(403).send({
        error: "Unauthorized role for settlement view",
      });
    }

    return {
      ...settlement,
      rfq: {
        id: rfq.id,
        institutionWallet: rfq.institutionWallet,
        pair: rfq.pair,
        side: rfq.side,
        status: rfq.status,
        quoteExpiresAt: rfq.quoteExpiresAt,
      },
      quote: {
        id: quote.id,
        marketMakerWallet: quote.marketMakerWallet,
        allInPrice: quote.allInPrice,
        guaranteedSize: quote.guaranteedSize,
        status: quote.status,
        validUntil: quote.validUntil,
      },
    };
  });

  app.get("/settlements/config", { preHandler: authenticate }, async (request) => {
    if (
      !["institution", "market_maker", "compliance"].includes(request.session.role)
    ) {
      return {
        executionModel: "unknown",
        ready: false,
        issues: ["Unauthorized role"],
      };
    }

    return {
      executionModel: "browser",
      provider: "umbra-sdk",
      ready: true,
      defaultNetwork: "devnet",
      supportedNetworks: getAllUmbraNetworkConfigs(),
      issues: [],
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
    const network = getRequestedNetwork(request.query?.network);
    const state = await umbraAccountStore.get(
      request.session.walletAddress,
      request.session.role,
      network
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

    const selectedNetwork = getRequestedNetwork(network);
    const updated = await umbraAccountStore.upsert(
      request.session.walletAddress,
      request.session.role,
      {
        status,
        network: selectedNetwork,
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
      },
      selectedNetwork
    );

    return updated;
  });

  app.get("/dashboard", { preHandler: authenticate }, async (request) => {
    const role = request.session.role;
    const network = getRequestedNetwork(request.query?.network);
    const umbraAccount = await umbraAccountStore.get(
      request.session.walletAddress,
      request.session.role,
      network
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
      network,
      umbraStatus: umbraAccount.status,
    };
  });

  return app;
}

module.exports = {
  buildServer,
  VALID_ROLES,
};
