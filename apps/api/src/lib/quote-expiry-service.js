const QUOTE_EXPIRY_ZSET_KEY = "umbriq:quotes:expiry";

class QuoteExpiryService {
  constructor({
    quoteStore,
    redis = null,
    onQuoteExpired = null,
    pollMs = 1000,
    logger = console,
  }) {
    this.quoteStore = quoteStore;
    this.redis = redis;
    this.onQuoteExpired = onQuoteExpired;
    this.pollMs = pollMs;
    this.logger = logger;
    this.timer = null;
    this.processing = false;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.sweepOnce().catch((error) => {
        this.logger.error({ error }, "quote expiry sweep failed");
      });
    }, this.pollMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async scheduleQuote(quote) {
    if (!this.redis) {
      return;
    }

    const expiryMs = Date.parse(quote.validUntil);
    if (!Number.isFinite(expiryMs)) {
      return;
    }

    await this.redis.zadd(QUOTE_EXPIRY_ZSET_KEY, expiryMs, quote.id);
  }

  async sweepOnce() {
    if (this.processing) {
      return [];
    }
    this.processing = true;
    try {
      if (this.redis) {
        return await this.sweepWithRedis();
      }
      return await this.sweepWithoutRedis();
    } finally {
      this.processing = false;
    }
  }

  async sweepWithRedis() {
    const now = Date.now();
    const dueIds = await this.redis.zrangebyscore(QUOTE_EXPIRY_ZSET_KEY, 0, now);
    if (!Array.isArray(dueIds) || dueIds.length === 0) {
      return [];
    }

    await this.redis.zrem(QUOTE_EXPIRY_ZSET_KEY, ...dueIds);
    const expiredQuotes = await this.quoteStore.expireByIds(dueIds);
    await this.emitExpiredQuotes(expiredQuotes);
    return expiredQuotes;
  }

  async sweepWithoutRedis() {
    const expiredQuotes = await this.quoteStore.expireDue(new Date().toISOString());
    await this.emitExpiredQuotes(expiredQuotes);
    return expiredQuotes;
  }

  async emitExpiredQuotes(expiredQuotes) {
    if (!this.onQuoteExpired || !Array.isArray(expiredQuotes) || expiredQuotes.length === 0) {
      return;
    }

    for (const quote of expiredQuotes) {
      await this.onQuoteExpired(quote);
    }
  }
}

module.exports = {
  QuoteExpiryService,
};
