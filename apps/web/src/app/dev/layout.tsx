import { SolanaWalletProvider } from "@/components/solana/wallet-provider";

export default function DevLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <SolanaWalletProvider>{children}</SolanaWalletProvider>;
}
