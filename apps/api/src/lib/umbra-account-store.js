const UMBRA_ACCOUNT_PREFIX = "umbra:account:";

const VALID_UMBRA_STATUS = [
  "not_initialized",
  "initializing",
  "initialized",
  "failed",
];

function normalizeUmbraStatus(status) {
  if (typeof status !== "string") {
    return "not_initialized";
  }
  return VALID_UMBRA_STATUS.includes(status) ? status : "not_initialized";
}

function buildDefaultState(walletAddress, role, network = "devnet") {
  return {
    walletAddress,
    role,
    network,
    status: "not_initialized",
    registrationSignatures: [],
    accountState: null,
    lastError: null,
    updatedAt: Date.now(),
  };
}

function buildStoreKey(walletAddress, network = "devnet") {
  return `${walletAddress}:${network}`;
}

function normalizeRecord(record, walletAddress, role, network = "devnet") {
  if (!record || typeof record !== "object") {
    return buildDefaultState(walletAddress, role, network);
  }

  return {
    walletAddress,
    role,
    network: typeof record.network === "string" ? record.network : network,
    status: normalizeUmbraStatus(record.status),
    registrationSignatures: Array.isArray(record.registrationSignatures)
      ? record.registrationSignatures.filter((value) => typeof value === "string")
      : [],
    accountState:
      record.accountState && typeof record.accountState === "object"
        ? {
            isInitialised: Boolean(record.accountState.isInitialised),
            isActiveForAnonymousUsage: Boolean(
              record.accountState.isActiveForAnonymousUsage
            ),
            isUserCommitmentRegistered: Boolean(
              record.accountState.isUserCommitmentRegistered
            ),
            isUserAccountX25519KeyRegistered: Boolean(
              record.accountState.isUserAccountX25519KeyRegistered
            ),
          }
        : null,
    lastError: typeof record.lastError === "string" ? record.lastError : null,
    updatedAt:
      typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}

class InMemoryUmbraAccountStore {
  constructor() {
    this.records = new Map();
  }

  async get(walletAddress, role, network = "devnet") {
    const existing = this.records.get(buildStoreKey(walletAddress, network));
    return normalizeRecord(existing, walletAddress, role, network);
  }

  async upsert(walletAddress, role, patch, network = patch?.network || "devnet") {
    const current = await this.get(walletAddress, role, network);
    const next = normalizeRecord(
      {
        ...current,
        ...patch,
        status: normalizeUmbraStatus(patch.status ?? current.status),
        updatedAt: Date.now(),
      },
      walletAddress,
      role,
      network
    );
    this.records.set(buildStoreKey(walletAddress, next.network), next);
    return next;
  }
}

class RedisUmbraAccountStore {
  constructor(redis) {
    this.redis = redis;
  }

  async get(walletAddress, role, network = "devnet") {
    const value = await this.redis.get(
      `${UMBRA_ACCOUNT_PREFIX}${buildStoreKey(walletAddress, network)}`
    );
    if (!value) {
      return buildDefaultState(walletAddress, role, network);
    }

    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
    return normalizeRecord(parsed, walletAddress, role, network);
  }

  async upsert(walletAddress, role, patch, network = patch?.network || "devnet") {
    const current = await this.get(walletAddress, role, network);
    const next = normalizeRecord(
      {
        ...current,
        ...patch,
        status: normalizeUmbraStatus(patch.status ?? current.status),
        updatedAt: Date.now(),
      },
      walletAddress,
      role,
      network
    );
    await this.redis.set(
      `${UMBRA_ACCOUNT_PREFIX}${buildStoreKey(walletAddress, next.network)}`,
      JSON.stringify(next)
    );
    return next;
  }
}

module.exports = {
  VALID_UMBRA_STATUS,
  InMemoryUmbraAccountStore,
  RedisUmbraAccountStore,
};
