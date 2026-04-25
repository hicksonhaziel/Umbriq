const { randomUUID } = require("node:crypto");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class SettlementOrchestrationService {
  constructor({
    settlementStore,
    quoteStore,
    rfqStore,
    rfqRealtimeHub = null,
    logger = console,
    startDelayMs = 100,
    confirmDelayMs = 200,
  }) {
    this.settlementStore = settlementStore;
    this.quoteStore = quoteStore;
    this.rfqStore = rfqStore;
    this.rfqRealtimeHub = rfqRealtimeHub;
    this.logger = logger;
    this.startDelayMs = startDelayMs;
    this.confirmDelayMs = confirmDelayMs;
    this.inFlight = new Map();
  }

  run(settlementId) {
    if (this.inFlight.has(settlementId)) {
      return this.inFlight.get(settlementId);
    }

    const task = this.execute(settlementId).finally(() => {
      this.inFlight.delete(settlementId);
    });
    this.inFlight.set(settlementId, task);
    return task;
  }

  async execute(settlementId) {
    const initial = await this.settlementStore.getById(settlementId);
    if (!initial) {
      return null;
    }

    try {
      await sleep(this.startDelayMs);
      const settling = await this.settlementStore.update(settlementId, {
        status: "settling",
        startedAt: new Date().toISOString(),
      });
      await this.rfqStore.updateStatus(settling.rfqId, "settling");
      this.broadcast("settlement.settling", settling);

      const quote = await this.quoteStore.getById(settling.quoteId);
      if (!quote) {
        throw new Error("Quote not found during settlement");
      }

      await sleep(this.confirmDelayMs);
      if (quote.settlementConstraints?.simulateFailure === true) {
        throw new Error("Simulated settlement failure from settlementConstraints");
      }

      const settled = await this.settlementStore.update(settlementId, {
        status: "settled",
        umbraTxSignature: `sim_${randomUUID().replaceAll("-", "")}`,
        receipt: {
          network: "devnet",
          confirmedAt: new Date().toISOString(),
          finality: "confirmed",
        },
        proof: {
          type: "mock-proof",
          generatedAt: new Date().toISOString(),
        },
        completedAt: new Date().toISOString(),
        errorMessage: null,
      });
      await this.rfqStore.updateStatus(settled.rfqId, "settled");
      this.broadcast("settlement.settled", settled);
      return settled;
    } catch (error) {
      const failed = await this.settlementStore.update(settlementId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage:
          error && typeof error.message === "string"
            ? error.message
            : "Unknown settlement failure",
      });

      if (failed) {
        await this.rfqStore.updateStatus(failed.rfqId, "failed");
        await this.quoteStore.updateStatus(failed.quoteId, "rejected");
        this.broadcast("settlement.failed", failed);
      }

      this.logger.error({ error, settlementId }, "Settlement orchestration failed");
      return failed;
    }
  }

  broadcast(event, settlement) {
    if (!this.rfqRealtimeHub || typeof this.rfqRealtimeHub.broadcast !== "function") {
      return;
    }

    this.rfqRealtimeHub.broadcast(event, {
      id: settlement.id,
      rfqId: settlement.rfqId,
      quoteId: settlement.quoteId,
      status: settlement.status,
      umbraTxSignature: settlement.umbraTxSignature,
      errorMessage: settlement.errorMessage,
      startedAt: settlement.startedAt,
      completedAt: settlement.completedAt,
      updatedAt: settlement.updatedAt,
    });
  }
}

module.exports = {
  SettlementOrchestrationService,
};
