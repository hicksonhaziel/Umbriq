import { WalletConnectCard } from "@/components/solana/wallet-connect-card";

export default function DevPage() {
  return (
    <main className="min-h-screen bg-[#0e1217] px-6 py-16 text-[#d8dee9]">
      <div className="mx-auto w-full max-w-4xl">
        <WalletConnectCard />
      </div>
    </main>
  );
}
