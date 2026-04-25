"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { initializeUmbraAccount, type UmbraAccountState } from "@/lib/umbra/client";
import { encryptRfqPayload } from "@/lib/rfq/encryption";
import { Button } from "@/components/ui/button";

type Role = "institution" | "market_maker" | "compliance";
type UmbraStatus = "not_initialized" | "initializing" | "initialized" | "failed";
type RfqSide = "buy" | "sell";

type UmbraStateResponse = {
  network: string;
  status: UmbraStatus;
  registrationSignatures: string[];
  accountState: UmbraAccountState;
  lastError: string | null;
};

type RfqCreateResponse = {
  id: string;
  pair: string;
  side: RfqSide;
  notionalSize: string;
  minFillSize: string | null;
  quoteExpiresAt: string;
  status: string;
};

type WsConnectionState = "disconnected" | "connecting" | "connected" | "error";

function toWebsocketBaseUrl(apiBaseUrl: string): string {
  if (apiBaseUrl.startsWith("https://")) {
    return `wss://${apiBaseUrl.slice("https://".length)}`;
  }
  if (apiBaseUrl.startsWith("http://")) {
    return `ws://${apiBaseUrl.slice("http://".length)}`;
  }
  return apiBaseUrl;
}

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
  const [rfqPair, setRfqPair] = useState("SOL/USDC");
  const [rfqSide, setRfqSide] = useState<RfqSide>("buy");
  const [rfqNotionalSize, setRfqNotionalSize] = useState("1000");
  const [rfqMinFillSize, setRfqMinFillSize] = useState("500");
  const [rfqExpiryMinutes, setRfqExpiryMinutes] = useState("2");
  const [rfqCounterparties, setRfqCounterparties] = useState("");
  const [rfqLoading, setRfqLoading] = useState(false);
  const [rfqError, setRfqError] = useState<string | null>(null);
  const [rfqCreated, setRfqCreated] = useState<RfqCreateResponse | null>(null);
  const [rfqCopyState, setRfqCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [wsState, setWsState] = useState<WsConnectionState>("disconnected");
  const [wsEvents, setWsEvents] = useState<string[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!sessionToken) {
      setWsState("disconnected");
      setWsEvents([]);
      return;
    }

    const token = sessionToken;
    const wsBaseUrl = toWebsocketBaseUrl(apiBaseUrl);
    let active = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;

    function connect() {
      if (!active) {
        return;
      }

      setWsState("connecting");
      ws = new WebSocket(`${wsBaseUrl}/ws/rfqs?token=${encodeURIComponent(token)}`);

      ws.onopen = () => {
        setWsState("connected");
        setWsEvents((current) => {
          const next = ["[connected] subscribed to /ws/rfqs", ...current];
          return next.slice(0, 10);
        });
      };

      ws.onmessage = (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data || ""));
        } catch {
          return;
        }

        const eventName =
          parsed &&
          typeof parsed === "object" &&
          "event" in parsed &&
          typeof parsed.event === "string"
            ? parsed.event
            : "unknown";

        const payload =
          parsed &&
          typeof parsed === "object" &&
          "payload" in parsed &&
          parsed.payload &&
          typeof parsed.payload === "object"
            ? (parsed.payload as Record<string, unknown>)
            : null;

        const id =
          payload && typeof payload.id === "string" && payload.id.length > 0
            ? payload.id.slice(0, 8)
            : null;
        const rfqId =
          payload && typeof payload.rfqId === "string" && payload.rfqId.length > 0
            ? payload.rfqId.slice(0, 8)
            : null;

        let details = "";
        if (eventName.startsWith("quote.")) {
          if (id) {
            details = `quote=${id}...`;
          }
          if (rfqId) {
            details = details ? `${details}, rfq=${rfqId}...` : `rfq=${rfqId}...`;
          }
        } else if (eventName.startsWith("rfq.")) {
          if (id) {
            details = `rfq=${id}...`;
          }
        }

        const line = details ? `[event] ${eventName} (${details})` : `[event] ${eventName}`;

        setWsEvents((current) => [line, ...current].slice(0, 10));
      };

      ws.onerror = () => {
        setWsState("error");
        setWsEvents((current) => ["[error] websocket connection failed", ...current]);
      };

      ws.onclose = () => {
        if (!active) {
          setWsState("disconnected");
          return;
        }
        setWsState("connecting");
        reconnectTimer = setTimeout(() => {
          connect();
        }, 1000);
      };
    }

    connect();

    return () => {
      active = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (ws) {
        ws.close();
      }
    };
  }, [apiBaseUrl, sessionToken]);

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

  const createRfq = useCallback(async () => {
    if (!sessionToken || !publicKey) {
      setRfqError("Authenticate first");
      return;
    }

    const expiryMinutes = Number(rfqExpiryMinutes);
    if (!Number.isFinite(expiryMinutes) || expiryMinutes <= 0) {
      setRfqError("Expiry minutes must be greater than zero");
      return;
    }

    const counterparties = rfqCounterparties
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (counterparties.length === 0) {
      setRfqError("Add at least one counterparty wallet address");
      return;
    }

    try {
      setRfqLoading(true);
      setRfqError(null);
      setRfqCreated(null);
      setRfqCopyState("idle");

      const quoteExpiresAt = new Date(
        Date.now() + Math.floor(expiryMinutes * 60 * 1000)
      ).toISOString();
      const plainPayload = {
        pair: rfqPair,
        side: rfqSide,
        notionalSize: rfqNotionalSize,
        minFillSize: rfqMinFillSize,
        quoteExpiresAt,
        counterparties,
        walletAddress: publicKey.toBase58(),
      };
      const encryptedPayload = await encryptRfqPayload(plainPayload);

      const response = await fetch(`${apiBaseUrl}/rfqs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          pair: rfqPair,
          side: rfqSide,
          notionalSize: rfqNotionalSize,
          minFillSize: rfqMinFillSize,
          quoteExpiresAt,
          counterparties,
          encryptedPayload,
        }),
      });

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
          code?: string | null;
        };
        const detailPart = errorBody.detail ? ` (${errorBody.detail})` : "";
        const codePart = errorBody.code ? ` [${errorBody.code}]` : "";
        throw new Error(
          `${errorBody.error || "Failed to create RFQ"}${codePart}${detailPart}`
        );
      }

      const created = (await response.json()) as RfqCreateResponse;
      setRfqCreated(created);
    } catch (error) {
      setRfqError(error instanceof Error ? error.message : "Failed to create RFQ");
    } finally {
      setRfqLoading(false);
    }
  }, [
    apiBaseUrl,
    publicKey,
    rfqCounterparties,
    rfqExpiryMinutes,
    rfqMinFillSize,
    rfqNotionalSize,
    rfqPair,
    rfqSide,
    sessionToken,
  ]);

  const copyRfqId = useCallback(async () => {
    if (!rfqCreated) {
      return;
    }
    try {
      await navigator.clipboard.writeText(rfqCreated.id);
      setRfqCopyState("copied");
    } catch {
      setRfqCopyState("failed");
    }
  }, [rfqCreated]);

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
      <h2 className="mb-2 text-xl font-semibold text-white">Dev Flow Test Console</h2>
      <p className="mb-6 text-sm text-[#aeb9c7]">
        Follow these steps in order. Network:{" "}
        <span className="text-[#6ee7d7]">Solana Devnet</span>
      </p>

      <div className="space-y-4">
        <div className="rounded-lg border border-[#2a323d] p-4">
          <h3 className="text-sm font-semibold text-white">
            Step 1: Connect wallet and confirm balance
          </h3>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {mounted ? (
              <WalletMultiButton className="!h-10 !rounded-md !bg-[#14b8a6] !px-4 !text-sm !font-semibold !text-[#05322d] hover:!bg-[#0d9488]" />
            ) : (
              <button
                type="button"
                disabled
                className="h-10 rounded-md bg-[#14b8a6] px-4 text-sm font-semibold text-[#05322d] opacity-70"
              >
                Select Wallet
              </button>
            )}
            <Button
              variant="outline"
              onClick={() => void disconnect()}
              disabled={!connected || connecting}
            >
              Disconnect
            </Button>
            <Button
              variant="outline"
              onClick={() => void refreshBalance()}
              disabled={!connected}
            >
              Refresh Balance
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-[#2a323d] p-4">
          <h3 className="text-sm font-semibold text-white">
            Step 2: Authenticate and create backend session
          </h3>
          <p className="mt-1 text-xs text-[#aeb9c7]">
            Choose role, then click Authenticate.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="text-xs text-[#aeb9c7]" htmlFor="dev-role-select">
              Role
            </label>
            <select
              id="dev-role-select"
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
        </div>

        <div className="rounded-lg border border-[#2a323d] p-4">
          <h3 className="text-sm font-semibold text-white">
            Step 3: Initialize Umbra account
          </h3>
          <p className="mt-1 text-xs text-[#aeb9c7]">
            Click once. Wait until Umbra status becomes <code>initialized</code>.
          </p>
          <div className="mt-3">
            <Button
              onClick={() => void initializeUmbra()}
              disabled={!sessionToken || umbraLoading}
            >
              {umbraLoading ? "Initializing Umbra..." : "Initialize Umbra Account"}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-[#2a323d] p-4">
          <h3 className="text-sm font-semibold text-white">
            Step 4: Create encrypted RFQ and watch realtime events
          </h3>
          <p className="mt-1 text-xs text-[#aeb9c7]">
            Payload is encrypted in-browser before API submit.
          </p>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-[#aeb9c7]" htmlFor="rfq-pair-input">
                Pair (BASE/QUOTE)
              </label>
              <input
                id="rfq-pair-input"
                value={rfqPair}
                onChange={(event) => setRfqPair(event.target.value.toUpperCase())}
                placeholder="SOL/USDC"
                className="h-10 rounded-md border border-[#2a323d] bg-transparent px-3 text-sm text-[#d8dee9] outline-none"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-[#aeb9c7]" htmlFor="rfq-side-select">
                Side
              </label>
              <select
                id="rfq-side-select"
                value={rfqSide}
                onChange={(event) => setRfqSide(event.target.value as RfqSide)}
                className="h-10 rounded-md border border-[#2a323d] bg-transparent px-3 text-sm text-[#d8dee9] outline-none"
              >
                <option value="buy">Buy</option>
                <option value="sell">Sell</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-[#aeb9c7]" htmlFor="rfq-notional-input">
                Notional Size
              </label>
              <input
                id="rfq-notional-input"
                value={rfqNotionalSize}
                onChange={(event) => setRfqNotionalSize(event.target.value)}
                placeholder="1000"
                className="h-10 rounded-md border border-[#2a323d] bg-transparent px-3 text-sm text-[#d8dee9] outline-none"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-[#aeb9c7]" htmlFor="rfq-min-fill-input">
                Min Fill Size
              </label>
              <input
                id="rfq-min-fill-input"
                value={rfqMinFillSize}
                onChange={(event) => setRfqMinFillSize(event.target.value)}
                placeholder="500"
                className="h-10 rounded-md border border-[#2a323d] bg-transparent px-3 text-sm text-[#d8dee9] outline-none"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-[#aeb9c7]" htmlFor="rfq-expiry-input">
                Expiry (minutes)
              </label>
              <input
                id="rfq-expiry-input"
                value={rfqExpiryMinutes}
                onChange={(event) => setRfqExpiryMinutes(event.target.value)}
                placeholder="2"
                className="h-10 rounded-md border border-[#2a323d] bg-transparent px-3 text-sm text-[#d8dee9] outline-none"
              />
            </div>

            <div className="flex flex-col gap-1 md:col-span-2">
              <label className="text-xs text-[#aeb9c7]" htmlFor="rfq-counterparties-input">
                Counterparty Wallets (comma or newline separated)
              </label>
              <textarea
                id="rfq-counterparties-input"
                value={rfqCounterparties}
                onChange={(event) => setRfqCounterparties(event.target.value)}
                rows={3}
                placeholder="Enter at least one Solana wallet address"
                className="rounded-md border border-[#2a323d] bg-transparent px-3 py-2 text-sm text-[#d8dee9] outline-none"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={() => void createRfq()} disabled={!sessionToken || rfqLoading}>
              {rfqLoading ? "Creating RFQ..." : "Create Encrypted RFQ"}
            </Button>
            <span className="text-xs text-[#aeb9c7]">
              Websocket: <span className="font-medium text-[#d8dee9]">{wsState}</span>
            </span>
          </div>

          {rfqCreated ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-[#6ee7d7]">
                Created RFQ {rfqCreated.id.slice(0, 8)}... ({rfqCreated.pair}, {rfqCreated.side})
              </p>
              <p className="text-xs text-[#aeb9c7]">
                Full RFQ ID:{" "}
                <code className="rounded bg-[#0b1118] px-2 py-1 text-[#d8dee9]">
                  {rfqCreated.id}
                </code>
              </p>
              <div className="flex items-center gap-3">
                <Button size="sm" variant="outline" onClick={() => void copyRfqId()}>
                  Copy RFQ ID
                </Button>
                {rfqCopyState === "copied" ? (
                  <span className="text-xs text-[#6ee7d7]">Copied</span>
                ) : null}
                {rfqCopyState === "failed" ? (
                  <span className="text-xs text-red-300">Copy failed</span>
                ) : null}
              </div>
            </div>
          ) : null}
          {rfqError ? <p className="mt-3 text-sm text-red-300">{rfqError}</p> : null}

          <div className="mt-4 rounded-md border border-[#2a323d] bg-[#0e141d] p-3">
            <p className="text-xs font-semibold text-white">RFQ Realtime Events (latest 10)</p>
            <div className="mt-2 space-y-1 text-xs text-[#aeb9c7]">
              {wsEvents.length === 0 ? <p>No events yet.</p> : null}
              {wsEvents.map((line, index) => (
                <p key={`${line}-${index}`}>{line}</p>
              ))}
            </div>
          </div>
        </div>
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
