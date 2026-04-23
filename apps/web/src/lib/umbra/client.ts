import {
  getUmbraClient,
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
} from "@umbra-privacy/sdk";
import { clusterApiUrl } from "@solana/web3.js";
import { createUmbraSignerFromWalletAddress } from "./wallet-standard-signer";

type UmbraNetwork = "mainnet" | "devnet" | "localnet";

export type UmbraAccountState = {
  isInitialised: boolean;
  isActiveForAnonymousUsage: boolean;
  isUserCommitmentRegistered: boolean;
  isUserAccountX25519KeyRegistered: boolean;
} | null;

export type UmbraInitializationResult = {
  network: UmbraNetwork;
  registrationSignatures: string[];
  accountState: UmbraAccountState;
};

function isAnonymousModeEnabled(): boolean {
  const value = process.env.NEXT_PUBLIC_UMBRA_ENABLE_ANONYMOUS;
  return value === "true";
}

function getConfiguredNetwork(): UmbraNetwork {
  const configured = process.env.NEXT_PUBLIC_UMBRA_NETWORK;
  if (configured === "mainnet" || configured === "localnet") {
    return configured;
  }
  return "devnet";
}

function getConfiguredRpcUrl(network: UmbraNetwork): string {
  const value = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  if (value && value.trim().length > 0) {
    return value;
  }
  if (network === "mainnet") {
    return "https://api.mainnet-beta.solana.com";
  }
  return clusterApiUrl("devnet");
}

function getConfiguredRpcSubscriptionsUrl(network: UmbraNetwork): string {
  const value = process.env.NEXT_PUBLIC_SOLANA_RPC_SUBSCRIPTIONS_URL;
  if (value && value.trim().length > 0) {
    return value;
  }
  if (network === "mainnet") {
    return "wss://api.mainnet-beta.solana.com";
  }
  return "wss://api.devnet.solana.com";
}

export async function initializeUmbraAccount(
  walletAddress: string
): Promise<UmbraInitializationResult> {
  const network = getConfiguredNetwork();
  const signer = await createUmbraSignerFromWalletAddress(walletAddress);
  const rpcUrl = getConfiguredRpcUrl(network);
  const rpcSubscriptionsUrl = getConfiguredRpcSubscriptionsUrl(network);
  const indexerApiEndpoint = process.env.NEXT_PUBLIC_UMBRA_INDEXER_API_ENDPOINT;

  const client = await getUmbraClient({
    signer,
    network,
    rpcUrl,
    rpcSubscriptionsUrl,
    ...(indexerApiEndpoint ? { indexerApiEndpoint } : {}),
    deferMasterSeedSignature: true,
  });

  const register = getUserRegistrationFunction({ client });
  const registrationSignatures = await register({
    confidential: true,
    // Default to Node/browser-safe path without requiring zkProver injection.
    // Enable anonymous mode only when NEXT_PUBLIC_UMBRA_ENABLE_ANONYMOUS=true
    // and a compatible browser ZK prover is integrated.
    anonymous: isAnonymousModeEnabled(),
  });

  const queryUserAccount = getUserAccountQuerierFunction({ client });
  const stateResult = await queryUserAccount(signer.address);

  return {
    network,
    registrationSignatures,
    accountState:
      stateResult.state === "exists"
        ? {
            isInitialised: stateResult.data.isInitialised,
            isActiveForAnonymousUsage: stateResult.data.isActiveForAnonymousUsage,
            isUserCommitmentRegistered:
              stateResult.data.isUserCommitmentRegistered,
            isUserAccountX25519KeyRegistered:
              stateResult.data.isUserAccountX25519KeyRegistered,
          }
        : null,
  };
}
