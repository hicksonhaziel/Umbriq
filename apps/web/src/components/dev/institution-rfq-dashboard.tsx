"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { useUmbraNetwork } from "@/components/solana/wallet-provider";
import { Button } from "@/components/ui/button";
import { encryptRfqPayload } from "@/lib/rfq/encryption";
import { initializeUmbraAccount, type UmbraAccountState } from "@/lib/umbra/client";
import {
  executeUmbraBrowserSettlement,
  type UmbraSettlementProgressEvent,
} from "@/lib/umbra/settlement";
import {
  decimalToBaseUnits,
  getUmbraNetworkConfig,
  type UmbraNetwork,
} from "@/lib/umbra/network-config";

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

type RankedQuote = {
  id: string;
  rfqId: string;
  marketMakerWallet: string;
  allInPrice: string;
  guaranteedSize: string;
  validUntil: string;
  settlementConstraints: Record<string, unknown>;
  encryptedPayload: Record<string, unknown>;
  signature: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  rank: number;
};

type RankedQuotesResponse = {
  rfqId: string;
  rfqSide: RfqSide;
  count: number;
  quotes: RankedQuote[];
};

type SettlementStatus = "accepted" | "settling" | "settled" | "failed";

type SettlementRecord = {
  id: string;
  rfqId: string;
  quoteId: string;
  status: SettlementStatus;
  umbraTxSignature: string | null;
  receipt: Record<string, unknown>;
  proof: Record<string, unknown>;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  rfq: {
    id: string;
    institutionWallet: string;
    pair: string;
    side: RfqSide;
    status: string;
    quoteExpiresAt: string;
  };
  quote: {
    id: string;
    marketMakerWallet: string;
    allInPrice: string;
    guaranteedSize: string;
    status: string;
    validUntil: string;
  };
};

type SettlementConfigStatus = {
  executionModel: string;
  provider: string;
  ready: boolean;
  defaultNetwork: string;
  supportedNetworks: Record<
    string,
    {
      network: string;
      label: string;
      rpcUrl: string;
      rpcSubscriptionsUrl: string;
      mint: string;
      mintDecimals: number;
      explorerCluster: string;
      indexerApiEndpoint: string | null;
    }
  >;
  issues: string[];
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

function formatTokenAmountFromBaseUnits(value: string, decimals: number): string {
  const normalized = value.replace(/^0+/, "") || "0";

  if (decimals === 0) {
    return normalized;
  }

  const padded =
    normalized.length <= decimals
      ? normalized.padStart(decimals + 1, "0")
      : normalized;
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

function shortAddress(address: string): string {
  if (address.length <= 10) {
    return address;
  }
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function toExplorerTxUrl(signature: string, cluster: string): string {
  if (!signature) {
    return "";
  }
  const base = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
  if (cluster === "mainnet-beta" || cluster === "mainnet") {
    return base;
  }
  return `${base}?cluster=${encodeURIComponent(cluster || "devnet")}`;
}

function getSettlementProgressLabel(status: SettlementStatus): string {
  if (status === "accepted") {
    return "Pending";
  }
  if (status === "settling") {
    return "In Progress";
  }
  if (status === "settled") {
    return "Complete";
  }
  return "Failed";
}

export function InstitutionRfqDashboard() {
  const { connection } = useConnection();
  const { publicKey, connected, connecting, disconnect, signMessage } = useWallet();
  const { network: selectedNetwork } = useUmbraNetwork();
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [umbraStatus, setUmbraStatus] = useState<UmbraStatus>("not_initialized");
  const [umbraAccountState, setUmbraAccountState] = useState<UmbraAccountState>(null);
  const [umbraLoading, setUmbraLoading] = useState(false);
  const [umbraError, setUmbraError] = useState<string | null>(null);

  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [settlementMintBalanceRaw, setSettlementMintBalanceRaw] = useState<string | null>(null);
  const [settlementMintTokenAccountCount, setSettlementMintTokenAccountCount] = useState(0);
  const [settlementMintBalanceLoading, setSettlementMintBalanceLoading] = useState(false);
  const [settlementMintBalanceError, setSettlementMintBalanceError] = useState<string | null>(
    null
  );

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
  const [selectedRfqId, setSelectedRfqId] = useState<string | null>(null);
  const [rankedQuotes, setRankedQuotes] = useState<RankedQuote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [quotesError, setQuotesError] = useState<string | null>(null);

  const [quoteToConfirm, setQuoteToConfirm] = useState<RankedQuote | null>(null);
  const [acceptingQuoteId, setAcceptingQuoteId] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const [settlementByRfqId, setSettlementByRfqId] = useState<Record<string, string>>({});
  const [settlementDetailsById, setSettlementDetailsById] = useState<
    Record<string, SettlementRecord>
  >({});
  const [settlementLoadingId, setSettlementLoadingId] = useState<string | null>(null);
  const [settlementError, setSettlementError] = useState<string | null>(null);
  const [settlementProgressMessage, setSettlementProgressMessage] = useState<string | null>(null);
  const [showReceiptProof, setShowReceiptProof] = useState(false);
  const [settlementConfig, setSettlementConfig] = useState<SettlementConfigStatus | null>(null);
  const [settlementConfigLoading, setSettlementConfigLoading] = useState(false);
  const [settlementConfigError, setSettlementConfigError] = useState<string | null>(null);

  const walletAddress = useMemo(() => publicKey?.toBase58() || null, [publicKey]);
  const networkConfig = useMemo(
    () => getUmbraNetworkConfig(selectedNetwork),
    [selectedNetwork]
  );
  const explorerCluster = networkConfig.explorerCluster;

  const refreshSettlementMintBalance = useCallback(async () => {
    if (!publicKey) {
      setSettlementMintBalanceRaw(null);
      setSettlementMintTokenAccountCount(0);
      setSettlementMintBalanceError(null);
      return;
    }

    try {
      setSettlementMintBalanceLoading(true);
      setSettlementMintBalanceError(null);

      const mint = new PublicKey(networkConfig.mint);
      const response = await connection.getParsedTokenAccountsByOwner(
        publicKey,
        { mint },
        "confirmed"
      );

      let total = BigInt(0);
      for (const account of response.value) {
        const parsedInfo = account.account.data.parsed?.info;
        const amount = parsedInfo?.tokenAmount?.amount;
        if (typeof amount === "string" && amount.trim().length > 0) {
          total += BigInt(amount);
        }
      }

      setSettlementMintBalanceRaw(total.toString());
      setSettlementMintTokenAccountCount(response.value.length);
    } catch {
      setSettlementMintBalanceError("Could not fetch settlement mint balance");
      setSettlementMintBalanceRaw(null);
      setSettlementMintTokenAccountCount(0);
    } finally {
      setSettlementMintBalanceLoading(false);
    }
  }, [connection, networkConfig.mint, publicKey]);

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

  useEffect(() => {
    if (!publicKey) {
      setSettlementMintBalanceRaw(null);
      setSettlementMintTokenAccountCount(0);
      setSettlementMintBalanceError(null);
      return;
    }

    void refreshSettlementMintBalance();
  }, [publicKey, refreshSettlementMintBalance, selectedNetwork]);

  const fetchUmbraState = useCallback(
    async (token: string) => {
      const response = await fetch(
        `${apiBaseUrl}/umbra/account?network=${encodeURIComponent(selectedNetwork)}`,
        {
        headers: {
          authorization: `Bearer ${token}`,
        },
        }
      );
      if (!response.ok) {
        throw new Error("Failed to fetch Umbra state");
      }

      const data = (await response.json()) as UmbraStateResponse;
      setUmbraStatus(data.status);
      setUmbraAccountState(data.accountState ?? null);
      setUmbraError(data.lastError ?? null);
    },
    [apiBaseUrl, selectedNetwork]
  );

  const fetchRfqs = useCallback(
    async (tokenOverride?: string | null) => {
      const token = tokenOverride || sessionToken;
      if (!token) {
        setRfqs([]);
        return [] as RfqRecord[];
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
        const rows = Array.isArray(data.rfqs) ? data.rfqs : [];
        setRfqs(rows);
        return rows;
      } catch (error) {
        setRfqError(error instanceof Error ? error.message : "Failed to load RFQs");
        return [] as RfqRecord[];
      } finally {
        setRfqLoading(false);
      }
    },
    [apiBaseUrl, sessionToken]
  );

  useEffect(() => {
    setSessionToken(null);
    setWsState("disconnected");
    setAuthError(null);
    setRfqs([]);
    setSelectedRfqId(null);
    setRankedQuotes([]);
    setQuoteToConfirm(null);
    setSettlementByRfqId({});
    setSettlementDetailsById({});
    setSettlementError(null);
    setSettlementProgressMessage(null);
    setSettlementConfig(null);
    setSettlementConfigError(null);
    setAcceptError(null);
    setUmbraStatus("not_initialized");
    setUmbraAccountState(null);
    setUmbraError(null);
    setSubmitSuccess(null);
  }, [selectedNetwork]);

  const selectedRfq = useMemo(() => {
    if (rfqs.length === 0) {
      return null;
    }
    if (!selectedRfqId) {
      return rfqs[0];
    }
    return rfqs.find((rfq) => rfq.id === selectedRfqId) || rfqs[0];
  }, [rfqs, selectedRfqId]);

  const activeSettlement = useMemo(() => {
    if (!selectedRfq) {
      return null;
    }
    const settlementId = settlementByRfqId[selectedRfq.id];
    if (!settlementId) {
      return null;
    }
    return settlementDetailsById[settlementId] || null;
  }, [selectedRfq, settlementByRfqId, settlementDetailsById]);

  const settlementTargetQuote = useMemo(() => {
    if (quoteToConfirm) {
      return quoteToConfirm;
    }

    if (activeSettlement) {
      return {
        id: activeSettlement.quote.id,
        rfqId: activeSettlement.rfq.id,
        marketMakerWallet: activeSettlement.quote.marketMakerWallet,
        allInPrice: activeSettlement.quote.allInPrice,
        guaranteedSize: activeSettlement.quote.guaranteedSize,
        validUntil: activeSettlement.quote.validUntil,
        settlementConstraints: {},
        encryptedPayload: {},
        signature: "",
        status: activeSettlement.quote.status,
        createdAt: activeSettlement.createdAt,
        updatedAt: activeSettlement.updatedAt,
        rank: 0,
      } as RankedQuote;
    }

    return rankedQuotes[0] || null;
  }, [activeSettlement, quoteToConfirm, rankedQuotes]);

  const fetchQuotesForRfq = useCallback(
    async (rfqId: string, tokenOverride?: string | null) => {
      const token = tokenOverride || sessionToken;
      if (!token) {
        setRankedQuotes([]);
        return [];
      }

      try {
        setQuotesLoading(true);
        setQuotesError(null);
        const response = await fetch(`${apiBaseUrl}/rfqs/${rfqId}/quotes`, {
          headers: {
            authorization: `Bearer ${token}`,
          },
        });
        const body = (await response.json().catch(() => ({}))) as
          | RankedQuotesResponse
          | { error?: string };
        if (!response.ok) {
          throw new Error("error" in body ? body.error || "Failed to load quotes" : "Failed to load quotes");
        }

        const data = body as RankedQuotesResponse;
        const rows = Array.isArray(data.quotes) ? data.quotes : [];
        setRankedQuotes(rows);
        return rows;
      } catch (error) {
        setQuotesError(error instanceof Error ? error.message : "Failed to load quotes");
        setRankedQuotes([]);
        return [];
      } finally {
        setQuotesLoading(false);
      }
    },
    [apiBaseUrl, sessionToken]
  );

  const fetchSettlementById = useCallback(
    async (
      settlementId: string,
      tokenOverride?: string | null,
      options?: { silent?: boolean }
    ): Promise<SettlementRecord | null> => {
      const token = tokenOverride || sessionToken;
      if (!token || !settlementId) {
        return null;
      }

      try {
        if (!options?.silent) {
          setSettlementLoadingId(settlementId);
          setSettlementError(null);
        }
        const response = await fetch(`${apiBaseUrl}/settlements/${settlementId}`, {
          headers: {
            authorization: `Bearer ${token}`,
          },
        });
        const body = (await response.json().catch(() => ({}))) as
          | SettlementRecord
          | { error?: string };
        if (!response.ok) {
          throw new Error("error" in body ? body.error || "Failed to load settlement" : "Failed to load settlement");
        }

        const settlement = body as SettlementRecord;
        setSettlementDetailsById((current) => ({
          ...current,
          [settlement.id]: settlement,
        }));
        return settlement;
      } catch (error) {
        if (!options?.silent) {
          setSettlementError(
            error instanceof Error ? error.message : "Failed to load settlement"
          );
        }
        return null;
      } finally {
        if (!options?.silent) {
          setSettlementLoadingId(null);
        }
      }
    },
    [apiBaseUrl, sessionToken]
  );

  const fetchSettlementConfig = useCallback(
    async (tokenOverride?: string | null) => {
      const token = tokenOverride || sessionToken;
      if (!token) {
        setSettlementConfig(null);
        return null;
      }

      try {
        setSettlementConfigLoading(true);
        setSettlementConfigError(null);
        const response = await fetch(`${apiBaseUrl}/settlements/config`, {
          headers: {
            authorization: `Bearer ${token}`,
          },
        });
        const body = (await response.json().catch(() => ({}))) as
          | SettlementConfigStatus
          | { error?: string };

        if (!response.ok) {
          throw new Error(
            "error" in body ? body.error || "Failed to load settlement config" : "Failed to load settlement config"
          );
        }

        const config = body as SettlementConfigStatus;
        config.issues = Array.isArray(config.issues) ? config.issues : [];
        setSettlementConfig(config);
        return config;
      } catch (error) {
        setSettlementConfigError(
          error instanceof Error ? error.message : "Failed to load settlement config"
        );
        return null;
      } finally {
        setSettlementConfigLoading(false);
      }
    },
    [apiBaseUrl, sessionToken]
  );

  const selectRfq = useCallback(
    async (rfqId: string, tokenOverride?: string | null) => {
      setSelectedRfqId(rfqId);
      setAcceptError(null);
      await fetchQuotesForRfq(rfqId, tokenOverride);

      const settlementId = settlementByRfqId[rfqId];
      if (settlementId) {
        await fetchSettlementById(settlementId, tokenOverride);
      }
    },
    [fetchQuotesForRfq, fetchSettlementById, settlementByRfqId]
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

    function queueRefresh(rfqIdFromEvent?: string | null) {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(() => {
        void (async () => {
          const rows = await fetchRfqs(token);
          const preferredRfqId =
            rfqIdFromEvent ||
            selectedRfqId ||
            rows[0]?.id ||
            null;
          if (preferredRfqId) {
            await fetchQuotesForRfq(preferredRfqId, token);
          }
        })();
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

        const payload =
          parsed &&
          typeof parsed === "object" &&
          "payload" in parsed &&
          parsed.payload &&
          typeof parsed.payload === "object"
            ? (parsed.payload as Record<string, unknown>)
            : null;
        const eventRfqId =
          payload && typeof payload.rfqId === "string" ? payload.rfqId : null;
        const eventSettlementId =
          payload && typeof payload.id === "string" && eventName.startsWith("settlement.")
            ? payload.id
            : null;

        if (
          eventName.startsWith("rfq.") ||
          eventName.startsWith("quote.") ||
          eventName.startsWith("settlement.")
        ) {
          queueRefresh(eventRfqId);
        }

        if (eventSettlementId && eventRfqId) {
          setSettlementByRfqId((current) => ({
            ...current,
            [eventRfqId]: eventSettlementId,
          }));
          void fetchSettlementById(eventSettlementId, token, { silent: true });
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
  }, [
    apiBaseUrl,
    fetchQuotesForRfq,
    fetchRfqs,
    fetchSettlementById,
    selectedRfqId,
    sessionToken,
  ]);

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
      const [loadedRfqs] = await Promise.all([
        fetchRfqs(verifyData.sessionToken),
        fetchUmbraState(verifyData.sessionToken),
        refreshBalance(),
        fetchSettlementConfig(verifyData.sessionToken),
      ]);
      if (loadedRfqs.length > 0) {
        await selectRfq(loadedRfqs[0].id, verifyData.sessionToken);
      } else {
        setSelectedRfqId(null);
        setRankedQuotes([]);
      }
    } catch (error) {
      setSessionToken(null);
      setWsState("disconnected");
      setRfqs([]);
      setSelectedRfqId(null);
      setRankedQuotes([]);
      setQuoteToConfirm(null);
      setSettlementByRfqId({});
      setSettlementDetailsById({});
      setSettlementConfig(null);
      setSettlementConfigError(null);
      setAcceptError(null);
      setAuthError(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setAuthLoading(false);
    }
  }, [
    apiBaseUrl,
    fetchRfqs,
    fetchSettlementConfig,
    fetchUmbraState,
    refreshBalance,
    selectRfq,
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
      setSelectedRfqId(null);
      setRankedQuotes([]);
      setQuoteToConfirm(null);
      setSettlementByRfqId({});
      setSettlementDetailsById({});
      setSettlementError(null);
      setSettlementConfig(null);
      setSettlementConfigError(null);
      setAcceptError(null);
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
          network: selectedNetwork,
          registrationSignatures: [],
          accountState: null,
          lastError: null,
        }),
      });

      const result = await initializeUmbraAccount(walletAddress, selectedNetwork);

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
          network: selectedNetwork,
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
    selectedNetwork,
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
      const rows = await fetchRfqs();
      if (body.id && typeof body.id === "string") {
        await selectRfq(body.id);
      } else if (rows.length > 0) {
        await selectRfq(rows[0].id);
      }
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
    selectRfq,
    umbraStatus,
    validateForm,
    walletAddress,
  ]);

  const settlementEngineUnavailable = settlementConfig?.executionModel !== "browser";
  const settlementEngineNeedsConfig = settlementConfig?.ready === false;

  const executeSettlement = useCallback(
    async (settlementId: string, quote: RankedQuote) => {
      if (!sessionToken || !selectedRfq || !walletAddress) {
        throw new Error("Authenticate and connect the institution wallet first");
      }

      assertSettlementWalletReady(quote.guaranteedSize);

      setSettlementLoadingId(settlementId);
      setSettlementError(null);
      setSettlementProgressMessage("Preparing browser settlement execution...");

      const startResponse = await fetch(
        `${apiBaseUrl}/settlements/${encodeURIComponent(settlementId)}/start`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            network: selectedNetwork,
          }),
        }
      );

      const startBody = (await startResponse.json().catch(() => ({}))) as
        | SettlementRecord
        | { error?: string };

      if (!startResponse.ok) {
        throw new Error(
          "error" in startBody
            ? startBody.error || "Failed to start settlement execution"
            : "Failed to start settlement execution"
        );
      }

      const progressMessages: Partial<Record<UmbraSettlementProgressEvent, string>> = {
        "client.ready": "Umbra client ready",
        "registration.check": "Checking Umbra registration",
        "registration.submit": "Registering Umbra account",
        "deposit.submit": "Sending deposit transaction",
        "deposit.confirmed": "Deposit confirmed",
        "withdraw.submit": "Sending withdrawal transaction",
        "withdraw.confirmed": "Withdrawal confirmed",
      };

      try {
        const executionResult = await executeUmbraBrowserSettlement(
          {
            walletAddress,
            network: selectedNetwork,
            settlementId,
            rfqId: selectedRfq.id,
            quoteId: quote.id,
            marketMakerWallet: quote.marketMakerWallet,
            guaranteedSize: quote.guaranteedSize,
          },
          (event, detail) => {
            setSettlementProgressMessage(detail || progressMessages[event] || event);
          }
        );

        const completeResponse = await fetch(
          `${apiBaseUrl}/settlements/${encodeURIComponent(settlementId)}/complete`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({
              network: selectedNetwork,
              ...executionResult,
            }),
          }
        );

        const completeBody = (await completeResponse.json().catch(() => ({}))) as
          | SettlementRecord
          | { error?: string };

        if (!completeResponse.ok) {
          throw new Error(
            "error" in completeBody
              ? completeBody.error || "Failed to persist settlement result"
              : "Failed to persist settlement result"
          );
        }

        const settlement = completeBody as SettlementRecord;
        setSettlementDetailsById((current) => ({
          ...current,
          [settlement.id]: settlement,
        }));
        setSettlementProgressMessage("Settlement completed");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Settlement execution failed";

        await fetch(
          `${apiBaseUrl}/settlements/${encodeURIComponent(settlementId)}/fail`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({
              network: selectedNetwork,
              errorMessage: message,
              failure: {
                source: "browser",
                retryable: true,
              },
            }),
          }
        ).catch(() => null);

        setSettlementError(message);
        setSettlementProgressMessage(null);
        throw error;
      } finally {
        await Promise.all([
          fetchRfqs(),
          fetchQuotesForRfq(selectedRfq.id),
          fetchSettlementById(settlementId, undefined, { silent: true }),
        ]);
        setSettlementLoadingId(null);
      }
    },
    [
      apiBaseUrl,
      fetchQuotesForRfq,
      fetchRfqs,
      fetchSettlementById,
      selectedNetwork,
      selectedRfq,
      sessionToken,
      assertSettlementWalletReady,
      walletAddress,
    ]
  );

  const acceptQuote = useCallback(
    async (quote: RankedQuote) => {
      if (!sessionToken) {
        setAcceptError("Authenticate as institution first");
        return;
      }
      if (!selectedRfq) {
        setAcceptError("Select RFQ first");
        return;
      }
      if (!walletAddress) {
        setAcceptError("Connect the institution wallet first");
        return;
      }
      if (settlementEngineNeedsConfig) {
        setAcceptError(
          "Settlement execution is not ready. Refresh the engine panel and retry."
        );
        return;
      }
      try {
        assertSettlementWalletReady(quote.guaranteedSize);
      } catch (error) {
        setAcceptError(
          error instanceof Error ? error.message : "Settlement wallet is not ready"
        );
        return;
      }

      try {
        setAcceptingQuoteId(quote.id);
        setAcceptError(null);
        setSettlementError(null);
        setQuoteToConfirm(null);

        const response = await fetch(`${apiBaseUrl}/settlements/accept`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            quoteId: quote.id,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          id?: string;
          settlementId?: string;
          error?: string;
        };

        if (!response.ok) {
          throw new Error(body.error || "Failed to accept quote");
        }

        const settlementId = body.id || body.settlementId;
        if (!settlementId) {
          throw new Error("Settlement ID missing in response");
        }

        setSettlementByRfqId((current) => ({
          ...current,
          [selectedRfq.id]: settlementId,
        }));

        await Promise.all([
          fetchQuotesForRfq(selectedRfq.id),
          fetchRfqs(),
          fetchSettlementById(settlementId),
        ]);
        await executeSettlement(settlementId, quote);
      } catch (error) {
        setAcceptError(error instanceof Error ? error.message : "Failed to accept quote");
      } finally {
        setAcceptingQuoteId(null);
      }
    },
    [
      apiBaseUrl,
      fetchQuotesForRfq,
      fetchRfqs,
      fetchSettlementById,
      executeSettlement,
      selectedRfq,
      settlementEngineNeedsConfig,
      sessionToken,
      assertSettlementWalletReady,
      walletAddress,
    ]
  );

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
  const canAcceptQuotes = Boolean(selectedRfq) && !activeSettlement;
  const hasBlockingSettlement = Boolean(
    activeSettlement && activeSettlement.status !== "failed"
  );
  const confidentialSettlementReady = Boolean(
    umbraAccountState?.isInitialised && umbraAccountState?.isUserAccountX25519KeyRegistered
  );
  const settlementMintBalanceDisplay = useMemo(() => {
    if (settlementMintBalanceRaw === null) {
      return null;
    }
    return formatTokenAmountFromBaseUnits(
      settlementMintBalanceRaw,
      networkConfig.mintDecimals
    );
  }, [networkConfig.mintDecimals, settlementMintBalanceRaw]);
  const requiredSettlementAmountRaw = useMemo(() => {
    if (!settlementTargetQuote) {
      return null;
    }
    try {
      return decimalToBaseUnits(
        settlementTargetQuote.guaranteedSize,
        networkConfig.mintDecimals
      ).toString();
    } catch {
      return null;
    }
  }, [networkConfig.mintDecimals, settlementTargetQuote]);
  const requiredSettlementAmountDisplay = useMemo(() => {
    if (requiredSettlementAmountRaw === null) {
      return settlementTargetQuote?.guaranteedSize || null;
    }
    return formatTokenAmountFromBaseUnits(
      requiredSettlementAmountRaw,
      networkConfig.mintDecimals
    );
  }, [networkConfig.mintDecimals, requiredSettlementAmountRaw, settlementTargetQuote]);
  const hasSufficientSettlementMintBalance = useMemo(() => {
    if (requiredSettlementAmountRaw === null || settlementMintBalanceRaw === null) {
      return null;
    }
    try {
      return BigInt(settlementMintBalanceRaw) >= BigInt(requiredSettlementAmountRaw);
    } catch {
      return null;
    }
  }, [requiredSettlementAmountRaw, settlementMintBalanceRaw]);
  const settlementReadinessIssues = useMemo(() => {
    const issues: string[] = [];

    if (!walletAddress) {
      issues.push("Connect the institution wallet.");
      return issues;
    }

    if (!confidentialSettlementReady) {
      issues.push("Umbra confidential mode is not fully ready for this wallet.");
    }

    if (settlementMintTokenAccountCount === 0) {
      issues.push("No public token account found for the configured settlement mint.");
    }

    if (settlementMintBalanceRaw === null) {
      issues.push("Settlement mint balance has not been loaded yet.");
    } else if (hasSufficientSettlementMintBalance === false) {
      issues.push(
        `Insufficient settlement mint balance. Need ${requiredSettlementAmountDisplay || "-"} and have ${settlementMintBalanceDisplay || "0"}.`
      );
    }

    return issues;
  }, [
    confidentialSettlementReady,
    hasSufficientSettlementMintBalance,
    requiredSettlementAmountDisplay,
    settlementMintBalanceDisplay,
    settlementMintBalanceRaw,
    settlementMintTokenAccountCount,
    walletAddress,
  ]);
  const settlementWalletReady =
    walletAddress !== null &&
    confidentialSettlementReady &&
    settlementMintTokenAccountCount > 0 &&
    settlementMintBalanceRaw !== null &&
    hasSufficientSettlementMintBalance === true;

  function assertSettlementWalletReady(guaranteedSize: string) {
    if (!walletAddress) {
      throw new Error("Connect the institution wallet first");
    }
    if (!confidentialSettlementReady) {
      throw new Error(
        "Umbra confidential setup is incomplete for this wallet. Initialize Umbra again."
      );
    }
    if (settlementMintTokenAccountCount === 0) {
      throw new Error(
        `No public token account found for settlement mint ${networkConfig.mint}.`
      );
    }
    if (settlementMintBalanceRaw === null) {
      throw new Error("Settlement mint balance is unavailable. Refresh and retry.");
    }

    const requiredAmount = decimalToBaseUnits(guaranteedSize, networkConfig.mintDecimals);
    const availableAmount = BigInt(settlementMintBalanceRaw);

    if (availableAmount < requiredAmount) {
      throw new Error(
        `Insufficient settlement mint balance. Need ${formatTokenAmountFromBaseUnits(requiredAmount.toString(), networkConfig.mintDecimals)} and have ${settlementMintBalanceDisplay || "0"}.`
      );
    }
  }

  const settlementTxSignatures = useMemo(() => {
    if (!activeSettlement) {
      return [] as Array<{ label: string; signature: string }>;
    }
    const entries: Array<{ label: string; signature: string }> = [];
    const receipt = activeSettlement.receipt as Record<string, unknown>;
    const deposit =
      receipt && typeof receipt.deposit === "object" && receipt.deposit
        ? (receipt.deposit as Record<string, unknown>)
        : null;
    const withdraw =
      receipt && typeof receipt.withdraw === "object" && receipt.withdraw
        ? (receipt.withdraw as Record<string, unknown>)
        : null;

    const pushIfString = (label: string, value: unknown) => {
      if (typeof value === "string" && value.trim().length > 0) {
        entries.push({ label, signature: value });
      }
    };

    pushIfString("Settlement Signature", activeSettlement.umbraTxSignature);
    pushIfString("Deposit Queue", deposit?.queueSignature);
    pushIfString("Deposit Callback", deposit?.callbackSignature);
    pushIfString("Withdraw Queue", withdraw?.queueSignature);
    pushIfString("Withdraw Callback", withdraw?.callbackSignature);
    return entries;
  }, [activeSettlement]);

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
                <Button
                  variant="outline"
                  onClick={() => void refreshSettlementMintBalance()}
                  disabled={!connected || settlementMintBalanceLoading}
                >
                  {settlementMintBalanceLoading ? "Checking Mint..." : "Refresh Mint"}
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
                  <p className="mt-1 text-[#dbe5f3]">{selectedNetwork}</p>
                </div>
                <div className="rounded-md border border-[#223247] bg-[#0d1623] p-3">
                  <p className="text-[#7f93af]">Settlement Mint Balance</p>
                  <p className="mt-1 text-[#dbe5f3]">
                    {settlementMintBalanceLoading
                      ? "Loading..."
                      : settlementMintBalanceDisplay || "0"}
                  </p>
                </div>
                <div className="rounded-md border border-[#223247] bg-[#0d1623] p-3">
                  <p className="text-[#7f93af]">Mint Accounts</p>
                  <p className="mt-1 text-[#dbe5f3]">{settlementMintTokenAccountCount}</p>
                </div>
              </div>

              {authError ? <p className="mt-3 text-sm text-red-300">{authError}</p> : null}
              {umbraError ? <p className="mt-2 text-sm text-red-300">{umbraError}</p> : null}
              {balanceError ? <p className="mt-2 text-sm text-red-300">{balanceError}</p> : null}
              {settlementMintBalanceError ? (
                <p className="mt-2 text-sm text-red-300">{settlementMintBalanceError}</p>
              ) : null}

              {umbraAccountState ? (
                <>
                  <p className="mt-3 text-xs text-[#8ca0bc]">
                    Flags: initialised={String(umbraAccountState.isInitialised)} | anonymous=
                    {String(umbraAccountState.isActiveForAnonymousUsage)} | commitment=
                    {String(umbraAccountState.isUserCommitmentRegistered)} | x25519=
                    {String(umbraAccountState.isUserAccountX25519KeyRegistered)}
                  </p>
                  <p className="mt-2 text-xs text-[#8ca0bc]">
                    Confidential settlement needs `initialised=true` and `x25519=true`.
                    `commitment=false` is acceptable when anonymous mode is off.
                  </p>
                </>
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

          <div className="space-y-6">
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
                  const isSelected = selectedRfq?.id === rfq.id;

                  return (
                    <button
                      key={rfq.id}
                      type="button"
                      onClick={() => {
                        void selectRfq(rfq.id);
                      }}
                      className={`w-full rounded-lg border p-4 text-left transition duration-300 ${
                        isSelected
                          ? "border-[#4dd2b3] bg-[#122036] shadow-[0_8px_20px_rgba(10,20,35,0.35)]"
                          : "border-[#2b3d56] bg-[#0f1928] hover:border-[#4dd2b3] hover:shadow-[0_8px_20px_rgba(10,20,35,0.35)]"
                      }`}
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
                    </button>
                  );
                })}
              </div>
            </article>

            <article className="rounded-2xl border border-[#233147] bg-[#111b2b] p-5 transition-colors hover:border-[#2f4462]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[#93a6c1]">
                    Quote Comparison
                  </h2>
                  <p className="mt-1 text-xs text-[#8ca0bc]">
                    Institution view: compare quotes and accept one for settlement.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (selectedRfq) {
                      void fetchQuotesForRfq(selectedRfq.id);
                    }
                  }}
                  disabled={!selectedRfq || quotesLoading}
                >
                  Refresh Quotes
                </Button>
              </div>

              {selectedRfq ? (
                <p className="mt-3 text-xs text-[#8ca0bc]">
                  RFQ <code>{selectedRfq.id}</code> ({selectedRfq.pair} / {selectedRfq.side})
                </p>
              ) : (
                <p className="mt-3 text-sm text-[#8ca0bc]">Select an RFQ from the book first.</p>
              )}

              {quotesError ? <p className="mt-3 text-sm text-red-300">{quotesError}</p> : null}
              {acceptError ? <p className="mt-2 text-sm text-red-300">{acceptError}</p> : null}
              {quotesLoading ? (
                <p className="mt-3 text-sm text-[#8ca0bc] motion-safe:animate-pulse">
                  Loading ranked quotes...
                </p>
              ) : null}

              <div className="mt-4 overflow-x-auto rounded-lg border border-[#2b3d56] bg-[#0f1928]">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="border-b border-[#2b3d56] bg-[#111f31] text-xs uppercase tracking-[0.08em] text-[#8ca0bc]">
                    <tr>
                      <th className="px-3 py-2">Rank</th>
                      <th className="px-3 py-2">Market Maker</th>
                      <th className="px-3 py-2">All-In Price</th>
                      <th className="px-3 py-2">Guaranteed Size</th>
                      <th className="px-3 py-2">Valid Until</th>
                      <th className="px-3 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rankedQuotes.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-4 text-center text-[#8ca0bc]">
                          {selectedRfq
                            ? "No active quotes yet for this RFQ."
                            : "Select an RFQ to load quotes."}
                        </td>
                      </tr>
                    ) : (
                      rankedQuotes.map((quote) => (
                        <tr
                          key={quote.id}
                          className={`border-b border-[#1b2a40] last:border-b-0 ${
                            quote.rank === 1 ? "bg-[#132436]/70" : ""
                          }`}
                        >
                          <td className="px-3 py-3 font-semibold text-[#dbe5f3]">#{quote.rank}</td>
                          <td className="px-3 py-3 text-[#a9bdd8]">
                            {shortAddress(quote.marketMakerWallet)}
                          </td>
                          <td className="px-3 py-3 text-[#dbe5f3]">{quote.allInPrice}</td>
                          <td className="px-3 py-3 text-[#dbe5f3]">{quote.guaranteedSize}</td>
                          <td className="px-3 py-3 text-[#a9bdd8]">
                            {formatDateTime(quote.validUntil)}
                          </td>
                          <td className="px-3 py-3">
                            <Button
                              size="sm"
                              onClick={() => setQuoteToConfirm(quote)}
                              disabled={
                                !canAcceptQuotes ||
                                settlementEngineNeedsConfig ||
                                acceptingQuoteId === quote.id ||
                                quoteToConfirm !== null ||
                                hasBlockingSettlement
                              }
                            >
                              {acceptingQuoteId === quote.id ? "Accepting..." : "Accept Quote"}
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="rounded-2xl border border-[#233147] bg-[#111b2b] p-5 transition-colors hover:border-[#2f4462]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[#93a6c1]">
                  Settlement Progress
                </h2>
                {activeSettlement ? (
                  <span className="rounded-full border border-[#35506e] bg-[#122238] px-3 py-1 text-xs text-[#a8b8cc]">
                    {getSettlementProgressLabel(activeSettlement.status)}
                  </span>
                ) : null}
              </div>

              <div
                className={`mt-3 rounded-lg border px-3 py-3 text-xs ${
                  settlementEngineNeedsConfig
                    ? "border-[#5a2f35] bg-[#2b1114] text-[#f1a8b2]"
                    : settlementEngineUnavailable
                    ? "border-[#63572f] bg-[#2a2310] text-[#f3dc8b]"
                    : "border-[#2f5960] bg-[#10252b] text-[#74d9cc]"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p>
                    Execution:{" "}
                    <span className="font-semibold uppercase">
                      {settlementConfigLoading
                        ? "loading..."
                        : settlementConfig?.executionModel || "unknown"}
                    </span>{" "}
                    | Network:{" "}
                    <span className="font-semibold">
                      {selectedNetwork}
                    </span>
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void fetchSettlementConfig()}
                    disabled={!sessionToken || settlementConfigLoading}
                  >
                    Refresh Engine
                  </Button>
                </div>
                {settlementConfigError ? (
                  <p className="mt-2 text-red-300">{settlementConfigError}</p>
                ) : null}
                {settlementEngineUnavailable ? (
                  <p className="mt-2">
                    Settlement execution is unavailable. The browser must execute Umbra via the connected wallet.
                  </p>
                ) : null}
                {settlementConfig?.executionModel === "browser" && settlementConfig.ready ? (
                  <p className="mt-2">
                    Browser execution ready. Accepting a quote will execute real Umbra settlement on{" "}
                    {selectedNetwork}.
                  </p>
                ) : null}
                {settlementConfig?.issues && settlementConfig.issues.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    {settlementConfig.issues.map((issue) => (
                      <p key={issue}>- {issue}</p>
                    ))}
                  </div>
                ) : null}
                <p className="mt-2">
                  Mint: <code>{networkConfig.mint}</code> ({networkConfig.mintDecimals} decimals)
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-md border border-[#2b3d56] bg-[#0f1928] px-3 py-2">
                    <p className="text-[#8ca0bc]">Wallet Mint Balance</p>
                    <p className="mt-1 font-semibold text-[#dbe5f3]">
                      {settlementMintBalanceLoading
                        ? "Loading..."
                        : settlementMintBalanceDisplay || "0"}
                    </p>
                  </div>
                  <div className="rounded-md border border-[#2b3d56] bg-[#0f1928] px-3 py-2">
                    <p className="text-[#8ca0bc]">Required Amount</p>
                    <p className="mt-1 font-semibold text-[#dbe5f3]">
                      {requiredSettlementAmountDisplay || "-"}
                    </p>
                  </div>
                  <div className="rounded-md border border-[#2b3d56] bg-[#0f1928] px-3 py-2">
                    <p className="text-[#8ca0bc]">Wallet Ready</p>
                    <p
                      className={`mt-1 font-semibold ${
                        settlementWalletReady ? "text-[#8fe8d8]" : "text-[#f3dc8b]"
                      }`}
                    >
                      {settlementWalletReady ? "Yes" : "No"}
                    </p>
                  </div>
                </div>
                {settlementReadinessIssues.length > 0 ? (
                  <div className="mt-3 space-y-1">
                    {settlementReadinessIssues.map((issue) => (
                      <p key={issue}>- {issue}</p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3">Settlement wallet checks passed for the current quote size.</p>
                )}
              </div>

              {!activeSettlement ? (
                <p className="mt-3 text-sm text-[#8ca0bc]">
                  Accept a quote to start settlement orchestration and tracking.
                </p>
              ) : (
                <>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    {[
                      {
                        label: "Pending",
                        active:
                          activeSettlement.status === "accepted" ||
                          activeSettlement.status === "settling" ||
                          activeSettlement.status === "settled",
                      },
                      {
                        label: "In Progress",
                        active:
                          activeSettlement.status === "settling" ||
                          activeSettlement.status === "settled",
                      },
                      {
                        label: "Complete",
                        active: activeSettlement.status === "settled",
                      },
                    ].map((step) => (
                      <div
                        key={step.label}
                        className={`rounded-lg border px-3 py-2 text-center text-xs ${
                          step.active
                            ? "border-[#4dd2b3] bg-[#0f2a2b] text-[#8fe8d8]"
                            : "border-[#2b3d56] bg-[#0f1928] text-[#8ca0bc]"
                        }`}
                      >
                        {step.label}
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 space-y-2 text-xs text-[#a8b8cc]">
                    <p>
                      Settlement ID: <code>{activeSettlement.id}</code>
                    </p>
                    <p>
                      Status: <span className="font-semibold">{activeSettlement.status}</span>
                    </p>
                    <p>
                      Started: {activeSettlement.startedAt ? formatDateTime(activeSettlement.startedAt) : "-"}
                    </p>
                    <p>
                      Completed:{" "}
                      {activeSettlement.completedAt ? formatDateTime(activeSettlement.completedAt) : "-"}
                    </p>
                    {activeSettlement.errorMessage ? (
                      <p className="text-red-300">Error: {activeSettlement.errorMessage}</p>
                    ) : null}
                  </div>

                  {settlementError ? (
                    <p className="mt-3 text-sm text-red-300">{settlementError}</p>
                  ) : null}
                  {settlementProgressMessage ? (
                    <p className="mt-2 text-sm text-[#8fe8d8]">{settlementProgressMessage}</p>
                  ) : null}
                  {settlementLoadingId === activeSettlement.id ? (
                    <p className="mt-2 text-sm text-[#8ca0bc] motion-safe:animate-pulse">
                      Updating settlement status...
                    </p>
                  ) : null}

                  <div className="mt-4 space-y-2">
                    <h3 className="text-xs uppercase tracking-[0.12em] text-[#8ca0bc]">
                      Explorer Links
                    </h3>
                    {settlementTxSignatures.length === 0 ? (
                      <p className="text-xs text-[#8ca0bc]">No transaction signatures yet.</p>
                    ) : (
                      settlementTxSignatures.map((entry) => (
                        <a
                          key={`${entry.label}-${entry.signature}`}
                          href={toExplorerTxUrl(entry.signature, explorerCluster)}
                          target="_blank"
                          rel="noreferrer"
                          className="block text-xs text-[#7fd7c9] underline underline-offset-2 hover:text-[#56d5b9]"
                        >
                          {entry.label}: {shortAddress(entry.signature)}
                        </a>
                      ))
                    )}
                  </div>

                  <div className="mt-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {activeSettlement.status === "failed" ? (
                        <Button
                          onClick={() =>
                            void executeSettlement(activeSettlement.id, {
                              id: activeSettlement.quote.id,
                              rfqId: activeSettlement.rfq.id,
                              marketMakerWallet: activeSettlement.quote.marketMakerWallet,
                              allInPrice: activeSettlement.quote.allInPrice,
                              guaranteedSize: activeSettlement.quote.guaranteedSize,
                              validUntil: activeSettlement.quote.validUntil,
                              settlementConstraints: {},
                              encryptedPayload: {},
                              signature: "",
                              status: activeSettlement.quote.status,
                              createdAt: activeSettlement.createdAt,
                              updatedAt: activeSettlement.updatedAt,
                              rank: 0,
                            })
                          }
                          disabled={settlementLoadingId === activeSettlement.id}
                        >
                          Retry Settlement
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        onClick={() => setShowReceiptProof((current) => !current)}
                      >
                        {showReceiptProof ? "Hide Receipt / Proof" : "Show Receipt / Proof"}
                      </Button>
                    </div>
                  </div>

                  {showReceiptProof ? (
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <div className="rounded-lg border border-[#2b3d56] bg-[#0f1928] p-3">
                        <p className="mb-2 text-xs uppercase tracking-[0.1em] text-[#8ca0bc]">
                          Receipt
                        </p>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs text-[#c6d6eb]">
                          {JSON.stringify(activeSettlement.receipt, null, 2)}
                        </pre>
                      </div>
                      <div className="rounded-lg border border-[#2b3d56] bg-[#0f1928] p-3">
                        <p className="mb-2 text-xs uppercase tracking-[0.1em] text-[#8ca0bc]">
                          Proof
                        </p>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs text-[#c6d6eb]">
                          {JSON.stringify(activeSettlement.proof, null, 2)}
                        </pre>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </article>
          </div>
        </section>
      </div>
      {quoteToConfirm ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#060b12]/80 px-4">
          <div className="w-full max-w-md rounded-xl border border-[#2b3d56] bg-[#0f1827] p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-white">Confirm Quote Acceptance</h3>
            <p className="mt-2 text-sm text-[#a9bdd8]">
              This will start settlement orchestration for quote{" "}
              <code>{quoteToConfirm.id}</code>.
            </p>
            <div className="mt-3 rounded-md border border-[#2b3d56] bg-[#0d1624] p-3 text-xs text-[#c6d6eb]">
              <p>MM: {shortAddress(quoteToConfirm.marketMakerWallet)}</p>
              <p>Price: {quoteToConfirm.allInPrice}</p>
              <p>Guaranteed Size: {quoteToConfirm.guaranteedSize}</p>
              <p>Valid Until: {formatDateTime(quoteToConfirm.validUntil)}</p>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setQuoteToConfirm(null)}>
                Cancel
              </Button>
              <Button onClick={() => void acceptQuote(quoteToConfirm)}>Confirm Accept</Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
