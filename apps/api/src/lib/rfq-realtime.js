class RfqRealtimeHub {
  constructor() {
    this.clients = new Set();
  }

  addClient(socket, session) {
    if (!socket || typeof socket.send !== "function") {
      return null;
    }

    const client = {
      socket,
      walletAddress: session.walletAddress,
      role: session.role,
    };
    this.clients.add(client);

    if (typeof socket.on === "function") {
      socket.on("close", () => {
        this.clients.delete(client);
      });
    }

    return client;
  }

  broadcast(event, payload) {
    const message = JSON.stringify({
      event,
      payload,
      timestamp: new Date().toISOString(),
    });

    for (const client of this.clients) {
      if (!client.socket || typeof client.socket.send !== "function") {
        this.clients.delete(client);
        continue;
      }

      if (client.socket.readyState === 1) {
        client.socket.send(message);
      } else if (
        typeof client.socket.readyState === "number" &&
        client.socket.readyState > 1
      ) {
        this.clients.delete(client);
      }
    }
  }

  broadcastRfqCreated(rfq) {
    const publicPayload = {
      id: rfq.id,
      institutionWallet: rfq.institutionWallet,
      pair: rfq.pair,
      side: rfq.side,
      notionalSize: rfq.notionalSize,
      minFillSize: rfq.minFillSize,
      quoteExpiresAt: rfq.quoteExpiresAt,
      status: rfq.status,
      counterparties: rfq.counterparties,
      createdAt: rfq.createdAt,
      updatedAt: rfq.updatedAt,
    };
    this.broadcast("rfq.created", publicPayload);
  }

  broadcastQuoteSubmitted(quote) {
    this.broadcast("quote.submitted", {
      id: quote.id,
      rfqId: quote.rfqId,
      marketMakerWallet: quote.marketMakerWallet,
      allInPrice: quote.allInPrice,
      guaranteedSize: quote.guaranteedSize,
      validUntil: quote.validUntil,
      status: quote.status,
      createdAt: quote.createdAt,
      updatedAt: quote.updatedAt,
    });
  }

  broadcastQuoteExpired(quote) {
    this.broadcast("quote.expired", {
      id: quote.id,
      rfqId: quote.rfqId,
      marketMakerWallet: quote.marketMakerWallet,
      status: quote.status,
      updatedAt: quote.updatedAt,
    });
  }
}

module.exports = {
  RfqRealtimeHub,
};
