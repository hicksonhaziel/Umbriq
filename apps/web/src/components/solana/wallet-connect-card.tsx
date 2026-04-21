"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Button } from "@/components/ui/button";

export function WalletConnectCard() {
  const { connection } = useConnection();
  const { connected, connecting, disconnect, publicKey } = useWallet();
  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const walletAddress = useMemo(() => {
    if (!publicKey) {
      return "Not connected";
    }

    const value = publicKey.toBase58();
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }, [publicKey]);

  const refreshBalance = useCallback(async () => {
    if (!publicKey) {
      setBalanceSol(null);
      setBalanceError(null);
      return;
    }

    try {
      setLoadingBalance(true);
      setBalanceError(null);
      const lamports = await connection.getBalance(publicKey, "confirmed");
      setBalanceSol(lamports / LAMPORTS_PER_SOL);
    } catch {
      setBalanceError("Could not fetch balance");
      setBalanceSol(null);
    } finally {
      setLoadingBalance(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  return (
    <section className="rounded-xl border border-[#2a323d] bg-[#131a22] p-6">
      <h2 className="mb-2 text-xl font-semibold text-white">Connect Wallet</h2>
      <p className="mb-6 text-sm text-[#aeb9c7]">
        Network: <span className="text-[#6ee7d7]">Solana Devnet</span>
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <WalletMultiButton className="!h-10 !rounded-md !bg-[#14b8a6] !px-4 !text-sm !font-semibold !text-[#05322d] hover:!bg-[#0d9488]" />
        <Button
          variant="outline"
          onClick={() => void disconnect()}
          disabled={!connected || connecting}
        >
          Disconnect
        </Button>
        <Button variant="outline" onClick={() => void refreshBalance()} disabled={!connected}>
          Refresh Balance
        </Button>
      </div>

      <p className="mt-4 text-sm text-[#aeb9c7]">
        Status:{" "}
        <span className="font-medium text-[#d8dee9]">
          {connecting ? "Connecting..." : connected ? `Connected (${walletAddress})` : "Idle"}
        </span>
      </p>

      <p className="mt-2 text-sm text-[#aeb9c7]">
        Balance:{" "}
        <span className="font-medium text-[#d8dee9]">
          {connected ? (loadingBalance ? "Loading..." : balanceSol?.toFixed(4) ?? "0.0000") : "-"}{" "}
          SOL
        </span>
      </p>

      {balanceError ? <p className="mt-2 text-sm text-red-300">{balanceError}</p> : null}
    </section>
  );
}
