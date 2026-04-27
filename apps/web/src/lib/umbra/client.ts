import {
  assertMasterSeed,
  getDefaultMasterSeedStorage,
  getUmbraClient,
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
} from "@umbra-privacy/sdk";
import { createUmbraSignerFromWalletAddress } from "./wallet-standard-signer";
import {
  type UmbraNetwork,
  getUmbraNetworkConfig,
} from "./network-config";

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

function toUmbraAccountState(stateResult: {
  state: string;
  data?: {
    isInitialised: boolean;
    isActiveForAnonymousUsage: boolean;
    isUserCommitmentRegistered: boolean;
    isUserAccountX25519KeyRegistered: boolean;
  };
}): UmbraAccountState {
  return stateResult.state === "exists" && stateResult.data
    ? {
        isInitialised: stateResult.data.isInitialised,
        isActiveForAnonymousUsage: stateResult.data.isActiveForAnonymousUsage,
        isUserCommitmentRegistered: stateResult.data.isUserCommitmentRegistered,
        isUserAccountX25519KeyRegistered:
          stateResult.data.isUserAccountX25519KeyRegistered,
      }
    : null;
}

function isAnonymousModeEnabled(): boolean {
  const value = process.env.NEXT_PUBLIC_UMBRA_ENABLE_ANONYMOUS;
  return value === "true";
}

function getMasterSeedStorageKey(walletAddress: string, network: UmbraNetwork): string {
  return `umbriq:umbra:seed:${network}:${walletAddress}`;
}

export async function getUmbraBrowserClient(
  walletAddress: string,
  network: UmbraNetwork
) {
  const networkConfig = getUmbraNetworkConfig(network);
  const signer = await createUmbraSignerFromWalletAddress(walletAddress);
  const fallbackStorage = getDefaultMasterSeedStorage();

  const client = await getUmbraClient(
    {
      signer,
      network,
      rpcUrl: networkConfig.rpcUrl,
      rpcSubscriptionsUrl: networkConfig.rpcSubscriptionsUrl,
      ...(networkConfig.indexerApiEndpoint
        ? { indexerApiEndpoint: networkConfig.indexerApiEndpoint }
        : {}),
      deferMasterSeedSignature: true,
    },
    {
      masterSeedStorage: {
        load: async () => {
          if (typeof window === "undefined") {
            return fallbackStorage.load();
          }
          const raw = window.sessionStorage.getItem(
            getMasterSeedStorageKey(walletAddress, network)
          );
          if (!raw) {
            return fallbackStorage.load();
          }
          const seed = new Uint8Array(JSON.parse(raw) as number[]);
          assertMasterSeed(seed);
          return {
            exists: true as const,
            seed,
          };
        },
        store: async (seed) => {
          if (typeof window === "undefined") {
            return fallbackStorage.store(seed);
          }
          window.sessionStorage.setItem(
            getMasterSeedStorageKey(walletAddress, network),
            JSON.stringify(Array.from(seed))
          );
          return { success: true as const };
        },
      },
    }
  );

  return {
    client,
    signer,
    networkConfig,
  };
}

export async function initializeUmbraAccount(
  walletAddress: string,
  network: UmbraNetwork
): Promise<UmbraInitializationResult> {
  const { client, signer } = await getUmbraBrowserClient(walletAddress, network);
  const queryUserAccount = getUserAccountQuerierFunction({ client });
  const existingState = await queryUserAccount(signer.address);

  if (existingState.state === "exists" && existingState.data?.isInitialised === true) {
    return {
      network,
      registrationSignatures: [],
      accountState: toUmbraAccountState(existingState),
    };
  }

  const register = getUserRegistrationFunction({ client });
  const registrationSignatures = await register({
    confidential: true,
    // Default to Node/browser-safe path without requiring zkProver injection.
    // Enable anonymous mode only when NEXT_PUBLIC_UMBRA_ENABLE_ANONYMOUS=true
    // and a compatible browser ZK prover is integrated.
    anonymous: isAnonymousModeEnabled(),
  });

  const stateResult = await queryUserAccount(signer.address);

  return {
    network,
    registrationSignatures,
    accountState: toUmbraAccountState(stateResult),
  };
}
