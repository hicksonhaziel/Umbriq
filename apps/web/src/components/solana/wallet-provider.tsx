"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import {
  getUmbraNetworkConfig,
  resolveUmbraNetwork,
  type UmbraNetwork,
} from "@/lib/umbra/network-config";

const STORAGE_KEY = "umbriq:selected-network";

type UmbraNetworkContextValue = {
  network: UmbraNetwork;
  setNetwork: (network: UmbraNetwork) => void;
};

const UmbraNetworkContext = createContext<UmbraNetworkContextValue | null>(null);

export function useUmbraNetwork() {
  const context = useContext(UmbraNetworkContext);
  if (!context) {
    throw new Error("useUmbraNetwork must be used inside SolanaWalletProvider");
  }
  return context;
}

export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
  const [network, setNetworkState] = useState<UmbraNetwork>("devnet");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const stored = resolveUmbraNetwork(window.localStorage.getItem(STORAGE_KEY));
    setNetworkState(stored);
  }, []);

  const networkConfig = useMemo(() => getUmbraNetworkConfig(network), [network]);
  const wallets = useMemo(() => [new PhantomWalletAdapter()], [network]);

  const setNetwork = (nextNetwork: UmbraNetwork) => {
    setNetworkState(nextNetwork);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, nextNetwork);
    }
  };

  return (
    <UmbraNetworkContext.Provider value={{ network, setNetwork }}>
      <ConnectionProvider endpoint={networkConfig.rpcUrl} key={network}>
        <WalletProvider wallets={wallets} autoConnect={false} key={`wallet-${network}`}>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </UmbraNetworkContext.Provider>
  );
}
