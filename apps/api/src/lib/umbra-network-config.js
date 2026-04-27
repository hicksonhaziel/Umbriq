const DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MAINNET_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const UMBRA_NETWORK_CONFIG = {
  devnet: {
    network: "devnet",
    label: "Devnet",
    rpcUrl: "https://api.devnet.solana.com",
    rpcSubscriptionsUrl: "wss://api.devnet.solana.com",
    mint: DEVNET_MINT,
    mintDecimals: 6,
    explorerCluster: "devnet",
    indexerApiEndpoint: null,
  },
  mainnet: {
    network: "mainnet",
    label: "Mainnet",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    rpcSubscriptionsUrl: "wss://api.mainnet-beta.solana.com",
    mint: MAINNET_MINT,
    mintDecimals: 6,
    explorerCluster: "mainnet-beta",
    indexerApiEndpoint: "https://utxo-indexer.api.umbraprivacy.com",
  },
};

function isSupportedUmbraNetwork(value) {
  return value === "devnet" || value === "mainnet";
}

function resolveUmbraNetwork(value) {
  return isSupportedUmbraNetwork(value) ? value : "devnet";
}

function getUmbraNetworkConfig(network) {
  return UMBRA_NETWORK_CONFIG[resolveUmbraNetwork(network)];
}

function getAllUmbraNetworkConfigs() {
  return {
    devnet: { ...UMBRA_NETWORK_CONFIG.devnet },
    mainnet: { ...UMBRA_NETWORK_CONFIG.mainnet },
  };
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
  return units;
}

module.exports = {
  DEVNET_MINT,
  MAINNET_MINT,
  UMBRA_NETWORK_CONFIG,
  isSupportedUmbraNetwork,
  resolveUmbraNetwork,
  getUmbraNetworkConfig,
  getAllUmbraNetworkConfigs,
  decimalToBaseUnits,
};
