import {
  createSignerFromWalletAccount,
} from "@umbra-privacy/sdk";
import type { Wallet, WalletAccount } from "@wallet-standard/core";
import { getWallets } from "@wallet-standard/core";

type ConnectFeature = {
  connect: (input?: { silent?: boolean }) => Promise<{
    accounts?: readonly WalletAccount[];
  }>;
};

function getWalletAccounts(wallet: Wallet): readonly WalletAccount[] {
  return wallet.accounts ?? [];
}

async function connectWalletIfPossible(wallet: Wallet): Promise<void> {
  const connectFeature = wallet.features["standard:connect"] as
    | ConnectFeature
    | undefined;
  if (!connectFeature) {
    return;
  }
  await connectFeature.connect();
}

function findAccountByAddress(
  wallet: Wallet,
  walletAddress: string
): WalletAccount | null {
  const target = walletAddress.toLowerCase();
  for (const account of getWalletAccounts(wallet)) {
    if (account.address.toLowerCase() === target) {
      return account;
    }
  }
  return null;
}

export async function createUmbraSignerFromWalletAddress(
  walletAddress: string
): Promise<ReturnType<typeof createSignerFromWalletAccount>> {
  if (typeof window === "undefined") {
    throw new Error("Umbra signer can only be created in browser context");
  }

  const wallets = getWallets().get();

  for (const wallet of wallets) {
    const existing = findAccountByAddress(wallet, walletAddress);
    if (existing) {
      return createSignerFromWalletAccount(wallet, existing);
    }
  }

  for (const wallet of wallets) {
    await connectWalletIfPossible(wallet);
    const connected = findAccountByAddress(wallet, walletAddress);
    if (connected) {
      return createSignerFromWalletAccount(wallet, connected);
    }
  }

  throw new Error(
    "Could not find a wallet-standard account for this connected wallet address"
  );
}
