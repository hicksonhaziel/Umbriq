"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { Button } from "@/components/ui/button";
import { encryptRfqPayload } from "@/lib/rfq/encryption";
import { initializeUmbraAccount, type UmbraAccountState } from "@/lib/umbra/client";

type UmbraStatus = "not_initialized" | "initializing" | "initialized" | "failed";
type RfqSide = "buy" | "sell";
type RfqUiStatus = "active" | "pending_quotes" | "expired";
type WsConnectionState = "disconnected" | "connecting" | "connected" | "error";

type UmbraStateResponse = {
  network: string;
  status: UmbraStatus;
  registrationSignatures: string[];
  accountState: UmbraAccountState;
  lastError: string | null;
};

type RfqRecord = {
  id: string;
  pair: string;
  side: RfqSide;
  notionalSize: string;
  minFillSize: string | null;
  quoteExpiresAt: string;
  status: string;
  counterparties: string[];
  createdAt: string;
  updatedAt: string;
  activeQuoteCount: number;
};

type RfqListResponse = {
  count: number;
  rfqs: RfqRecord[];
};

type RfqFormErrors = {
  pair?: string;
  notionalSize?: string;
  minFillSize?: string;
  expiryMinutes?: string;
  counterparties?: string;
};

const PAIR_SUGGESTIONS = [
  "SOL/USDC",
  "BTC/USDC",
  "ETH/USDC",
  "JTO/USDC",
  "BONK/USDC",
];

const WalletMultiButtonNoSsr = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (module) => module.WalletMultiButton
    ),
  {
    ssr: false,
    loading: () => (
      <button
        type="button"
        disabled
        className="h-10 rounded-md bg-[#4dd2b3] px-4 text-sm font-semibold text-[#032a23] opacity-80"
      >
        Connect Wallet
      </button>
    ),
  }
);

function toWebsocketBaseUrl(apiBaseUrl: string): string {
  if (apiBaseUrl.startsWith("https://")) {
    return `wss://${apiBaseUrl.slice("https://".length)}`;
  }
  if (apiBaseUrl.startsWith("http://")) {
    return `ws://${apiBaseUrl.slice("http://".length)}`;
  }
  return apiBaseUrl;
}

function isLikelySolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function parseCounterpartyCandidates(raw: string): string[] {
  return raw
    .split(/[\n,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function toUiStatus(rfq: RfqRecord): RfqUiStatus {
  const now = Date.now();
  const expiry = Date.parse(rfq.quoteExpiresAt);
  if (Number.isFinite(expiry) && expiry <= now) {
    return "expired";
  }
  if (rfq.activeQuoteCount > 0) {
    return "pending_quotes";
  }
  return "active";
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

export function InstitutionRfqDashboard() {
  const { connection } = useConnection();
  const { publicKey, connected, connecting, disconnect, signMessage } = useWallet();
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [umbraStatus, setUmbraStatus] = useState<UmbraStatus>("not_initialized");
  const [umbraNetwork, setUmbraNetwork] = useState("devnet");
  const [umbraAccountState, setUmbraAccountState] = useState<UmbraAccountState>(null);
  const [umbraLoading, setUmbraLoading] = useState(false);
  const [umbraError, setUmbraError] = useState<string | null>(null);

  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const [rfqPair, setRfqPair] = useState("SOL/USDC");
  const [rfqSide, setRfqSide] = useState<RfqSide>("buy");
  const [rfqNotionalSize, setRfqNotionalSize] = useState("1000");
  const [rfqMinFillSize, setRfqMinFillSize] = useState("500");
  const [rfqExpiryMinutes, setRfqExpiryMinutes] = useState("5");
  const [counterpartyInput, setCounterpartyInput] = useState("");
  const [counterparties, setCounterparties] = useState<string[]>([]);
  const [formErrors, setFormErrors] = useState<RfqFormErrors>({});
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);

  const [rfqs, setRfqs] = useState<RfqRecord[]>([]);
  const [rfqLoading, setRfqLoading] = useState(false);
  const [rfqError, setRfqError] = useState<string | null>(null);

  const [searchFilter, setSearchFilter] = useState("");
  const [pairFilter, setPairFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState<"all" | RfqSide>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | RfqUiStatus>("all");

  const [wsState, setWsState] = useState<WsConnectionState>("disconnected");

  const walletAddress = useMemo(() => publicKey?.toBase58() || null, [publicKey]);

  const refreshBalance = useCallback(async () => {
    if (!publicKey) {
      setBalanceSol(null);
      return;
    }

    try {
      setBalanceLoading(true);
      setBalanceError(null);
      const lamports = await connection.getBalance(publicKey, "confirmed");
      setBalanceSol(lamports / LAMPORTS_PER_SOL);
    } catch {
      setBalanceError("Could not fetch balance");
      setBalanceSol(null);
    } finally {
      setBalanceLoading(false);
    }
  }, [connection, publicKey]);

  const fetchUmbraState = useCallback(
    async (token: string) => {
      const response = await fetch(`${apiBaseUrl}/umbra/account`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        throw new Error("Failed to fetch Umbra state");
      }

      const data = (await response.json()) as UmbraStateResponse;
      setUmbraStatus(data.status);
      setUmbraNetwork(data.network || "devnet");
      setUmbraAccountState(data.accountState ?? null);
      setUmbraError(data.lastError ?? null);
    },
    [apiBaseUrl]
  );

  const fetchRfqs = useCallback(
    async (tokenOverride?: string | null) => {
      const token = tokenOverride || sessionToken;
      if (!token) {
        setRfqs([]);
        return;
      }

      try {
        setRfqLoading(true);
        setRfqError(null);
        const response = await fetch(`${apiBaseUrl}/rfqs`, {
          headers: {
            authorization: `Bearer ${token}`,
          },
        });
        if (!response.ok) {
          const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(errorBody.error || "Failed to load RFQs");
        }
        const data = (await response.json()) as RfqListResponse;
        setRfqs(Array.isArray(data.rfqs) ? data.rfqs : []);
      } catch (error) {
        setRfqError(error instanceof Error ? error.message : "Failed to load RFQs");
      } finally {
        setRfqLoading(false);
      }
    },
    [apiBaseUrl, sessionToken]
  );

  useEffect(() => {
    if (!sessionToken) {
      return;
    }

    const token = sessionToken;
    const wsBaseUrl = toWebsocketBaseUrl(apiBaseUrl);
    let active = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    function queueRefresh() {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(() => {
        void fetchRfqs();
      }, 250);
    }

    function connectWs() {
      if (!active) {
        return;
      }
      setWsState("connecting");
      ws = new WebSocket(
        `${wsBaseUrl}/ws/rfqs?token=${encodeURIComponent(token)}`
      );

      ws.onopen = () => {
        setWsState("connected");
      };

      ws.onerror = () => {
        setWsState("error");
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
            : "";
        if (eventName.startsWith("rfq.") || eventName.startsWith("quote.")) {
          queueRefresh();
        }
      };

      ws.onclose = () => {
        if (!active) {
          setWsState("disconnected");
          return;
        }
        setWsState("connecting");
        reconnectTimer = setTimeout(connectWs, 1000);
      };
    }

    connectWs();
    return () => {
      active = false;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (ws) {
        ws.close();
      }
    };
  }, [apiBaseUrl, fetchRfqs, sessionToken]);

  const authenticateInstitution = useCallback(async () => {
    if (!walletAddress) {
      setAuthError("Connect wallet first");
      return;
    }
    if (!signMessage) {
      setAuthError("Wallet does not support message signing");
      return;
    }

    try {
      setAuthLoading(true);
      setAuthError(null);
      setSubmitError(null);

      const nonceRes = await fetch(`${apiBaseUrl}/auth/nonce`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      if (!nonceRes.ok) {
        throw new Error("Failed to request nonce");
      }
      const nonceData = await nonceRes.json();

      const signatureBytes = await signMessage(new TextEncoder().encode(nonceData.message));
      const verifyRes = await fetch(`${apiBaseUrl}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          walletAddress,
          signature: bs58.encode(signatureBytes),
          role: "institution",
        }),
      });
      const verifyData = (await verifyRes.json().catch(() => ({}))) as {
        sessionToken?: string;
        error?: string;
      };
      if (!verifyRes.ok || !verifyData.sessionToken) {
        throw new Error(verifyData.error || "Authentication failed");
      }

      setSessionToken(verifyData.sessionToken);
      await Promise.all([
        fetchUmbraState(verifyData.sessionToken),
        refreshBalance(),
        fetchRfqs(verifyData.sessionToken),
      ]);
    } catch (error) {
      setSessionToken(null);
      setWsState("disconnected");
      setRfqs([]);
      setAuthError(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setAuthLoading(false);
    }
  }, [
    apiBaseUrl,
    fetchRfqs,
    fetchUmbraState,
    refreshBalance,
    signMessage,
    walletAddress,
  ]);

  const logoutSession = useCallback(async () => {
    if (!sessionToken) {
      return;
    }
    try {
      await fetch(`${apiBaseUrl}/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
    } finally {
      setSessionToken(null);
      setWsState("disconnected");
      setRfqs([]);
      setUmbraStatus("not_initialized");
      setUmbraAccountState(null);
      setUmbraError(null);
      setSubmitSuccess(null);
    }
  }, [apiBaseUrl, sessionToken]);

  const initializeUmbra = useCallback(async () => {
    if (!sessionToken || !walletAddress) {
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
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          status: "initializing",
          network: "devnet",
          registrationSignatures: [],
          accountState: null,
          lastError: null,
        }),
      });

      const result = await initializeUmbraAccount(walletAddress);

      const persistRes = await fetch(`${apiBaseUrl}/umbra/account`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          status: "initialized",
          network: result.network,
          registrationSignatures: result.registrationSignatures,
          accountState: result.accountState,
          lastError: null,
        }),
      });
      if (!persistRes.ok) {
        throw new Error("Failed to persist Umbra state");
      }

      await fetchUmbraState(sessionToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Umbra initialization failed";
      setUmbraStatus("failed");
      setUmbraError(message);
      await fetch(`${apiBaseUrl}/umbra/account`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          status: "failed",
          network: umbraNetwork,
          registrationSignatures: [],
          accountState: umbraAccountState,
          lastError: message,
        }),
      }).catch(() => null);
    } finally {
      setUmbraLoading(false);
    }
  }, [
    apiBaseUrl,
    fetchUmbraState,
    sessionToken,
    umbraAccountState,
    umbraNetwork,
    walletAddress,
  ]);

  const addCounterparties = useCallback(() => {
    const candidates = parseCounterpartyCandidates(counterpartyInput);
    if (candidates.length === 0) {
      return;
    }

    setCounterparties((current) => {
      const merged = [...current];
      for (const candidate of candidates) {
        if (!isLikelySolanaAddress(candidate)) {
          continue;
        }
        if (!merged.includes(candidate)) {
          merged.push(candidate);
        }
      }
      return merged;
    });
    setCounterpartyInput("");
  }, [counterpartyInput]);

  const removeCounterparty = useCallback((wallet: string) => {
    setCounterparties((current) => current.filter((value) => value !== wallet));
  }, []);

  const validateForm = useCallback((): RfqFormErrors => {
    const errors: RfqFormErrors = {};
    const pair = rfqPair.trim().toUpperCase();
    const notional = Number(rfqNotionalSize);
    const minFill = Number(rfqMinFillSize);
    const expiryMinutes = Number(rfqExpiryMinutes);

    if (!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(pair)) {
      errors.pair = "Pair must follow BASE/QUOTE format (for example SOL/USDC)";
    }
    if (!Number.isFinite(notional) || notional <= 0) {
      errors.notionalSize = "Notional size must be greater than zero";
    }
    if (!Number.isFinite(minFill) || minFill <= 0) {
      errors.minFillSize = "Min fill size must be greater than zero";
    } else if (Number.isFinite(notional) && minFill > notional) {
      errors.minFillSize = "Min fill size cannot exceed notional size";
    }
    if (!Number.isFinite(expiryMinutes) || expiryMinutes <= 0) {
      errors.expiryMinutes = "Expiry minutes must be greater than zero";
    }
    if (counterparties.length === 0) {
      errors.counterparties = "Add at least one counterparty wallet";
    }

    return errors;
  }, [counterparties.length, rfqExpiryMinutes, rfqMinFillSize, rfqNotionalSize, rfqPair]);

  const submitRfq = useCallback(async () => {
    if (!sessionToken || !walletAddress) {
      setSubmitError("Authenticate as institution first");
      return;
    }
    if (umbraStatus !== "initialized") {
      setSubmitError("Initialize Umbra account before creating RFQ");
      return;
    }

    const errors = validateForm();
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    try {
      setSubmitLoading(true);
      setSubmitError(null);
      setSubmitSuccess(null);

      const quoteExpiresAt = new Date(
        Date.now() + Math.floor(Number(rfqExpiryMinutes) * 60 * 1000)
      ).toISOString();
      const pair = rfqPair.trim().toUpperCase();

      const encryptedPayload = await encryptRfqPayload({
        pair,
        side: rfqSide,
        notionalSize: rfqNotionalSize,
        minFillSize: rfqMinFillSize,
        quoteExpiresAt,
        counterparties,
      });

      const response = await fetch(`${apiBaseUrl}/rfqs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          pair,
          side: rfqSide,
          notionalSize: rfqNotionalSize,
          minFillSize: rfqMinFillSize,
          quoteExpiresAt,
          counterparties,
          encryptedPayload,
        }),
      });

      const body = (await response.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
        detail?: string;
      };
      if (!response.ok) {
        const detail = body.detail ? ` (${body.detail})` : "";
        throw new Error((body.error || "Failed to create RFQ") + detail);
      }

      setSubmitSuccess(body.id || "RFQ created");
      setCounterparties([]);
      setCounterpartyInput("");
      setFormErrors({});
      await fetchRfqs();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to create RFQ");
    } finally {
      setSubmitLoading(false);
    }
  }, [
    apiBaseUrl,
    counterparties,
    fetchRfqs,
    rfqExpiryMinutes,
    rfqMinFillSize,
    rfqNotionalSize,
    rfqPair,
    rfqSide,
    sessionToken,
    umbraStatus,
    validateForm,
    walletAddress,
  ]);

  const filteredRfqs = useMemo(() => {
    const normalizedSearch = searchFilter.trim().toLowerCase();
    return rfqs.filter((rfq) => {
      const uiStatus = toUiStatus(rfq);
      if (statusFilter !== "all" && uiStatus !== statusFilter) {
        return false;
      }
      if (pairFilter !== "all" && rfq.pair !== pairFilter) {
        return false;
      }
      if (sideFilter !== "all" && rfq.side !== sideFilter) {
        return false;
      }
      if (normalizedSearch.length > 0 && !rfq.id.toLowerCase().includes(normalizedSearch)) {
        return false;
      }
      return true;
    });
  }, [pairFilter, rfqs, searchFilter, sideFilter, statusFilter]);

  const pairOptions = useMemo(() => {
    const unique = new Set<string>(PAIR_SUGGESTIONS);
    for (const rfq of rfqs) {
      unique.add(rfq.pair);
    }
    return Array.from(unique);
  }, [rfqs]);

  const canSubmit = Boolean(sessionToken) && umbraStatus === "initialized" && !submitLoading;

  return (
    <main className="min-h-screen bg-[#0b121b] px-6 py-10 text-[#dbe5f3]">
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <section className="rounded-2xl border border-[#243246] bg-gradient-to-r from-[#101b2a] to-[#132034] p-6 shadow-[0_10px_30px_rgba(8,14,24,0.35)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-[#8ea1bb]">
                Umbriq / Institution Desk
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-white">
                RFQ Creation Dashboard
              </h1>
              <p className="mt-2 text-sm text-[#93a6c1]">
                Create encrypted RFQs, monitor quote activity, and manage active windows.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-[#31445f] bg-[#0f1a2b] px-3 py-1 text-[#a8b8cc]">
                WS: {wsState}
              </span>
              <span className="rounded-full border border-[#31445f] bg-[#0f1a2b] px-3 py-1 text-[#a8b8cc]">
                Umbra: {umbraStatus}
              </span>
              <span className="rounded-full border border-[#31445f] bg-[#0f1a2b] px-3 py-1 text-[#a8b8cc]">
                Session: {sessionToken ? "active" : "none"}
              </span>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.05fr_1.3fr]">
          <div className="space-y-6">
            <article className="rounded-2xl border border-[#233147] bg-[#111b2b] p-5 transition-colors hover:border-[#2f4462]">
              <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[#93a6c1]">
                Session Setup
              </h2>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <WalletMultiButtonNoSsr className="!h-10 !rounded-md !bg-[#4dd2b3] !px-4 !text-sm !font-semibold !text-[#032a23] hover:!bg-[#3ec0a2]" />
                <Button
                  variant="outline"
                  onClick={() => void disconnect()}
                  disabled={!connected || connecting}
                >
                  Disconnect
                </Button>
                <Button variant="outline" onClick={() => void refreshBalance()} disabled={!connected}>
                  {balanceLoading ? "Loading..." : "Refresh Balance"}
                </Button>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button onClick={() => void authenticateInstitution()} disabled={!connected || authLoading}>
                  {authLoading ? "Authenticating..." : "Authenticate Institution"}
                </Button>
                <Button variant="outline" onClick={() => void logoutSession()} disabled={!sessionToken}>
                  Logout Session
                </Button>
                <Button onClick={() => void initializeUmbra()} disabled={!sessionToken || umbraLoading}>
                  {umbraLoading ? "Initializing Umbra..." : "Initialize Umbra"}
                </Button>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-[#9aabc1]">
                <div className="rounded-md border border-[#223247] bg-[#0d1623] p-3">
                  <p className="text-[#7f93af]">Wallet</p>
                  <p className="mt-1 text-[#dbe5f3]">
                    {walletAddress
                      ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
                      : "Not connected"}
                  </p>
                </div>
                <div className="rounded-md border border-[#223247] bg-[#0d1623] p-3">
                  <p className="text-[#7f93af]">Balance</p>
                  <p className="mt-1 text-[#dbe5f3]">
                    {balanceSol === null ? "-" : `${balanceSol.toFixed(4)} SOL`}
                  </p>
                </div>
                <div className="rounded-md border border-[#223247] bg-[#0d1623] p-3">
                  <p className="text-[#7f93af]">Session</p>
                  <p className="mt-1 text-[#dbe5f3]">
                    {sessionToken ? `${sessionToken.slice(0, 8)}...` : "Not authenticated"}
                  </p>
                </div>
                <div className="rounded-md border border-[#223247] bg-[#0d1623] p-3">
                  <p className="text-[#7f93af]">Umbra Network</p>
                  <p className="mt-1 text-[#dbe5f3]">{umbraNetwork}</p>
                </div>
              </div>

              {authError ? <p className="mt-3 text-sm text-red-300">{authError}</p> : null}
              {umbraError ? <p className="mt-2 text-sm text-red-300">{umbraError}</p> : null}
              {balanceError ? <p className="mt-2 text-sm text-red-300">{balanceError}</p> : null}

              {umbraAccountState ? (
                <p className="mt-3 text-xs text-[#8ca0bc]">
                  Flags: initialised={String(umbraAccountState.isInitialised)} | anonymous=
                  {String(umbraAccountState.isActiveForAnonymousUsage)} | commitment=
                  {String(umbraAccountState.isUserCommitmentRegistered)} | x25519=
                  {String(umbraAccountState.isUserAccountX25519KeyRegistered)}
                </p>
              ) : null}
            </article>

            <article className="rounded-2xl border border-[#233147] bg-[#111b2b] p-5 transition-colors hover:border-[#2f4462]">
              <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[#93a6c1]">
                New RFQ
              </h2>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label className="mb-1 block text-xs text-[#8ca0bc]" htmlFor="rfq-pair">
                    Pair Selector
                  </label>
                  <input
                    id="rfq-pair"
                    value={rfqPair}
                    onChange={(event) => setRfqPair(event.target.value.toUpperCase())}
                    list="pair-suggestions"
                    className="h-10 w-full rounded-md border border-[#2b3d56] bg-[#0e1725] px-3 text-sm text-[#dbe5f3] outline-none transition focus:border-[#4dd2b3]"
                    placeholder="SOL/USDC"
                  />
                  <datalist id="pair-suggestions">
                    {PAIR_SUGGESTIONS.map((pair) => (
                      <option key={pair} value={pair} />
                    ))}
                  </datalist>
                  {formErrors.pair ? (
                    <p className="mt-1 text-xs text-red-300">{formErrors.pair}</p>
                  ) : null}
                </div>

                <div>
                  <label className="mb-1 block text-xs text-[#8ca0bc]" htmlFor="rfq-side">
                    Side
                  </label>
                  <select
                    id="rfq-side"
                    value={rfqSide}
                    onChange={(event) => setRfqSide(event.target.value as RfqSide)}
                    className="h-10 w-full rounded-md border border-[#2b3d56] bg-[#0e1725] px-3 text-sm text-[#dbe5f3] outline-none transition focus:border-[#4dd2b3]"
                  >
                    <option value="buy">Buy</option>
                    <option value="sell">Sell</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs text-[#8ca0bc]" htmlFor="rfq-expiry">
                    Expiry (minutes)
                  </label>
                  <input
                    id="rfq-expiry"
                    value={rfqExpiryMinutes}
                    onChange={(event) => setRfqExpiryMinutes(event.target.value)}
                    className="h-10 w-full rounded-md border border-[#2b3d56] bg-[#0e1725] px-3 text-sm text-[#dbe5f3] outline-none transition focus:border-[#4dd2b3]"
                  />
                  {formErrors.expiryMinutes ? (
                    <p className="mt-1 text-xs text-red-300">{formErrors.expiryMinutes}</p>
                  ) : null}
                </div>

                <div>
                  <label className="mb-1 block text-xs text-[#8ca0bc]" htmlFor="rfq-notional">
                    Notional Size
                  </label>
                  <input
                    id="rfq-notional"
                    value={rfqNotionalSize}
                    onChange={(event) => setRfqNotionalSize(event.target.value)}
                    className="h-10 w-full rounded-md border border-[#2b3d56] bg-[#0e1725] px-3 text-sm text-[#dbe5f3] outline-none transition focus:border-[#4dd2b3]"
                  />
                  {formErrors.notionalSize ? (
                    <p className="mt-1 text-xs text-red-300">{formErrors.notionalSize}</p>
                  ) : null}
                </div>

                <div>
                  <label className="mb-1 block text-xs text-[#8ca0bc]" htmlFor="rfq-min-fill">
                    Min Fill Size
                  </label>
                  <input
                    id="rfq-min-fill"
                    value={rfqMinFillSize}
                    onChange={(event) => setRfqMinFillSize(event.target.value)}
                    className="h-10 w-full rounded-md border border-[#2b3d56] bg-[#0e1725] px-3 text-sm text-[#dbe5f3] outline-none transition focus:border-[#4dd2b3]"
                  />
                  {formErrors.minFillSize ? (
                    <p className="mt-1 text-xs text-red-300">{formErrors.minFillSize}</p>
                  ) : null}
                </div>
              </div>

              <div className="mt-4 space-y-2">
                <label className="block text-xs text-[#8ca0bc]" htmlFor="counterparty-input">
                  Counterparty Picker
                </label>
                <div className="flex gap-2">
                  <input
                    id="counterparty-input"
                    value={counterpartyInput}
                    onChange={(event) => setCounterpartyInput(event.target.value)}
                    placeholder="Paste one or many wallet addresses"
                    className="h-10 w-full rounded-md border border-[#2b3d56] bg-[#0e1725] px-3 text-sm text-[#dbe5f3] outline-none transition focus:border-[#4dd2b3]"
                  />
                  <Button type="button" variant="outline" onClick={() => addCounterparties()}>
                    Add
                  </Button>
                </div>

                {counterparties.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {counterparties.map((wallet) => (
                      <button
                        key={wallet}
                        type="button"
                        onClick={() => removeCounterparty(wallet)}
                        className="rounded-full border border-[#34506f] bg-[#122238] px-3 py-1 text-xs text-[#dbe5f3] transition hover:border-[#4dd2b3] hover:text-[#4dd2b3]"
                        title="Remove counterparty"
                      >
                        {wallet.slice(0, 4)}...{wallet.slice(-4)} ×
                      </button>
                    ))}
                  </div>
                ) : null}
                {formErrors.counterparties ? (
                  <p className="text-xs text-red-300">{formErrors.counterparties}</p>
                ) : null}
              </div>

              <div className="mt-5 flex items-center gap-3">
                <Button onClick={() => void submitRfq()} disabled={!canSubmit}>
                  {submitLoading ? "Submitting RFQ..." : "Create RFQ"}
                </Button>
                <Button variant="outline" onClick={() => void fetchRfqs()} disabled={!sessionToken}>
                  Refresh List
                </Button>
              </div>

              {submitError ? <p className="mt-3 text-sm text-red-300">{submitError}</p> : null}
              {submitSuccess ? (
                <p className="mt-3 text-sm text-[#56d5b9]">
                  RFQ created successfully: <code>{submitSuccess}</code>
                </p>
              ) : null}
            </article>
          </div>

          <article className="rounded-2xl border border-[#233147] bg-[#111b2b] p-5 transition-colors hover:border-[#2f4462]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[#93a6c1]">
                RFQ Book
              </h2>
              <p className="text-xs text-[#8ca0bc]">
                {filteredRfqs.length} of {rfqs.length} RFQs
              </p>
            </div>

            <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <input
                value={searchFilter}
                onChange={(event) => setSearchFilter(event.target.value)}
                placeholder="Search by RFQ ID"
                className="h-10 rounded-md border border-[#2b3d56] bg-[#0e1725] px-3 text-sm text-[#dbe5f3] outline-none transition focus:border-[#4dd2b3]"
              />

              <select
                value={pairFilter}
                onChange={(event) => setPairFilter(event.target.value)}
                className="h-10 rounded-md border border-[#2b3d56] bg-[#0e1725] px-3 text-sm text-[#dbe5f3] outline-none transition focus:border-[#4dd2b3]"
              >
                <option value="all">All pairs</option>
                {pairOptions.map((pair) => (
                  <option key={pair} value={pair}>
                    {pair}
                  </option>
                ))}
              </select>

              <select
                value={sideFilter}
                onChange={(event) => setSideFilter(event.target.value as "all" | RfqSide)}
                className="h-10 rounded-md border border-[#2b3d56] bg-[#0e1725] px-3 text-sm text-[#dbe5f3] outline-none transition focus:border-[#4dd2b3]"
              >
                <option value="all">All sides</option>
                <option value="buy">Buy</option>
                <option value="sell">Sell</option>
              </select>

              <select
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as "all" | RfqUiStatus)
                }
                className="h-10 rounded-md border border-[#2b3d56] bg-[#0e1725] px-3 text-sm text-[#dbe5f3] outline-none transition focus:border-[#4dd2b3]"
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="pending_quotes">Pending quotes</option>
                <option value="expired">Expired</option>
              </select>
            </div>

            {rfqError ? <p className="mt-3 text-sm text-red-300">{rfqError}</p> : null}
            {rfqLoading ? (
              <p className="mt-4 text-sm text-[#8ca0bc] motion-safe:animate-pulse">
                Loading RFQs...
              </p>
            ) : null}

            <div className="mt-4 space-y-3">
              {!rfqLoading && filteredRfqs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[#30435f] bg-[#0d1624] px-4 py-6 text-center text-sm text-[#8ca0bc]">
                  No RFQs match current filters.
                </div>
              ) : null}

              {filteredRfqs.map((rfq) => {
                const uiStatus = toUiStatus(rfq);
                const statusStyles = {
                  active: "border-[#2f5960] bg-[#10252b] text-[#74d9cc]",
                  pending_quotes: "border-[#63572f] bg-[#2a2310] text-[#f3dc8b]",
                  expired: "border-[#5a2f35] bg-[#2b1114] text-[#f1a8b2]",
                }[uiStatus];

                return (
                  <div
                    key={rfq.id}
                    className="rounded-lg border border-[#2b3d56] bg-[#0f1928] p-4 transition duration-300 hover:border-[#4dd2b3] hover:shadow-[0_8px_20px_rgba(10,20,35,0.35)]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="text-xs text-[#9bb0ca]">{rfq.id}</code>
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${statusStyles}`}>
                        {uiStatus === "pending_quotes" ? "pending quotes" : uiStatus}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-3 text-sm text-[#dbe5f3]">
                      <p>
                        {rfq.pair} / {rfq.side}
                      </p>
                      <p className="text-right">
                        Quotes: <span className="font-semibold">{rfq.activeQuoteCount}</span>
                      </p>
                      <p>
                        Notional: <span className="font-semibold">{rfq.notionalSize}</span>
                      </p>
                      <p className="text-right">
                        Min Fill: <span className="font-semibold">{rfq.minFillSize || "-"}</span>
                      </p>
                    </div>
                    <p className="mt-2 text-xs text-[#8ca0bc]">
                      Expires: {formatDateTime(rfq.quoteExpiresAt)}
                    </p>
                  </div>
                );
              })}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
