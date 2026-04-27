"use client";

import Link from "next/link";
import {
  SolanaWalletProvider,
  useUmbraNetwork,
} from "@/components/solana/wallet-provider";
import { getUmbraNetworkConfig } from "@/lib/umbra/network-config";

function DevShell({ children }: { children: React.ReactNode }) {
  const { network, setNetwork } = useUmbraNetwork();
  const networkConfig = getUmbraNetworkConfig(network);

  return (
    <div className="bg-[#0a111a]">
      <header className="border-b border-[#1f2d40] bg-[#0c1624]/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <p className="text-xs uppercase tracking-[0.14em] text-[#8ca0bc]">Umbriq Dev</p>
            <div className="flex items-center gap-2 rounded-md border border-[#2f4460] bg-[#122033] p-1">
              {(["devnet", "mainnet"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => setNetwork(candidate)}
                  className={`rounded px-2 py-1 text-xs transition ${
                    network === candidate
                      ? "bg-[#4dd2b3] text-[#06241f]"
                      : "text-[#dbe5f3] hover:text-[#4dd2b3]"
                  }`}
                >
                  {candidate}
                </button>
              ))}
            </div>
            <p className="text-xs text-[#8ca0bc]">
              Settlement network: <span className="text-[#dbe5f3]">{networkConfig.label}</span>
            </p>
          </div>
          <nav className="flex items-center gap-2">
            <Link
              href="/dev/dashboard"
              className="rounded-md border border-[#2f4460] bg-[#122033] px-3 py-1.5 text-xs text-[#dbe5f3] transition hover:border-[#4dd2b3] hover:text-[#4dd2b3]"
            >
              Institution
            </Link>
            <Link
              href="/dev/mm"
              className="rounded-md border border-[#2f4460] bg-[#122033] px-3 py-1.5 text-xs text-[#dbe5f3] transition hover:border-[#4dd2b3] hover:text-[#4dd2b3]"
            >
              Market Maker
            </Link>
            <Link
              href="/dev/console"
              className="rounded-md border border-[#2f4460] bg-[#122033] px-3 py-1.5 text-xs text-[#dbe5f3] transition hover:border-[#4dd2b3] hover:text-[#4dd2b3]"
            >
              Legacy Console
            </Link>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}

export default function DevLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <SolanaWalletProvider>
      <DevShell>{children}</DevShell>
    </SolanaWalletProvider>
  );
}
