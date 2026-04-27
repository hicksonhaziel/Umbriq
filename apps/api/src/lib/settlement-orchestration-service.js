class SettlementOrchestrationService {
  constructor({
    settlementStore,
    quoteStore,
    rfqStore,
    rfqRealtimeHub = null,
  }) {
    this.settlementStore = settlementStore;
    this.quoteStore = quoteStore;
    this.rfqStore = rfqStore;
    this.rfqRealtimeHub = rfqRealtimeHub;
  }

  async start(settlementId) {
    const current = await this.settlementStore.getById(settlementId);
    if (!current) {
      return null;
    }

    const settling = await this.settlementStore.update(settlementId, {
      status: "settling",
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorMessage: null,
      receipt: {},
      proof: {},
      umbraTxSignature: null,
    });

    if (!settling) {
      return null;
    }

    await this.rfqStore.updateStatus(settling.rfqId, "settling");
    this.broadcast("settlement.settling", settling);
    return settling;
  }

  async complete(settlementId, payload) {
    const current = await this.settlementStore.getById(settlementId);
    if (!current) {
      return null;
    }

    const settled = await this.settlementStore.update(settlementId, {
      status: "settled",
      umbraTxSignature: payload.umbraTxSignature,
      receipt: payload.receipt || {},
      proof: payload.proof || {},
      completedAt: new Date().toISOString(),
      errorMessage: null,
    });

    if (!settled) {
      return null;
    }

    await this.rfqStore.updateStatus(settled.rfqId, "settled");
    this.broadcast("settlement.settled", settled);
    return settled;
  }

  async fail(settlementId, payload) {
    const current = await this.settlementStore.getById(settlementId);
    if (!current) {
      return null;
    }

    const failureMeta =
      payload.failure && typeof payload.failure === "object" ? payload.failure : {};

    const failed = await this.settlementStore.update(settlementId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: payload.errorMessage || "Unknown settlement failure",
      receipt: {
        failure: failureMeta,
        failedAt: new Date().toISOString(),
      },
      proof: {
        type: "settlement-failure-v1",
        details: failureMeta,
      },
    });

    if (!failed) {
      return null;
    }

    // Keep the selected quote accepted so the institution can retry settlement
    // without re-running quote discovery.
    await this.rfqStore.updateStatus(failed.rfqId, "accepted");
    this.broadcast("settlement.failed", failed);
    return failed;
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
