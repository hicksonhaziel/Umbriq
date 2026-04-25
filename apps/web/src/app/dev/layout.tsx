import Link from "next/link";
import { SolanaWalletProvider } from "@/components/solana/wallet-provider";

export default function DevLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <SolanaWalletProvider>
      <div className="bg-[#0a111a]">
        <header className="border-b border-[#1f2d40] bg-[#0c1624]/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
            <p className="text-xs uppercase tracking-[0.14em] text-[#8ca0bc]">Umbriq Dev</p>
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
    </SolanaWalletProvider>
  );
}
