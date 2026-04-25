"use client";

import { useCallback, useMemo, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { Button } from "@/components/ui/button";
import { encryptRfqPayload } from "@/lib/rfq/encryption";
import { buildQuoteMessage } from "@/lib/quote/message";

type RfqSide = "buy" | "sell";
type WsConnectionState = "disconnected" | "connecting" | "connected" | "error";
type QuoteStatus = "all" | "active" | "expired" | "accepted" | "rejected" | "withdrawn";

type IncomingRfq = {
  id: string;
  institutionWallet: string;
  pair: string;
  side: RfqSide;
  notionalSize: string;
  minFillSize: string | null;
  quoteExpiresAt: string;
  status: string;
  canSubmitQuote: boolean;
  myQuote:
    | {
        id: string;
        allInPrice: string;
        guaranteedSize: string;
        validUntil: string;
        status: string;
        createdAt: string;
        updatedAt: string;
      }
    | null;
};

type IncomingRfqResponse = {
  count: number;
  rfqs: IncomingRfq[];
};

type MyQuote = {
  id: string;
  rfqId: string;
  marketMakerWallet: string;
  allInPrice: string;
  guaranteedSize: string;
  validUntil: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  rfq: {
    id: string;
    institutionWallet: string;
    pair: string;
    side: RfqSide;
    notionalSize: string;
    minFillSize: string | null;
    quoteExpiresAt: string;
    status: string;
  } | null;
};

type MyQuotesResponse = {
  count: number;
  quotes: MyQuote[];
};

type QuoteFormState = {
  allInPrice: string;
  guaranteedSize: string;
  validForMinutes: string;
};

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
        className="h-10 rounded-md bg-[#6ec1ff] px-4 text-sm font-semibold text-[#08253c] opacity-80"
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

function shortAddress(value: string): string {
  if (value.length <= 10) {
    return value;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

function parsePositiveInput(value: string): string | null {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return normalized;
}

export function MarketMakerDashboard() {
  const { connection } = useConnection();
  const { publicKey, connected, connecting, disconnect, signMessage } = useWallet();
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const [incomingRfqs, setIncomingRfqs] = useState<IncomingRfq[]>([]);
  const [incomingLoading, setIncomingLoading] = useState(false);
  const [incomingError, setIncomingError] = useState<string | null>(null);
  const [incomingPairFilter, setIncomingPairFilter] = useState("all");
  const [incomingSideFilter, setIncomingSideFilter] = useState<"all" | RfqSide>("all");

  const [myQuotes, setMyQuotes] = useState<MyQuote[]>([]);
  const [myQuotesLoading, setMyQuotesLoading] = useState(false);
  const [myQuotesError, setMyQuotesError] = useState<string | null>(null);
  const [myQuoteStatusFilter, setMyQuoteStatusFilter] = useState<QuoteStatus>("all");

  const [selectedRfqId, setSelectedRfqId] = useState<string | null>(null);
  const [quoteForms, setQuoteForms] = useState<Record<string, QuoteFormState>>({});
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);

  const [wsState, setWsState] = useState<WsConnectionState>("disconnected");
  const [wsEvents, setWsEvents] = useState<string[]>([]);

  const walletAddress = useMemo(() => publicKey?.toBase58() || null, [publicKey]);

  const selectedRfq = useMemo(() => {
    if (incomingRfqs.length === 0) {
      return null;
    }
    if (!selectedRfqId) {
      return incomingRfqs[0];
    }
    return incomingRfqs.find((rfq) => rfq.id === selectedRfqId) || incomingRfqs[0];
  }, [incomingRfqs, selectedRfqId]);

  const selectedForm = useMemo(() => {
    if (!selectedRfq) {
      return null;
    }
    return (
      quoteForms[selectedRfq.id] || {
        allInPrice: "100.00",
        guaranteedSize: selectedRfq.minFillSize || selectedRfq.notionalSize,
        validForMinutes: "2",
      }
    );
  }, [quoteForms, selectedRfq]);

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

  const fetchIncomingRfqs = useCallback(
    async (options?: { token?: string | null; pair?: string; side?: "all" | RfqSide }) => {
      const token = options?.token || sessionToken;
      if (!token) {
        setIncomingRfqs([]);
        return;
      }

      const pair = options?.pair ?? incomingPairFilter;
      const side = options?.side ?? incomingSideFilter;

      try {
        setIncomingLoading(true);
        setIncomingError(null);
        const params = new URLSearchParams();
        if (pair !== "all") {
          params.set("pair", pair);
        }
        if (side !== "all") {
          params.set("side", side);
        }
        const suffix = params.toString().length > 0 ? `?${params.toString()}` : "";

        const response = await fetch(`${apiBaseUrl}/rfqs/incoming${suffix}`, {
          headers: {
            authorization: `Bearer ${token}`,
          },
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "Failed to load incoming RFQs");
        }
        const body = (await response.json()) as IncomingRfqResponse;
        const rows = Array.isArray(body.rfqs) ? body.rfqs : [];
        setIncomingRfqs(rows);
      } catch (error) {
        setIncomingError(
          error instanceof Error ? error.message : "Failed to load incoming RFQs"
        );
      } finally {
        setIncomingLoading(false);
      }
    },
    [apiBaseUrl, incomingPairFilter, incomingSideFilter, sessionToken]
  );

  const fetchMyQuotes = useCallback(
    async (options?: { token?: string | null; status?: QuoteStatus }) => {
      const token = options?.token || sessionToken;
      if (!token) {
        setMyQuotes([]);
        return;
      }

      const status = options?.status ?? myQuoteStatusFilter;

      try {
        setMyQuotesLoading(true);
        setMyQuotesError(null);
        const params = new URLSearchParams();
        if (status !== "all") {
          params.set("status", status);
        }
        const suffix = params.toString().length > 0 ? `?${params.toString()}` : "";

        const response = await fetch(`${apiBaseUrl}/quotes/mine${suffix}`, {
          headers: {
            authorization: `Bearer ${token}`,
          },
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "Failed to load your quotes");
        }
        const body = (await response.json()) as MyQuotesResponse;
        setMyQuotes(Array.isArray(body.quotes) ? body.quotes : []);
      } catch (error) {
        setMyQuotesError(error instanceof Error ? error.message : "Failed to load your quotes");
      } finally {
        setMyQuotesLoading(false);
      }
    },
    [apiBaseUrl, myQuoteStatusFilter, sessionToken]
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
        void Promise.all([
          fetchIncomingRfqs({ token }),
          fetchMyQuotes({ token }),
        ]);
      }, 250);
    }

    function connectWs() {
      if (!active) {
        return;
      }

      setWsState("connecting");
      ws = new WebSocket(`${wsBaseUrl}/ws/rfqs?token=${encodeURIComponent(token)}`);

      ws.onopen = () => {
        setWsState("connected");
        setWsEvents((current) => ["[connected] subscribed to /ws/rfqs", ...current].slice(0, 10));
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
            : "unknown";

        setWsEvents((current) => [`[event] ${eventName}`, ...current].slice(0, 10));

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
  }, [apiBaseUrl, fetchIncomingRfqs, fetchMyQuotes, sessionToken]);

  const authenticateMarketMaker = useCallback(async () => {
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
      setSubmitSuccess(null);

      const nonceRes = await fetch(`${apiBaseUrl}/auth/nonce`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      if (!nonceRes.ok) {
        throw new Error("Failed to request nonce");
      }
      const nonceData = (await nonceRes.json()) as { message: string };

      const signatureBytes = await signMessage(new TextEncoder().encode(nonceData.message));
      const verifyRes = await fetch(`${apiBaseUrl}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          walletAddress,
          signature: bs58.encode(signatureBytes),
          role: "market_maker",
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
        refreshBalance(),
        fetchIncomingRfqs({ token: verifyData.sessionToken }),
        fetchMyQuotes({ token: verifyData.sessionToken }),
      ]);
    } catch (error) {
      setSessionToken(null);
      setWsState("disconnected");
      setWsEvents([]);
      setIncomingRfqs([]);
      setMyQuotes([]);
      setAuthError(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setAuthLoading(false);
    }
  }, [apiBaseUrl, fetchIncomingRfqs, fetchMyQuotes, refreshBalance, signMessage, walletAddress]);

  const logoutSession = useCallback(async () => {
    if (!sessionToken) {
      return;
    }
    try {
      await fetch(`${apiBaseUrl}/auth/logout`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      });
    } finally {
      setSessionToken(null);
      setWsState("disconnected");
      setWsEvents([]);
      setIncomingRfqs([]);
      setMyQuotes([]);
      setSubmitError(null);
      setSubmitSuccess(null);
    }
  }, [apiBaseUrl, sessionToken]);

  const updateSelectedForm = useCallback(
    (field: keyof QuoteFormState, value: string) => {
      if (!selectedRfq) {
        return;
      }
      setQuoteForms((current) => ({
        ...current,
        [selectedRfq.id]: {
          allInPrice: current[selectedRfq.id]?.allInPrice ?? selectedForm?.allInPrice ?? "100.00",
          guaranteedSize:
            current[selectedRfq.id]?.guaranteedSize ??
            selectedForm?.guaranteedSize ??
            selectedRfq.notionalSize,
          validForMinutes:
            current[selectedRfq.id]?.validForMinutes ??
            selectedForm?.validForMinutes ??
            "2",
          [field]: value,
        },
      }));
    },
    [selectedForm, selectedRfq]
  );

  const submitQuoteForSelectedRfq = useCallback(async () => {
    if (!sessionToken || !walletAddress) {
      setSubmitError("Authenticate as market maker first");
      return;
    }
    if (!selectedRfq || !selectedForm) {
      setSubmitError("Select an RFQ first");
      return;
    }
    if (!selectedRfq.canSubmitQuote) {
      setSubmitError("Quote already submitted for this RFQ");
      return;
    }
    if (!signMessage) {
      setSubmitError("Wallet does not support message signing");
      return;
    }

    const allInPrice = parsePositiveInput(selectedForm.allInPrice);
    const guaranteedSize = parsePositiveInput(selectedForm.guaranteedSize);
    const validForMinutes = parsePositiveInput(selectedForm.validForMinutes);
    if (!allInPrice || !guaranteedSize || !validForMinutes) {
      setSubmitError("Price, size, and valid minutes must be positive numbers");
      return;
    }

    const now = Date.now();
    const rfqExpiryMs = Date.parse(selectedRfq.quoteExpiresAt);
    if (!Number.isFinite(rfqExpiryMs) || rfqExpiryMs <= now + 1000) {
      setSubmitError("RFQ quote window is already expired");
      return;
    }

    const requestedMs = now + Number(validForMinutes) * 60 * 1000;
    const validUntilMs = Math.min(requestedMs, rfqExpiryMs - 1000);
    if (validUntilMs <= now) {
      setSubmitError("validUntil is too close to RFQ expiry; refresh RFQs and retry");
      return;
    }
    const validUntil = new Date(validUntilMs).toISOString();

    try {
      setSubmitLoading(true);
      setSubmitError(null);
      setSubmitSuccess(null);

      const message = buildQuoteMessage({
        rfqId: selectedRfq.id,
        marketMakerWallet: walletAddress,
        allInPrice,
        guaranteedSize,
        validUntil,
      });
      const signed = await signMessage(new TextEncoder().encode(message));

      const encryptedPayload = await encryptRfqPayload({
        rfqId: selectedRfq.id,
        allInPrice,
        guaranteedSize,
        validUntil,
      });

      const response = await fetch(`${apiBaseUrl}/quotes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          rfqId: selectedRfq.id,
          allInPrice,
          guaranteedSize,
          validUntil,
          signature: bs58.encode(signed),
          settlementConstraints: {
            ttlSeconds: 30,
          },
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
        throw new Error((body.error || "Failed to submit quote") + detail);
      }

      setSubmitSuccess(body.id || selectedRfq.id);
      await Promise.all([
        fetchIncomingRfqs({ token: sessionToken }),
        fetchMyQuotes({ token: sessionToken }),
      ]);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to submit quote");
    } finally {
      setSubmitLoading(false);
    }
  }, [
    apiBaseUrl,
    fetchIncomingRfqs,
    fetchMyQuotes,
    selectedForm,
    selectedRfq,
    sessionToken,
    signMessage,
    walletAddress,
  ]);

  return (
    <main className="min-h-screen bg-[#0b1018] px-6 py-10 text-[#d9e2ef]">
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <section className="rounded-2xl border border-[#2a3952] bg-gradient-to-r from-[#0f1b2c] to-[#10243b] p-6 shadow-[0_10px_30px_rgba(4,10,20,0.35)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-[#9db1cc]">
                Umbriq / Market Maker
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-white">Quote Submission Desk</h1>
              <p className="mt-2 text-sm text-[#95a8c4]">
                Monitor incoming RFQs in real time and submit signed competitive quotes.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-[#334763] bg-[#111d2f] px-3 py-1 text-[#a7b9d1]">
                WS: {wsState}
              </span>
              <span className="rounded-full border border-[#334763] bg-[#111d2f] px-3 py-1 text-[#a7b9d1]">
                Session: {sessionToken ? "active" : "none"}
              </span>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
          <div className="space-y-6">
            <article className="rounded-2xl border border-[#233247] bg-[#111a29] p-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[#9cb0cb]">
                Session Setup
              </h2>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <WalletMultiButtonNoSsr className="!h-10 !rounded-md !bg-[#6ec1ff] !px-4 !text-sm !font-semibold !text-[#08253c] hover:!bg-[#5ab1f0]" />
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
                <Button onClick={() => void authenticateMarketMaker()} disabled={!connected || authLoading}>
                  {authLoading ? "Authenticating..." : "Authenticate MM"}
                </Button>
                <Button variant="outline" onClick={() => void logoutSession()} disabled={!sessionToken}>
                  Logout Session
                </Button>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-[#9baec7]">
                <div className="rounded-md border border-[#24344a] bg-[#0d1623] p-3">
                  <p className="text-[#8094b0]">Wallet</p>
                  <p className="mt-1 text-[#d9e2ef]">
                    {walletAddress ? shortAddress(walletAddress) : "Not connected"}
                  </p>
                </div>
                <div className="rounded-md border border-[#24344a] bg-[#0d1623] p-3">
                  <p className="text-[#8094b0]">Balance</p>
                  <p className="mt-1 text-[#d9e2ef]">
                    {balanceSol === null ? "-" : `${balanceSol.toFixed(4)} SOL`}
                  </p>
                </div>
              </div>

              {authError ? <p className="mt-3 text-sm text-red-300">{authError}</p> : null}
              {balanceError ? <p className="mt-2 text-sm text-red-300">{balanceError}</p> : null}
            </article>

            <article className="rounded-2xl border border-[#233247] bg-[#111a29] p-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[#9cb0cb]">
                Quote Form
              </h2>

              {!selectedRfq ? (
                <p className="mt-3 text-sm text-[#8da1bc]">
                  No RFQ selected. Authenticate and load incoming RFQs.
                </p>
              ) : (
                <>
                  <p className="mt-3 text-sm text-[#c6d4e7]">
                    RFQ <code>{selectedRfq.id}</code> | {selectedRfq.pair} / {selectedRfq.side}
                  </p>
                  <p className="mt-1 text-xs text-[#8da1bc]">
                    Expires: {formatDateTime(selectedRfq.quoteExpiresAt)}
                  </p>

                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-xs text-[#8da1bc]" htmlFor="mm-price">
                        All-In Price
                      </label>
                      <input
                        id="mm-price"
                        value={selectedForm?.allInPrice || ""}
                        onChange={(event) => updateSelectedForm("allInPrice", event.target.value)}
                        className="h-10 w-full rounded-md border border-[#2b3e59] bg-[#0d1725] px-3 text-sm text-[#d9e2ef] outline-none transition focus:border-[#6ec1ff]"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-[#8da1bc]" htmlFor="mm-size">
                        Guaranteed Size
                      </label>
                      <input
                        id="mm-size"
                        value={selectedForm?.guaranteedSize || ""}
                        onChange={(event) =>
                          updateSelectedForm("guaranteedSize", event.target.value)
                        }
                        className="h-10 w-full rounded-md border border-[#2b3e59] bg-[#0d1725] px-3 text-sm text-[#d9e2ef] outline-none transition focus:border-[#6ec1ff]"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-[#8da1bc]" htmlFor="mm-valid-mins">
                        Valid For (mins)
                      </label>
                      <input
                        id="mm-valid-mins"
                        value={selectedForm?.validForMinutes || ""}
                        onChange={(event) =>
                          updateSelectedForm("validForMinutes", event.target.value)
                        }
                        className="h-10 w-full rounded-md border border-[#2b3e59] bg-[#0d1725] px-3 text-sm text-[#d9e2ef] outline-none transition focus:border-[#6ec1ff]"
                      />
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button
                      onClick={() => void submitQuoteForSelectedRfq()}
                      disabled={!selectedRfq.canSubmitQuote || submitLoading || !sessionToken}
                    >
                      {submitLoading ? "Submitting..." : "Submit Quote"}
                    </Button>
                    {!selectedRfq.canSubmitQuote ? (
                      <span className="text-xs text-[#e8c48f]">Quote already submitted</span>
                    ) : null}
                  </div>
                </>
              )}

              {submitError ? <p className="mt-3 text-sm text-red-300">{submitError}</p> : null}
              {submitSuccess ? (
                <p className="mt-3 text-sm text-[#89ddb0]">
                  Quote submitted successfully: <code>{submitSuccess}</code>
                </p>
              ) : null}
            </article>
          </div>

          <div className="space-y-6">
            <article className="rounded-2xl border border-[#233247] bg-[#111a29] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[#9cb0cb]">
                  Incoming RFQs
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={incomingPairFilter}
                    onChange={(event) => {
                      const next = event.target.value;
                      setIncomingPairFilter(next);
                      void fetchIncomingRfqs({ pair: next, token: sessionToken });
                    }}
                    className="h-9 rounded-md border border-[#2b3e59] bg-[#0d1725] px-2 text-xs text-[#d9e2ef] outline-none"
                  >
                    <option value="all">All pairs</option>
                    <option value="SOL/USDC">SOL/USDC</option>
                    <option value="BTC/USDC">BTC/USDC</option>
                    <option value="ETH/USDC">ETH/USDC</option>
                  </select>
                  <select
                    value={incomingSideFilter}
                    onChange={(event) => {
                      const next = event.target.value as "all" | RfqSide;
                      setIncomingSideFilter(next);
                      void fetchIncomingRfqs({ side: next, token: sessionToken });
                    }}
                    className="h-9 rounded-md border border-[#2b3e59] bg-[#0d1725] px-2 text-xs text-[#d9e2ef] outline-none"
                  >
                    <option value="all">All sides</option>
                    <option value="buy">Buy</option>
                    <option value="sell">Sell</option>
                  </select>
                  <Button
                    variant="outline"
                    onClick={() => void fetchIncomingRfqs({ token: sessionToken })}
                    disabled={!sessionToken || incomingLoading}
                  >
                    Refresh
                  </Button>
                </div>
              </div>

              {incomingError ? <p className="mt-3 text-sm text-red-300">{incomingError}</p> : null}
              {incomingLoading ? (
                <p className="mt-3 text-sm text-[#8da1bc] motion-safe:animate-pulse">
                  Loading incoming RFQs...
                </p>
              ) : null}

              <div className="mt-4 space-y-3">
                {!incomingLoading && incomingRfqs.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[#324862] bg-[#0d1624] px-4 py-6 text-center text-sm text-[#8da1bc]">
                    No incoming RFQs for this wallet.
                  </div>
                ) : null}

                {incomingRfqs.map((rfq) => (
                  <button
                    key={rfq.id}
                    type="button"
                    onClick={() => setSelectedRfqId(rfq.id)}
                    className={`w-full rounded-lg border p-4 text-left transition ${
                      selectedRfq?.id === rfq.id
                        ? "border-[#6ec1ff] bg-[#13253b]"
                        : "border-[#2b3e59] bg-[#0f1827] hover:border-[#5aa9e4]"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="text-xs text-[#a4bad5]">{rfq.id}</code>
                      <span className="rounded-full border border-[#375477] bg-[#102338] px-2 py-0.5 text-xs text-[#9bc8ef]">
                        {rfq.pair} / {rfq.side}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-[#c7d6e8]">
                      <p>Notional: {rfq.notionalSize}</p>
                      <p className="text-right">Min Fill: {rfq.minFillSize || "-"}</p>
                    </div>
                    <p className="mt-2 text-xs text-[#8da1bc]">
                      Institution: {shortAddress(rfq.institutionWallet)}
                    </p>
                    <p className="mt-1 text-xs text-[#8da1bc]">
                      Expires: {formatDateTime(rfq.quoteExpiresAt)}
                    </p>
                    {rfq.myQuote ? (
                      <p className="mt-2 text-xs text-[#e8c48f]">
                        Your quote: {rfq.myQuote.status} ({rfq.myQuote.allInPrice})
                      </p>
                    ) : null}
                  </button>
                ))}
              </div>
            </article>

            <article className="rounded-2xl border border-[#233247] bg-[#111a29] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[#9cb0cb]">
                  My Quotes
                </h2>
                <div className="flex items-center gap-2">
                  <select
                    value={myQuoteStatusFilter}
                    onChange={(event) => {
                      const next = event.target.value as QuoteStatus;
                      setMyQuoteStatusFilter(next);
                      void fetchMyQuotes({ status: next, token: sessionToken });
                    }}
                    className="h-9 rounded-md border border-[#2b3e59] bg-[#0d1725] px-2 text-xs text-[#d9e2ef] outline-none"
                  >
                    <option value="all">All statuses</option>
                    <option value="active">Active</option>
                    <option value="expired">Expired</option>
                    <option value="accepted">Accepted</option>
                    <option value="rejected">Rejected</option>
                    <option value="withdrawn">Withdrawn</option>
                  </select>
                  <Button
                    variant="outline"
                    onClick={() => void fetchMyQuotes({ token: sessionToken })}
                    disabled={!sessionToken || myQuotesLoading}
                  >
                    Refresh
                  </Button>
                </div>
              </div>

              {myQuotesError ? <p className="mt-3 text-sm text-red-300">{myQuotesError}</p> : null}
              {myQuotesLoading ? (
                <p className="mt-3 text-sm text-[#8da1bc] motion-safe:animate-pulse">
                  Loading your quotes...
                </p>
              ) : null}

              <div className="mt-4 space-y-3">
                {!myQuotesLoading && myQuotes.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[#324862] bg-[#0d1624] px-4 py-6 text-center text-sm text-[#8da1bc]">
                    No quotes for selected filter.
                  </div>
                ) : null}

                {myQuotes.map((quote) => (
                  <div key={quote.id} className="rounded-lg border border-[#2b3e59] bg-[#0f1827] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="text-xs text-[#a4bad5]">{quote.id}</code>
                      <span className="rounded-full border border-[#355275] bg-[#102338] px-2 py-0.5 text-xs text-[#9bc8ef]">
                        {quote.status}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-[#c7d6e8]">
                      <p>Price: {quote.allInPrice}</p>
                      <p className="text-right">Size: {quote.guaranteedSize}</p>
                    </div>
                    <p className="mt-2 text-xs text-[#8da1bc]">
                      RFQ: {quote.rfq?.pair || "-"} / {quote.rfq?.side || "-"}
                    </p>
                    <p className="mt-1 text-xs text-[#8da1bc]">
                      Valid Until: {formatDateTime(quote.validUntil)}
                    </p>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded-2xl border border-[#233247] bg-[#111a29] p-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[#9cb0cb]">
                Realtime Events
              </h2>
              <div className="mt-3 space-y-1 text-xs text-[#9cb0cb]">
                {wsEvents.length === 0 ? <p>No websocket events yet.</p> : null}
                {wsEvents.map((entry, index) => (
                  <p key={`${entry}-${index}`}>{entry}</p>
                ))}
              </div>
            </article>
          </div>
        </section>
      </div>
    </main>
  );
}
