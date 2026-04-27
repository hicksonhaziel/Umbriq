const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const bs58 = require("bs58");
const { PublicKey, clusterApiUrl } = require("@solana/web3.js");

const DEFAULT_MODE = "sdk";
const DEFAULT_NETWORK = "devnet";
const DEFAULT_MINT_DECIMALS = 0;

function normalizeMode(value) {
  if (value == null || String(value).trim() === "") {
    return DEFAULT_MODE;
  }
  if (String(value).trim() === "sdk") {
    return "sdk";
  }
  throw new Error(
    `Unsupported UMBRA_SETTLEMENT_MODE: ${String(
      value
    )}. Umbriq only supports sdk settlement mode.`
  );
}

function resolveNetwork(value) {
  if (value == null || String(value).trim() === "") {
    return DEFAULT_NETWORK;
  }
  if (value === "mainnet" || value === "devnet") {
    return value;
  }
  throw new Error(
    `Unsupported UMBRA_SETTLEMENT_NETWORK: ${String(
      value
    )}. Umbriq only supports devnet and mainnet.`
  );
}

function resolveRpcUrl(network, value) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (network === "mainnet") {
    return "https://api.mainnet-beta.solana.com";
  }
  return clusterApiUrl("devnet");
}

function resolveRpcSubscriptionsUrl(network, value) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (network === "mainnet") {
    return "wss://api.mainnet-beta.solana.com";
  }
  return "wss://api.devnet.solana.com";
}

function resolveMint(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const mint = value.trim();
  new PublicKey(mint);
  return mint;
}

function parseMintDecimals(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 18) {
    return DEFAULT_MINT_DECIMALS;
  }
  return numeric;
}

function decimalToBaseUnits(value, decimals) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Amount must be provided as string or number");
  }

  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid amount format: ${normalized}`);
  }

  const [wholePartRaw, fractionalRaw = ""] = normalized.split(".");
  const wholePart = wholePartRaw.replace(/^0+/, "") || "0";

  if (fractionalRaw.length > decimals) {
    const overflow = fractionalRaw.slice(decimals);
    if (!/^0+$/.test(overflow)) {
      throw new Error(`Amount ${normalized} exceeds mint precision ${decimals}`);
    }
  }

  const fractional = fractionalRaw.slice(0, decimals).padEnd(decimals, "0");
  const units = `${wholePart}${fractional}`.replace(/^0+/, "") || "0";
  return BigInt(units);
}

function parsePrivateKeyBytes(raw) {
  if (Array.isArray(raw)) {
    return Uint8Array.from(raw);
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("Missing signer private key");
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed));
  }

  const bs58Codec = bs58.default || bs58;
  return bs58Codec.decode(trimmed);
}

function extractSimulationHint(error) {
  let cursor = error;
  while (cursor && typeof cursor === "object") {
    const logs = cursor?.context?.logs;
    if (Array.isArray(logs)) {
      const anchorLog = logs.find(
        (entry) => typeof entry === "string" && entry.includes("AnchorError")
      );
      if (anchorLog) {
        return anchorLog.replace(/^Program log:\s*/u, "").trim();
      }

      const programLog = [...logs]
        .reverse()
        .find((entry) => typeof entry === "string" && entry.startsWith("Program log:"));
      if (programLog) {
        return programLog.replace(/^Program log:\s*/u, "").trim();
      }
    }

    cursor = cursor.cause;
  }

  return null;
}

class UmbraSettlementService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.mode = normalizeMode(options.mode || process.env.UMBRA_SETTLEMENT_MODE || DEFAULT_MODE);
    this.network = resolveNetwork(
      options.network || process.env.UMBRA_SETTLEMENT_NETWORK || DEFAULT_NETWORK
    );
    this.rpcUrl = resolveRpcUrl(
      this.network,
      options.rpcUrl || process.env.UMBRA_SETTLEMENT_RPC_URL
    );
    this.rpcSubscriptionsUrl = resolveRpcSubscriptionsUrl(
      this.network,
      options.rpcSubscriptionsUrl || process.env.UMBRA_SETTLEMENT_RPC_SUBSCRIPTIONS_URL
    );
    this.indexerApiEndpoint =
      options.indexerApiEndpoint || process.env.UMBRA_SETTLEMENT_INDEXER_API_ENDPOINT || null;
    this.mint = (() => {
      try {
        return resolveMint(options.mint || process.env.UMBRA_SETTLEMENT_MINT || null);
      } catch {
        return null;
      }
    })();
    this.mintDecimals = parseMintDecimals(
      options.mintDecimals || process.env.UMBRA_SETTLEMENT_MINT_DECIMALS
    );
    this.requireSignerWalletMatch =
      options.requireSignerWalletMatch ?? process.env.UMBRA_SETTLEMENT_REQUIRE_WALLET_MATCH !== "false";

    this.signerPrivateKeyBytes = options.signerPrivateKeyBytes || null;
    this.signerPrivateKeyPath = options.signerPrivateKeyPath || process.env.UMBRA_SETTLEMENT_SIGNER_PRIVATE_KEY_PATH;
    this.signerPrivateKeyRaw =
      options.signerPrivateKey ||
      process.env.UMBRA_SETTLEMENT_SIGNER_PRIVATE_KEY_JSON ||
      process.env.UMBRA_SETTLEMENT_SIGNER_PRIVATE_KEY_BASE58 ||
      null;

    this.cachedSdkModule = null;
    this.cachedClient = null;
    this.cachedSignerAddress = null;
  }

  async execute({ settlement, rfq, quote }) {
    return this.executeWithSdk({ settlement, rfq, quote });
  }

  async executeWithSdk({ settlement, rfq, quote }) {
    let sdk = null;
    try {
      if (!this.mint) {
        throw new Error("UMBRA_SETTLEMENT_MINT is required for sdk settlement mode");
      }

      new PublicKey(quote.marketMakerWallet);
      const amount = decimalToBaseUnits(quote.guaranteedSize, this.mintDecimals);
      if (amount <= 0n) {
        throw new Error("Computed transfer amount must be greater than zero");
      }

      const prepared = await this.ensureClient({ institutionWallet: rfq.institutionWallet });
      sdk = prepared.sdk;

      // SDK call: query user account state before registration.
      const queryAccount = sdk.getUserAccountQuerierFunction({ client: prepared.client });
      const accountState = await queryAccount(prepared.signerAddress);
      if (accountState.state !== "exists" || accountState.data.isInitialised !== true) {
        // SDK call: run user registration in confidential-only mode.
        const register = sdk.getUserRegistrationFunction({ client: prepared.client });
        await register({
          confidential: true,
          anonymous: false,
        });
      }

      // SDK call: create ATA -> encrypted-balance direct deposit function.
      const deposit = sdk.getPublicBalanceToEncryptedBalanceDirectDepositorFunction(
        { client: prepared.client },
        {
          arcium: {
            awaitComputationFinalization: {},
          },
        }
      );
      // SDK call: perform confidential deposit.
      const depositResult = await deposit(prepared.signerAddress, this.mint, amount, {
        accountInfoCommitment: "confirmed",
        epochInfoCommitment: "confirmed",
      });
      this.assertComputationFinalized("deposit", depositResult);

      // SDK call: create encrypted-balance -> ATA direct withdrawal function.
      const withdraw = sdk.getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction(
        { client: prepared.client },
        {
          arcium: {
            awaitComputationFinalization: {},
          },
        }
      );
      // SDK call: perform confidential withdrawal to the market-maker wallet.
      const withdrawResult = await withdraw(quote.marketMakerWallet, this.mint, amount, {
        accountInfoCommitment: "confirmed",
        epochInfoCommitment: "confirmed",
      });
      this.assertComputationFinalized("withdraw", withdrawResult);

      const receipt = {
        provider: "umbra-sdk",
        network: this.network,
        mint: this.mint,
        mintDecimals: this.mintDecimals,
        amountBaseUnits: amount.toString(),
        signerAddress: prepared.signerAddress,
        destinationAddress: quote.marketMakerWallet,
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
        settlementId: settlement.id,
        rfqId: settlement.rfqId,
        quoteId: settlement.quoteId,
        network: this.network,
        mint: this.mint,
        amountBaseUnits: amount.toString(),
        depositQueueSignature: depositResult.queueSignature,
        depositCallbackSignature: depositResult.callbackSignature || null,
        withdrawQueueSignature: withdrawResult.queueSignature,
        withdrawCallbackSignature: withdrawResult.callbackSignature || null,
      };

      const proofDigest = createHash("sha256")
        .update(JSON.stringify(proofPayload))
        .digest("hex");

      return {
        umbraTxSignature: withdrawResult.callbackSignature || withdrawResult.queueSignature,
        receipt,
        proof: {
          type: "umbra-settlement-proof-v1",
          mode: "sdk",
          hashAlgorithm: "sha256",
          digest: proofDigest,
          payload: proofPayload,
        },
      };
    } catch (error) {
      const meta = this.mapExecutionError(error, sdk);
      const wrapped = new Error(meta.message);
      wrapped.code = meta.code;
      wrapped.meta = meta;
      wrapped.cause = error;
      throw wrapped;
    }
  }

  assertComputationFinalized(stage, result) {
    if (!result || typeof result !== "object") {
      const error = new Error(`Umbra ${stage} did not return a valid result`);
      error.code = "UMBRA_INVALID_RESULT";
      throw error;
    }

    if (result.callbackStatus && result.callbackStatus !== "finalized") {
      const error = new Error(
        `Umbra ${stage} callback not finalized (status=${result.callbackStatus})`
      );
      error.code = "UMBRA_CALLBACK_NOT_FINALIZED";
      error.stage = stage;
      error.callbackStatus = result.callbackStatus;
      throw error;
    }
  }

  async ensureClient({ institutionWallet }) {
    if (this.cachedClient && this.cachedSignerAddress) {
      if (
        this.requireSignerWalletMatch &&
        this.cachedSignerAddress !== institutionWallet
      ) {
        throw new Error(
          `Configured settlement signer ${this.cachedSignerAddress} does not match institution wallet ${institutionWallet}`
        );
      }

      return {
        sdk: this.cachedSdkModule,
        client: this.cachedClient,
        signerAddress: this.cachedSignerAddress,
      };
    }

    const sdk = await import("@umbra-privacy/sdk");
    const signerPrivateKeyBytes = await this.resolveSignerPrivateKeyBytes();

    // SDK call: create signer from a Solana secret key byte array.
    const signer = await sdk.createSignerFromPrivateKeyBytes(signerPrivateKeyBytes);
    const signerAddress = String(signer.address);

    if (this.requireSignerWalletMatch && signerAddress !== institutionWallet) {
      throw new Error(
        `Configured settlement signer ${signerAddress} does not match institution wallet ${institutionWallet}`
      );
    }

    // SDK call: create Umbra client for the configured network and RPC endpoints.
    const client = await sdk.getUmbraClient({
      signer,
      network: this.network,
      rpcUrl: this.rpcUrl,
      rpcSubscriptionsUrl: this.rpcSubscriptionsUrl,
      ...(this.indexerApiEndpoint
        ? {
            indexerApiEndpoint: this.indexerApiEndpoint,
          }
        : {}),
      deferMasterSeedSignature: true,
    });

    this.cachedSdkModule = sdk;
    this.cachedClient = client;
    this.cachedSignerAddress = signerAddress;

    return { sdk, client, signerAddress };
  }

  async getStatus() {
    const status = {
      mode: this.mode,
      network: this.network,
      rpcUrl: this.rpcUrl,
      rpcSubscriptionsUrl: this.rpcSubscriptionsUrl,
      mint: this.mint,
      mintDecimals: this.mintDecimals,
      requireSignerWalletMatch: this.requireSignerWalletMatch,
      ready: false,
      signerAddress: this.cachedSignerAddress || null,
      issues: [],
    };

    if (!this.mint) {
      status.issues.push("UMBRA_SETTLEMENT_MINT is required.");
    }

    if (!this.signerPrivateKeyBytes && !this.signerPrivateKeyPath && !this.signerPrivateKeyRaw) {
      status.issues.push(
        "Settlement signer key is missing. Set UMBRA_SETTLEMENT_SIGNER_PRIVATE_KEY_PATH, UMBRA_SETTLEMENT_SIGNER_PRIVATE_KEY_JSON, or UMBRA_SETTLEMENT_SIGNER_PRIVATE_KEY_BASE58."
      );
    }

    if (status.issues.length > 0) {
      return status;
    }

    try {
      const signerBytes = await this.resolveSignerPrivateKeyBytes();
      const sdk = await import("@umbra-privacy/sdk");
      const signer = await sdk.createSignerFromPrivateKeyBytes(signerBytes);
      status.signerAddress = String(signer.address);
      status.ready = true;
      return status;
    } catch (error) {
      status.issues.push(
        error && typeof error.message === "string"
          ? error.message
          : "Failed to load settlement signer configuration."
      );
      return status;
    }
  }

  async resolveSignerPrivateKeyBytes() {
    if (this.signerPrivateKeyBytes instanceof Uint8Array) {
      return this.signerPrivateKeyBytes;
    }

    if (this.signerPrivateKeyPath && this.signerPrivateKeyPath.trim().length > 0) {
      const loaded = await fs.readFile(this.signerPrivateKeyPath.trim(), "utf8");
      this.signerPrivateKeyBytes = parsePrivateKeyBytes(loaded);
      return this.signerPrivateKeyBytes;
    }

    if (this.signerPrivateKeyRaw) {
      this.signerPrivateKeyBytes = parsePrivateKeyBytes(this.signerPrivateKeyRaw);
      return this.signerPrivateKeyBytes;
    }

    throw new Error(
      "Missing settlement signer key. Set UMBRA_SETTLEMENT_SIGNER_PRIVATE_KEY_JSON, UMBRA_SETTLEMENT_SIGNER_PRIVATE_KEY_BASE58, or UMBRA_SETTLEMENT_SIGNER_PRIVATE_KEY_PATH."
    );
  }

  mapExecutionError(error, sdk) {
    const baseMessage =
      error && typeof error.message === "string"
        ? error.message
        : "Umbra settlement execution failed";
    const simulationHint = extractSimulationHint(error);
    const message =
      simulationHint &&
      baseMessage.toLowerCase().includes("transaction simulation failed")
        ? `${baseMessage} (${simulationHint})`
        : baseMessage;

    const meta = {
      source: "unknown",
      code: error && typeof error.code === "string" ? error.code : "UMBRA_EXECUTION_FAILED",
      message,
      stage: error && typeof error.stage === "string" ? error.stage : null,
      retryable: false,
    };

    if (sdk?.isRegistrationError?.(error)) {
      meta.source = "registration";
      meta.code = "UMBRA_REGISTRATION_ERROR";
      meta.stage = error.stage || meta.stage;
      meta.retryable = meta.stage !== "validation";
      return meta;
    }

    if (sdk?.isEncryptedDepositError?.(error)) {
      meta.source = "deposit";
      meta.code = "UMBRA_DEPOSIT_ERROR";
      meta.stage = error.stage || meta.stage;
      meta.retryable = ["transaction-send", "transaction-sign", "callback-await"].includes(
        String(meta.stage || "")
      );
      return meta;
    }

    if (sdk?.isEncryptedWithdrawalError?.(error)) {
      meta.source = "withdraw";
      meta.code = "UMBRA_WITHDRAWAL_ERROR";
      meta.stage = error.stage || meta.stage;
      meta.retryable = ["transaction-send", "transaction-sign", "callback-await"].includes(
        String(meta.stage || "")
      );
      return meta;
    }

    if (sdk?.isQueryError?.(error)) {
      meta.source = "query";
      meta.code = "UMBRA_QUERY_ERROR";
      meta.stage = error.stage || meta.stage;
      meta.retryable = true;
      return meta;
    }

    if (meta.code === "UMBRA_CALLBACK_NOT_FINALIZED") {
      meta.source = "callback";
      meta.retryable = true;
      return meta;
    }

    const lower = String(message || "").toLowerCase();
    if (lower.includes("insufficient") && lower.includes("fund")) {
      meta.source = "transaction";
      meta.code = "UMBRA_INSUFFICIENT_FUNDS";
      meta.retryable = false;
      return meta;
    }

    return meta;
  }

  async close() {
    this.cachedSdkModule = null;
    this.cachedClient = null;
    this.cachedSignerAddress = null;
  }
}

module.exports = {
  UmbraSettlementService,
};
