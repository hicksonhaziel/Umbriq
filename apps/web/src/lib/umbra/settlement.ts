import {
  getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
  getPublicBalanceToEncryptedBalanceDirectDepositorFunction,
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
} from "@umbra-privacy/sdk";
import { getUmbraBrowserClient } from "./client";
import {
  decimalToBaseUnits,
  getUmbraNetworkConfig,
  type UmbraNetwork,
} from "./network-config";

export type UmbraSettlementExecutionInput = {
  walletAddress: string;
  network: UmbraNetwork;
  settlementId: string;
  rfqId: string;
  quoteId: string;
  marketMakerWallet: string;
  guaranteedSize: string;
};

export type UmbraSettlementExecutionResult = {
  umbraTxSignature: string;
  receipt: Record<string, unknown>;
  proof: Record<string, unknown>;
};

export type UmbraSettlementProgressEvent =
  | "client.ready"
  | "registration.check"
  | "registration.submit"
  | "deposit.submit"
  | "deposit.confirmed"
  | "withdraw.submit"
  | "withdraw.confirmed";

function extractErrorMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string" && current.trim()) {
      messages.push(current.trim());
      continue;
    }

    if (current instanceof Error) {
      if (typeof current.message === "string" && current.message.trim()) {
        messages.push(current.message.trim());
      }
      const candidate = current as { cause?: unknown };
      if (candidate.cause) {
        queue.push(candidate.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const candidate = current as { message?: unknown; cause?: unknown };
      if (typeof candidate.message === "string" && candidate.message.trim()) {
        messages.push(candidate.message.trim());
      }
      if (candidate.cause) {
        queue.push(candidate.cause);
      }
    }
  }

  return Array.from(new Set(messages)).join(" | ") || "Unknown error";
}

function extractSimulationLogs(error: unknown): string[] {
  const logs: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const candidate = current as {
      cause?: unknown;
      context?: { logs?: unknown };
      logs?: unknown;
      simulationLogs?: unknown;
      transactionMessage?: unknown;
    };

    if (Array.isArray(candidate.logs)) {
      for (const entry of candidate.logs) {
        if (typeof entry === "string" && entry.trim()) {
          logs.push(entry.trim());
        }
      }
    }

    if (candidate.context && Array.isArray(candidate.context.logs)) {
      for (const entry of candidate.context.logs) {
        if (typeof entry === "string" && entry.trim()) {
          logs.push(entry.trim());
        }
      }
    }

    if (Array.isArray(candidate.simulationLogs)) {
      for (const entry of candidate.simulationLogs) {
        if (typeof entry === "string" && entry.trim()) {
          logs.push(entry.trim());
        }
      }
    }

    if (candidate.cause) {
      queue.push(candidate.cause);
    }
    if (candidate.transactionMessage) {
      queue.push(candidate.transactionMessage);
    }
  }

  return Array.from(new Set(logs));
}

function extractDiagnosticDetails(error: unknown): string[] {
  const details: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const candidate = current as {
      name?: unknown;
      code?: unknown;
      stage?: unknown;
      instructionName?: unknown;
      signature?: unknown;
      rpcErrorCode?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };

    if (typeof candidate.name === "string" && candidate.name.trim()) {
      details.push(`name=${candidate.name.trim()}`);
    }
    if (typeof candidate.code === "string" && candidate.code.trim()) {
      details.push(`code=${candidate.code.trim()}`);
    }
    if (typeof candidate.stage === "string" && candidate.stage.trim()) {
      details.push(`stage=${candidate.stage.trim()}`);
    }
    if (typeof candidate.instructionName === "string" && candidate.instructionName.trim()) {
      details.push(`instruction=${candidate.instructionName.trim()}`);
    }
    if (typeof candidate.signature === "string" && candidate.signature.trim()) {
      details.push(`signature=${candidate.signature.trim()}`);
    }
    if (typeof candidate.rpcErrorCode === "number") {
      details.push(`rpcErrorCode=${String(candidate.rpcErrorCode)}`);
    }
    if (typeof candidate.statusCode === "number") {
      details.push(`statusCode=${String(candidate.statusCode)}`);
    }

    if (candidate.cause) {
      queue.push(candidate.cause);
    }
  }

  return Array.from(new Set(details));
}

function classifyKnownUmbraIssue(
  stage: "deposit" | "withdraw",
  message: string,
  logs: string[]
): string | null {
  const haystack = `${message}\n${logs.join("\n")}`;

  if (
    stage === "deposit" &&
    haystack.includes("DepositFromPublicBalanceIntoNewSharedBalanceV11") &&
    haystack.includes("fee_schedule") &&
    haystack.includes("AccountNotInitialized")
  ) {
    return [
      "Umbra devnet protocol configuration is incomplete for this deposit path.",
      "The on-chain Umbra program rejected the deposit because the protocol account `fee_schedule` is not initialized.",
      "This is not a wallet balance issue inside Umbriq.",
    ].join(" ");
  }

  return null;
}

function buildUmbraExecutionError(stage: "deposit" | "withdraw", error: unknown): Error {
  const message = extractErrorMessage(error);
  const logs = extractSimulationLogs(error);
  const details = extractDiagnosticDetails(error);

  const sections = [`Umbra ${stage} failed: ${message}`];
  const knownIssue = classifyKnownUmbraIssue(stage, message, logs);

  if (knownIssue) {
    sections.push(knownIssue);
  }

  if (details.length > 0) {
    sections.push(details.join(" | "));
  }

  if (logs.length > 0) {
    const interestingLogs = logs.slice(-12);
    sections.push(interestingLogs.join("\n"));
  }

  return new Error(sections.join("\n"));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function executeUmbraBrowserSettlement(
  input: UmbraSettlementExecutionInput,
  onProgress?: (event: UmbraSettlementProgressEvent, detail?: string) => void
): Promise<UmbraSettlementExecutionResult> {
  const { walletAddress, network, settlementId, rfqId, quoteId, marketMakerWallet, guaranteedSize } =
    input;
  const { client, signer } = await getUmbraBrowserClient(walletAddress, network);
  const networkConfig = getUmbraNetworkConfig(network);
  const amountBaseUnits = decimalToBaseUnits(guaranteedSize, networkConfig.mintDecimals);

  onProgress?.("client.ready", "Umbra client ready");
  onProgress?.("registration.check", "Checking Umbra registration");

  const queryAccount = getUserAccountQuerierFunction({ client });
  const accountState = await queryAccount(signer.address);

  if (accountState.state !== "exists" || accountState.data.isInitialised !== true) {
    onProgress?.("registration.submit", "Registering Umbra account");
    const register = getUserRegistrationFunction({ client });
    await register({
      confidential: true,
      anonymous: false,
      callbacks: {
        userAccountInitialisation: {
          pre: async () => onProgress?.("registration.submit", "Creating Umbra account"),
        },
        registerX25519PublicKey: {
          pre: async () => onProgress?.("registration.submit", "Registering encryption key"),
        },
      },
    });
  }

  const deposit = getPublicBalanceToEncryptedBalanceDirectDepositorFunction(
    { client },
    {
      arcium: {
        awaitComputationFinalization: {},
      },
    }
  );
  const depositMintAddress = networkConfig.mint as Parameters<typeof deposit>[1];
  const depositAmount = amountBaseUnits as Parameters<typeof deposit>[2];

  onProgress?.("deposit.submit", "Shielding funds into encrypted balance");
  let depositResult;
  try {
    depositResult = await deposit(signer.address, depositMintAddress, depositAmount, {
      accountInfoCommitment: "confirmed",
      epochInfoCommitment: "confirmed",
    });
  } catch (error) {
    throw buildUmbraExecutionError("deposit", error);
  }
  onProgress?.(
    "deposit.confirmed",
    `Deposit confirmed: ${depositResult.callbackSignature || depositResult.queueSignature}`
  );

  const withdraw = getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction(
    { client },
    {
      arcium: {
        awaitComputationFinalization: {},
      },
    }
  );
  const withdrawDestinationAddress = marketMakerWallet as Parameters<typeof withdraw>[0];
  const withdrawMintAddress = networkConfig.mint as Parameters<typeof withdraw>[1];
  const withdrawAmount = amountBaseUnits as Parameters<typeof withdraw>[2];

  onProgress?.("withdraw.submit", "Withdrawing to market maker wallet");
  let withdrawResult;
  try {
    withdrawResult = await withdraw(withdrawDestinationAddress, withdrawMintAddress, withdrawAmount, {
      accountInfoCommitment: "confirmed",
    });
  } catch (error) {
    throw buildUmbraExecutionError("withdraw", error);
  }
  onProgress?.(
    "withdraw.confirmed",
    `Withdrawal confirmed: ${withdrawResult.callbackSignature || withdrawResult.queueSignature}`
  );

  const receipt = {
    provider: "umbra-sdk",
    executionModel: "browser",
    network,
    mint: networkConfig.mint,
    mintDecimals: networkConfig.mintDecimals,
    amountBaseUnits: amountBaseUnits.toString(),
    signerAddress: String(signer.address),
    destinationAddress: marketMakerWallet,
    registrationCheckedAt: new Date().toISOString(),
    deposit: {
      queueSignature: depositResult.queueSignature,
      callbackStatus: depositResult.callbackStatus || null,
      callbackSignature: depositResult.callbackSignature || null,
      callbackElapsedMs:
        typeof depositResult.callbackElapsedMs === "number"
          ? depositResult.callbackElapsedMs
          : null,
      rentClaimSignature: depositResult.rentClaimSignature || null,
      rentClaimError: depositResult.rentClaimError || null,
    },
    withdraw: {
      queueSignature: withdrawResult.queueSignature,
      callbackStatus: withdrawResult.callbackStatus || null,
      callbackSignature: withdrawResult.callbackSignature || null,
      callbackElapsedMs:
        typeof withdrawResult.callbackElapsedMs === "number"
          ? withdrawResult.callbackElapsedMs
          : null,
      rentClaimSignature: withdrawResult.rentClaimSignature || null,
      rentClaimError: withdrawResult.rentClaimError || null,
    },
  };

  const proofPayload = {
    settlementId,
    rfqId,
    quoteId,
    network,
    mint: networkConfig.mint,
    amountBaseUnits: amountBaseUnits.toString(),
    signerAddress: String(signer.address),
    destinationAddress: marketMakerWallet,
    depositQueueSignature: depositResult.queueSignature,
    depositCallbackSignature: depositResult.callbackSignature || null,
    withdrawQueueSignature: withdrawResult.queueSignature,
    withdrawCallbackSignature: withdrawResult.callbackSignature || null,
  };

  const proof = {
    type: "umbra-settlement-proof-v1",
    mode: "sdk-browser",
    hashAlgorithm: "sha256",
    digest: await sha256Hex(JSON.stringify(proofPayload)),
    payload: proofPayload,
  };

  return {
    umbraTxSignature: withdrawResult.callbackSignature || withdrawResult.queueSignature,
    receipt,
    proof,
  };
}
