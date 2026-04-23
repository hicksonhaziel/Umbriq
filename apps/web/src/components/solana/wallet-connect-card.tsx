"use client";

import { useCallback, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { initializeUmbraAccount, type UmbraAccountState } from "@/lib/umbra/client";
import { Button } from "@/components/ui/button";

type Role = "institution" | "market_maker" | "compliance";
type UmbraStatus = "not_initialized" | "initializing" | "initialized" | "failed";

type UmbraStateResponse = {
  network: string;
  status: UmbraStatus;
  registrationSignatures: string[];
  accountState: UmbraAccountState;
  lastError: string | null;
};

export function WalletConnectCard() {
  const { connection } = useConnection();
  const { connected, connecting, disconnect, publicKey, signMessage } = useWallet();
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";
  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("institution");
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [dashboardView, setDashboardView] = useState<string | null>(null);
  const [umbraStatus, setUmbraStatus] = useState<UmbraStatus>("not_initialized");
  const [umbraNetwork, setUmbraNetwork] = useState("devnet");
  const [umbraSignatures, setUmbraSignatures] = useState<string[]>([]);
  const [umbraAccountState, setUmbraAccountState] = useState<UmbraAccountState>(null);
  const [umbraLoading, setUmbraLoading] = useState(false);
  const [umbraError, setUmbraError] = useState<string | null>(null);

  const walletAddress = useMemo(() => {
    if (!publicKey) {
      return "Not connected";
    }

    const value = publicKey.toBase58();
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }, [publicKey]);

  const clearUmbraState = useCallback(() => {
    setUmbraStatus("not_initialized");
    setUmbraNetwork("devnet");
    setUmbraSignatures([]);
    setUmbraAccountState(null);
    setUmbraError(null);
  }, []);

  const applyUmbraState = useCallback((state: UmbraStateResponse) => {
    setUmbraStatus(state.status);
    setUmbraNetwork(state.network || "devnet");
    setUmbraSignatures(
      Array.isArray(state.registrationSignatures) ? state.registrationSignatures : []
    );
    setUmbraAccountState(state.accountState ?? null);
    setUmbraError(state.lastError ?? null);
  }, []);

  const fetchDashboard = useCallback(
    async (token: string) => {
      const dashboardRes = await fetch(`${apiBaseUrl}/dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!dashboardRes.ok) {
        throw new Error("Failed to load dashboard");
      }
      const dashboardData = await dashboardRes.json();
      setDashboardView(dashboardData.view || null);
    },
    [apiBaseUrl]
  );

  const fetchUmbraState = useCallback(
    async (token: string) => {
      const umbraRes = await fetch(`${apiBaseUrl}/umbra/account`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!umbraRes.ok) {
        throw new Error("Failed to load Umbra state");
      }
      const umbraData = (await umbraRes.json()) as UmbraStateResponse;
      applyUmbraState(umbraData);
    },
    [apiBaseUrl, applyUmbraState]
  );

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

  const authenticate = useCallback(async () => {
    if (!publicKey) {
      setAuthError("Connect wallet first");
      return;
    }
    if (!signMessage) {
      setAuthError("This wallet does not support message signing");
      return;
    }

    try {
      setAuthLoading(true);
      setAuthError(null);
      setUmbraError(null);

      const nonceRes = await fetch(`${apiBaseUrl}/auth/nonce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: publicKey.toBase58() }),
      });
      if (!nonceRes.ok) {
        throw new Error("Failed to request nonce");
      }
      const nonceData = await nonceRes.json();

      const signatureBytes = await signMessage(new TextEncoder().encode(nonceData.message));
      const verifyRes = await fetch(`${apiBaseUrl}/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: publicKey.toBase58(),
          signature: bs58.encode(signatureBytes),
          role,
        }),
      });
      if (!verifyRes.ok) {
        const errorData = await verifyRes.json().catch(() => ({}));
        throw new Error(errorData.error || "Signature verification failed");
      }
      const verifyData = await verifyRes.json();
      const token = verifyData.sessionToken as string;
      setSessionToken(token);

      await Promise.all([fetchUmbraState(token), fetchDashboard(token)]);
    } catch (error) {
      setSessionToken(null);
      setDashboardView(null);
      clearUmbraState();
      setAuthError(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setAuthLoading(false);
    }
  }, [
    apiBaseUrl,
    clearUmbraState,
    fetchDashboard,
    fetchUmbraState,
    publicKey,
    role,
    signMessage,
  ]);

  const initializeUmbra = useCallback(async () => {
    if (!sessionToken || !publicKey) {
      setUmbraError("Authenticate first");
      return;
    }

    try {
      setUmbraLoading(true);
      setUmbraError(null);
      setUmbraStatus("initializing");

      await fetch(`${apiBaseUrl}/umbra/account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          network: "devnet",
          status: "initializing",
          registrationSignatures: [],
          accountState: null,
          lastError: null,
        }),
      });

      const result = await initializeUmbraAccount(publicKey.toBase58());

      const persistRes = await fetch(`${apiBaseUrl}/umbra/account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          network: result.network,
          status: "initialized",
          registrationSignatures: result.registrationSignatures,
          accountState: result.accountState,
          lastError: null,
        }),
      });

      if (!persistRes.ok) {
        throw new Error("Failed to persist Umbra state");
      }

      const persisted = (await persistRes.json()) as UmbraStateResponse;
      applyUmbraState(persisted);
      await fetchDashboard(sessionToken);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Umbra initialization failed";
      setUmbraStatus("failed");
      setUmbraError(errorMessage);

      await fetch(`${apiBaseUrl}/umbra/account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          network: umbraNetwork,
          status: "failed",
          registrationSignatures: umbraSignatures,
          accountState: umbraAccountState,
          lastError: errorMessage,
        }),
      }).catch(() => null);
    } finally {
      setUmbraLoading(false);
    }
  }, [
    apiBaseUrl,
    applyUmbraState,
    fetchDashboard,
    publicKey,
    sessionToken,
    umbraAccountState,
    umbraNetwork,
    umbraSignatures,
  ]);

  const logout = useCallback(async () => {
    if (!sessionToken) {
      return;
    }
    try {
      await fetch(`${apiBaseUrl}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
    } finally {
      setSessionToken(null);
      setDashboardView(null);
      clearUmbraState();
    }
  }, [apiBaseUrl, clearUmbraState, sessionToken]);

  return (
    <section className="rounded-xl border border-[#2a323d] bg-[#131a22] p-6">
      <h2 className="mb-2 text-xl font-semibold text-white">Wallet + Auth + Umbra</h2>
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

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          className="h-10 rounded-md border border-[#2a323d] bg-transparent px-3 text-sm text-[#d8dee9] outline-none"
        >
          <option value="institution">Institution</option>
          <option value="market_maker">MarketMaker</option>
          <option value="compliance">Compliance</option>
        </select>
        <Button onClick={() => void authenticate()} disabled={!connected || authLoading}>
          {authLoading ? "Authenticating..." : "Authenticate"}
        </Button>
        <Button variant="outline" onClick={() => void logout()} disabled={!sessionToken}>
          Logout Session
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          onClick={() => void initializeUmbra()}
          disabled={!sessionToken || umbraLoading}
        >
          {umbraLoading ? "Initializing Umbra..." : "Initialize Umbra Account"}
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

      <p className="mt-2 text-sm text-[#aeb9c7]">
        Session:{" "}
        <span className="font-medium text-[#d8dee9]">
          {sessionToken ? `${sessionToken.slice(0, 8)}...` : "Not authenticated"}
        </span>
      </p>

      <p className="mt-2 text-sm text-[#aeb9c7]">
        Umbra Status:{" "}
        <span className="font-medium text-[#d8dee9]">
          {umbraStatus} ({umbraNetwork})
        </span>
      </p>
      <p className="mt-2 text-sm text-[#aeb9c7]">
        Umbra Signatures:{" "}
        <span className="font-medium text-[#d8dee9]">{umbraSignatures.length}</span>
      </p>

      {umbraAccountState ? (
        <div className="mt-2 text-sm text-[#aeb9c7]">
          <p>Umbra Account Flags:</p>
          <p className="font-medium text-[#d8dee9]">
            initialised={String(umbraAccountState.isInitialised)} | anonymous=
            {String(umbraAccountState.isActiveForAnonymousUsage)} | commitment=
            {String(umbraAccountState.isUserCommitmentRegistered)} | x25519=
            {String(umbraAccountState.isUserAccountX25519KeyRegistered)}
          </p>
        </div>
      ) : null}

      <p className="mt-2 text-sm text-[#aeb9c7]">
        Dashboard:{" "}
        <span className="font-medium text-[#d8dee9]">{dashboardView || "-"}</span>
      </p>

      {authError ? <p className="mt-2 text-sm text-red-300">{authError}</p> : null}
      {umbraError ? <p className="mt-2 text-sm text-red-300">{umbraError}</p> : null}
    </section>
  );
}
