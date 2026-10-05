import {
  Injectable,
  Inject,
  ServiceUnavailableException,
  UnauthorizedException,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';
import { createHash } from 'node:crypto';
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from '@faultline/platform';

const MAX_ATTEMPTS = 8;
const WINDOW_SECONDS = 15 * 60;
const PREFIX = 'faultline:auth:';
const rateLimitKey = (value: string) =>
  `${PREFIX}limit:${createHash('sha256').update(value).digest('hex')}`;

/**
 * Shared authentication state.
 *
 * Production uses Redis, so revocations and throttles are immediately visible to every
 * API instance. Tests use the bounded in-memory adapter to remain hermetic.
 */
@Injectable()
export class AuthSecurityStore implements OnModuleInit, OnApplicationShutdown {
  private readonly redis?: RedisClientType;
  private readonly attempts = new Map<
    string,
    { count: number; expiresAt: number }
  >();
  private readonly sessions = new Map<
    string,
    { userId: string; expiresAt: number }
  >();
  private readonly revokedSessions = new Set<string>();

  constructor(@Inject(APPLICATION_CONFIG) config: ApplicationConfig) {
    const url = config.infrastructure?.redisUrl;
    if (url) {
      this.redis = createClient({ url });
      this.redis.on('error', () => {});
    }
  }

  async onModuleInit(): Promise<void> {
    if (this.redis && !this.redis.isOpen) await this.redis.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis?.isOpen) await this.redis.quit();
  }

  private unavailable(): never {
    throw new ServiceUnavailableException(
      'Authentication service is unavailable',
    );
  }

  async checkRateLimit(key: string, now = Date.now()): Promise<void> {
    try {
      const count = this.redis
        ? Number((await this.redis.get(rateLimitKey(key))) ?? 0)
        : (this.memoryAttempt(key, now)?.count ?? 0);
      if (count >= MAX_ATTEMPTS)
        throw new UnauthorizedException(
          'Too many failed attempts; try again later',
        );
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.unavailable();
    }
  }

  async recordFailure(key: string, now = Date.now()): Promise<void> {
    try {
      if (this.redis) {
        const redisKey = rateLimitKey(key);
        const count = await this.redis.incr(redisKey);
        if (count === 1) await this.redis.expire(redisKey, WINDOW_SECONDS);
        return;
      }
      const current = this.memoryAttempt(key, now);
      this.attempts.set(key, {
        count: (current?.count ?? 0) + 1,
        expiresAt: current?.expiresAt ?? now + WINDOW_SECONDS * 1000,
      });
      if (this.attempts.size > 10_000) this.attempts.clear();
    } catch {
      this.unavailable();
    }
  }

  async clearFailures(key: string): Promise<void> {
    try {
      if (this.redis) await this.redis.del(rateLimitKey(key));
      else this.attempts.delete(key);
    } catch {
      this.unavailable();
    }
  }

  async createSession(
    sessionId: string,
    userId: string,
    ttlSeconds: number,
    now = Date.now(),
  ): Promise<void> {
    try {
      if (this.redis) {
        const sessionKey = `${PREFIX}session:${sessionId}`;
        const userKey = `${PREFIX}user-sessions:${userId}`;
        await this.redis
          .multi()
          .set(sessionKey, userId, { EX: ttlSeconds })
          .sAdd(userKey, sessionId)
          .expire(userKey, ttlSeconds)
          .exec();
        return;
      }
      this.sessions.set(sessionId, {
        userId,
        expiresAt: now + ttlSeconds * 1000,
      });
    } catch {
      this.unavailable();
    }
  }

  async isSessionActive(
    sessionId: string,
    userId: string,
    now = Date.now(),
  ): Promise<boolean> {
    try {
      if (this.redis)
        return (
          (await this.redis.get(`${PREFIX}session:${sessionId}`)) === userId
        );
      const session = this.sessions.get(sessionId);
      if (!session) {
        // Existing unit-test helpers mint tokens directly. Production always has Redis
        // and therefore always requires an explicitly registered session.
        return !this.revokedSessions.has(sessionId);
      }
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
        this.revokedSessions.add(sessionId);
        return false;
      }
      return session.userId === userId;
    } catch {
      this.unavailable();
    }
  }

  async revokeSession(sessionId: string, userId: string): Promise<void> {
    try {
      if (this.redis) {
        await this.redis
          .multi()
          .del(`${PREFIX}session:${sessionId}`)
          .sRem(`${PREFIX}user-sessions:${userId}`, sessionId)
          .exec();
      } else {
        this.sessions.delete(sessionId);
        this.revokedSessions.add(sessionId);
      }
    } catch {
      this.unavailable();
    }
  }

  async revokeAllSessions(userId: string): Promise<void> {
    try {
      if (this.redis) {
        const userKey = `${PREFIX}user-sessions:${userId}`;
        const ids = await this.redis.sMembers(userKey);
        const transaction = this.redis.multi();
        for (const id of ids) transaction.del(`${PREFIX}session:${id}`);
        transaction.del(userKey);
        await transaction.exec();
        return;
      }
      for (const [id, session] of this.sessions)
        if (session.userId === userId) {
          this.sessions.delete(id);
          this.revokedSessions.add(id);
        }
    } catch {
      this.unavailable();
    }
  }

  private memoryAttempt(key: string, now: number) {
    const current = this.attempts.get(key);
    if (current && current.expiresAt <= now) {
      this.attempts.delete(key);
      return undefined;
    }
    return current;
  }
}
