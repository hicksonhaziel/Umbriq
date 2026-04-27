export type UmbraNetwork = "devnet" | "mainnet";

export type UmbraNetworkConfig = {
  network: UmbraNetwork;
  label: string;
  rpcUrl: string;
  rpcSubscriptionsUrl: string;
  mint: string;
  mintDecimals: number;
  explorerCluster: string;
  indexerApiEndpoint: string | null;
};

export const UMBRA_NETWORK_CONFIG: Record<UmbraNetwork, UmbraNetworkConfig> = {
  devnet: {
    network: "devnet",
    label: "Devnet",
    rpcUrl: "https://api.devnet.solana.com",
    rpcSubscriptionsUrl: "wss://api.devnet.solana.com",
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    mintDecimals: 6,
    explorerCluster: "devnet",
    indexerApiEndpoint: null,
  },
  mainnet: {
    network: "mainnet",
    label: "Mainnet",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    rpcSubscriptionsUrl: "wss://api.mainnet-beta.solana.com",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    mintDecimals: 6,
    explorerCluster: "mainnet-beta",
    indexerApiEndpoint: "https://utxo-indexer.api.umbraprivacy.com",
  },
};

export function isUmbraNetwork(value: string): value is UmbraNetwork {
  return value === "devnet" || value === "mainnet";
}

export function resolveUmbraNetwork(value: string | null | undefined): UmbraNetwork {
  return value === "mainnet" ? "mainnet" : "devnet";
}

export function getUmbraNetworkConfig(network: UmbraNetwork): UmbraNetworkConfig {
  return UMBRA_NETWORK_CONFIG[network];
}

export function decimalToBaseUnits(value: string | number, decimals: number): bigint {
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
