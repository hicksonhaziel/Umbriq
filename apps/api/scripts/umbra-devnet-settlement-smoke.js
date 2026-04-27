#!/usr/bin/env node

const path = require("node:path");
const fs = require("node:fs/promises");
const { setTimeout: sleep } = require("node:timers/promises");
const { createHash } = require("node:crypto");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const dotenv = require("dotenv");
const { buildServer } = require("../src/server");
const { buildAuthMessage } = require("../src/lib/auth-message");
const { buildQuoteMessage } = require("../src/lib/quote-message");
const {
  decimalToBaseUnits,
  getUmbraNetworkConfig,
} = require("../src/lib/umbra-network-config");

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});

const bs58Codec = bs58.default || bs58;
const DEFAULT_TRANSFER_AMOUNT = "1";
const DEFAULT_PAIR = "SOL/USDC";
const DEFAULT_NETWORK = "devnet";

function parsePrivateKeyBytes(raw) {
  if (Array.isArray(raw)) {
    return Uint8Array.from(raw);
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("Private key value is missing");
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed));
  }

  return bs58Codec.decode(trimmed);
}

async function loadPrivateKeyBytes({ pathValue, jsonValue, base58Value, label }) {
  if (typeof pathValue === "string" && pathValue.trim().length > 0) {
    const loaded = await fs.readFile(pathValue.trim(), "utf8");
    return parsePrivateKeyBytes(loaded);
  }

  if (typeof jsonValue === "string" && jsonValue.trim().length > 0) {
    return parsePrivateKeyBytes(jsonValue);
  }

  if (typeof base58Value === "string" && base58Value.trim().length > 0) {
    return parsePrivateKeyBytes(base58Value);
  }

  throw new Error(`Missing ${label} private key configuration`);
}

function walletAddressFromSecretKey(secretKey) {
  const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
  return bs58Codec.encode(keypair.publicKey);
}

async function authenticate(app, secretKey, role) {
  const walletAddress = walletAddressFromSecretKey(secretKey);

  const nonceResponse = await app.inject({
    method: "POST",
    url: "/auth/nonce",
    payload: { walletAddress },
  });
  if (nonceResponse.statusCode !== 200) {
    throw new Error(`Failed to request nonce for ${role}: ${nonceResponse.body}`);
  }

  const { nonce } = nonceResponse.json();
  const message = buildAuthMessage(walletAddress, nonce);
  const signature = nacl.sign.detached(new TextEncoder().encode(message), secretKey);

  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: {
      walletAddress,
      signature: bs58Codec.encode(signature),
      role,
    },
  });
  if (verifyResponse.statusCode !== 200) {
    throw new Error(`Failed to verify ${role}: ${verifyResponse.body}`);
  }

  return {
    walletAddress,
    token: verifyResponse.json().sessionToken,
  };
}

async function createRfq({ app, token, counterpartyWallet, amount }) {
  const quoteExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const response = await app.inject({
    method: "POST",
    url: "/rfqs",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      pair: DEFAULT_PAIR,
      side: "buy",
      notionalSize: amount,
      minFillSize: amount,
      quoteExpiresAt,
      counterparties: [counterpartyWallet],
      encryptedPayload: {
        version: "1",
        algorithm: "AES-GCM",
        ciphertext: "devnet-smoke-rfq",
      },
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(`Failed to create RFQ: ${response.body}`);
  }

  return response.json();
}

async function submitQuote({ app, token, marketMakerSecretKey, marketMakerWallet, rfqId, amount }) {
  const validUntil = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const message = buildQuoteMessage({
    rfqId,
    marketMakerWallet,
    allInPrice: "1.00",
    guaranteedSize: amount,
    validUntil,
  });
  const signature = nacl.sign.detached(new TextEncoder().encode(message), marketMakerSecretKey);

  const response = await app.inject({
    method: "POST",
    url: "/quotes",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      rfqId,
      allInPrice: "1.00",
      guaranteedSize: amount,
      validUntil,
      signature: bs58Codec.encode(signature),
      settlementConstraints: {
        smokeTest: true,
      },
      encryptedPayload: {
        version: "1",
        algorithm: "AES-GCM",
        ciphertext: "devnet-smoke-quote",
      },
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(`Failed to submit quote: ${response.body}`);
  }

  return response.json();
}

async function acceptQuote({ app, token, quoteId }) {
  const response = await app.inject({
    method: "POST",
    url: "/settlements/accept",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      quoteId,
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(`Failed to accept quote: ${response.body}`);
  }

  return response.json();
}

async function startSettlement({ app, token, settlementId, network }) {
  const response = await app.inject({
    method: "POST",
    url: `/settlements/${settlementId}/start`,
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: { network },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to start settlement: ${response.body}`);
  }

  return response.json();
}

async function completeSettlement({ app, token, settlementId, network, executionResult }) {
  const response = await app.inject({
    method: "POST",
    url: `/settlements/${settlementId}/complete`,
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      network,
      ...executionResult,
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to complete settlement: ${response.body}`);
  }

  return response.json();
}

async function failSettlement({ app, token, settlementId, network, errorMessage }) {
  await app.inject({
    method: "POST",
    url: `/settlements/${settlementId}/fail`,
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      network,
      errorMessage,
      failure: {
        source: "smoke-script",
        retryable: true,
      },
    },
  });
}

async function getSettlement({ app, token, settlementId }) {
  const response = await app.inject({
    method: "GET",
    url: `/settlements/${settlementId}`,
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to fetch settlement: ${response.body}`);
  }

  return response.json();
}

async function waitForTerminalSettlement({ app, token, settlementId, timeoutMs = 180000 }) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const settlement = await getSettlement({ app, token, settlementId });
    if (settlement.status === "settled" || settlement.status === "failed") {
      return settlement;
    }
    await sleep(1500);
  }

  throw new Error(`Timed out waiting for settlement ${settlementId} to reach a terminal state`);
}

async function getSettlementConfig(app, token) {
  const response = await app.inject({
    method: "GET",
    url: "/settlements/config",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to fetch settlement config: ${response.body}`);
  }

  return response.json();
}

async function executeUmbraSettlement({
  network,
  institutionSecretKey,
  marketMakerWallet,
  settlementId,
  rfqId,
  quoteId,
  guaranteedSize,
}) {
  const sdk = await import("@umbra-privacy/sdk");
  const networkConfig = getUmbraNetworkConfig(network);
  const amount = BigInt(decimalToBaseUnits(guaranteedSize, networkConfig.mintDecimals));
  const signer = await sdk.createSignerFromPrivateKeyBytes(institutionSecretKey);
  const client = await sdk.getUmbraClient({
    signer,
    network,
    rpcUrl: networkConfig.rpcUrl,
    rpcSubscriptionsUrl: networkConfig.rpcSubscriptionsUrl,
    ...(networkConfig.indexerApiEndpoint
      ? { indexerApiEndpoint: networkConfig.indexerApiEndpoint }
      : {}),
  });

  const queryAccount = sdk.getUserAccountQuerierFunction({ client });
  const accountState = await queryAccount(signer.address);

  if (accountState.state !== "exists" || accountState.data?.isInitialised !== true) {
    const register = sdk.getUserRegistrationFunction({ client });
    await register({
      confidential: true,
      anonymous: false,
    });
  }

  const deposit = sdk.getPublicBalanceToEncryptedBalanceDirectDepositorFunction(
    { client },
    {
      arcium: {
        awaitComputationFinalization: {},
      },
    }
  );

  const depositResult = await deposit(signer.address, networkConfig.mint, amount, {
    accountInfoCommitment: "confirmed",
    epochInfoCommitment: "confirmed",
  });

  const withdraw = sdk.getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction(
    { client },
    {
      arcium: {
        awaitComputationFinalization: {},
      },
    }
  );

  const withdrawResult = await withdraw(marketMakerWallet, networkConfig.mint, amount, {
    accountInfoCommitment: "confirmed",
    epochInfoCommitment: "confirmed",
  });

  const receipt = {
    provider: "umbra-sdk",
    executionModel: "browser",
    network,
    mint: networkConfig.mint,
    mintDecimals: networkConfig.mintDecimals,
    amountBaseUnits: amount.toString(),
    signerAddress: String(signer.address),
    destinationAddress: marketMakerWallet,
    registrationCheckedAt: new Date().toISOString(),
    deposit: {
      queueSignature: depositResult.queueSignature,
      callbackStatus: depositResult.callbackStatus || null,
      callbackSignature: depositResult.callbackSignature || null,
      callbackElapsedMs:
        typeof depositResult.callbackElapsedMs === "number"
          ? depositResult.callbackElapsedMs
          : null,
      rentClaimSignature: depositResult.rentClaimSignature || null,
      rentClaimError: depositResult.rentClaimError || null,
    },
    withdraw: {
      queueSignature: withdrawResult.queueSignature,
      callbackStatus: withdrawResult.callbackStatus || null,
      callbackSignature: withdrawResult.callbackSignature || null,
      callbackElapsedMs:
        typeof withdrawResult.callbackElapsedMs === "number"
          ? withdrawResult.callbackElapsedMs
          : null,
      rentClaimSignature: withdrawResult.rentClaimSignature || null,
      rentClaimError: withdrawResult.rentClaimError || null,
    },
  };

  const proofPayload = {
    settlementId,
    rfqId,
    quoteId,
    network,
    mint: networkConfig.mint,
    amountBaseUnits: amount.toString(),
    signerAddress: String(signer.address),
    destinationAddress: marketMakerWallet,
    depositQueueSignature: depositResult.queueSignature,
    depositCallbackSignature: depositResult.callbackSignature || null,
    withdrawQueueSignature: withdrawResult.queueSignature,
    withdrawCallbackSignature: withdrawResult.callbackSignature || null,
  };

  return {
    umbraTxSignature: withdrawResult.callbackSignature || withdrawResult.queueSignature,
    receipt,
    proof: {
      type: "umbra-settlement-proof-v1",
      mode: "sdk-browser",
      hashAlgorithm: "sha256",
      digest: createHash("sha256").update(JSON.stringify(proofPayload)).digest("hex"),
      payload: proofPayload,
    },
  };
}

async function main() {
  const network = process.env.UMBRA_SMOKE_NETWORK || DEFAULT_NETWORK;
  if (network !== "devnet") {
    throw new Error(
      `This smoke script is intentionally limited to devnet. Current network: ${network}`
    );
  }

  const institutionSecretKey = await loadPrivateKeyBytes({
    pathValue: process.env.UMBRA_SMOKE_INSTITUTION_PRIVATE_KEY_PATH,
    jsonValue: process.env.UMBRA_SMOKE_INSTITUTION_PRIVATE_KEY_JSON,
    base58Value: process.env.UMBRA_SMOKE_INSTITUTION_PRIVATE_KEY_BASE58,
    label: "institution",
  });
  const marketMakerSecretKey = await loadPrivateKeyBytes({
    pathValue: process.env.UMBRA_SMOKE_MARKET_MAKER_PRIVATE_KEY_PATH,
    jsonValue: process.env.UMBRA_SMOKE_MARKET_MAKER_PRIVATE_KEY_JSON,
    base58Value: process.env.UMBRA_SMOKE_MARKET_MAKER_PRIVATE_KEY_BASE58,
    label: "market maker",
  });

  const amount = process.env.UMBRA_SMOKE_TRANSFER_AMOUNT || DEFAULT_TRANSFER_AMOUNT;
  const app = await buildServer({
    logger: false,
    enableRedis: false,
    enablePostgres: false,
  });

  try {
    const institutionSession = await authenticate(app, institutionSecretKey, "institution");
    const marketMakerSession = await authenticate(app, marketMakerSecretKey, "market_maker");
    const config = await getSettlementConfig(app, institutionSession.token);

    if (config.executionModel !== "browser") {
      throw new Error(`Unexpected settlement execution model: ${JSON.stringify(config)}`);
    }
    if (!config.ready) {
      throw new Error(
        `Settlement engine is not ready:\n${JSON.stringify(config.issues || [], null, 2)}`
      );
    }

    console.log("Institution wallet:", institutionSession.walletAddress);
    console.log("Market maker wallet:", marketMakerSession.walletAddress);
    console.log("Settlement config:", JSON.stringify(config, null, 2));

    const rfq = await createRfq({
      app,
      token: institutionSession.token,
      counterpartyWallet: marketMakerSession.walletAddress,
      amount,
    });
    console.log("Created RFQ:", rfq.id);

    const quote = await submitQuote({
      app,
      token: marketMakerSession.token,
      marketMakerSecretKey,
      marketMakerWallet: marketMakerSession.walletAddress,
      rfqId: rfq.id,
      amount,
    });
    console.log("Submitted quote:", quote.id);

    const accepted = await acceptQuote({
      app,
      token: institutionSession.token,
      quoteId: quote.id,
    });
    console.log("Accepted quote, settlement intent created:", accepted.id);

    const started = await startSettlement({
      app,
      token: institutionSession.token,
      settlementId: accepted.id,
      network,
    });
    console.log("Started browser-style settlement:", started.id, started.status);

    try {
      const executionResult = await executeUmbraSettlement({
        network,
        institutionSecretKey,
        marketMakerWallet: marketMakerSession.walletAddress,
        settlementId: accepted.id,
        rfqId: rfq.id,
        quoteId: quote.id,
        guaranteedSize: quote.guaranteedSize,
      });

      await completeSettlement({
        app,
        token: institutionSession.token,
        settlementId: accepted.id,
        network,
        executionResult,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Umbra execution failed";
      await failSettlement({
        app,
        token: institutionSession.token,
        settlementId: accepted.id,
        network,
        errorMessage: message,
      });
      throw error;
    }

    const terminal = await waitForTerminalSettlement({
      app,
      token: institutionSession.token,
      settlementId: accepted.id,
    });

    console.log("Final settlement status:", terminal.status);
    console.log(JSON.stringify(terminal, null, 2));

    if (terminal.status !== "settled") {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
