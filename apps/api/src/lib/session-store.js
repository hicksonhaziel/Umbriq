const { randomUUID } = require("node:crypto");

const SESSION_PREFIX = "umbriq:session:";

class InMemorySessionStore {
  constructor() {
    this.sessions = new Map();
  }

  async create(payload, ttlSeconds) {
    const token = randomUUID();
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.sessions.set(token, {
      payload,
      expiresAt,
    });
    return { token, expiresAt };
  }

  async get(token) {
    const record = this.sessions.get(token);
    if (!record) {
      return null;
    }

    if (record.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }

    return {
      ...record.payload,
      expiresAt: record.expiresAt,
    };
  }

  async destroy(token) {
    this.sessions.delete(token);
  }
}

class RedisSessionStore {
  constructor(redis) {
    this.redis = redis;
  }

  async create(payload, ttlSeconds) {
    const token = randomUUID();
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const key = `${SESSION_PREFIX}${token}`;
    const value = JSON.stringify({
      payload,
      expiresAt,
    });

    await this.redis.set(key, value, "EX", ttlSeconds);
    return { token, expiresAt };
  }

  async get(token) {
    const key = `${SESSION_PREFIX}${token}`;
    const value = await this.redis.get(key);
    if (!value) {
      return null;
    }

    const parsed = JSON.parse(value);
    if (parsed.expiresAt <= Date.now()) {
      await this.redis.del(key);
      return null;
    }

    return {
      ...parsed.payload,
      expiresAt: parsed.expiresAt,
    };
  }

  async destroy(token) {
    await this.redis.del(`${SESSION_PREFIX}${token}`);
  }
}

module.exports = {
  InMemorySessionStore,
  RedisSessionStore,
};
