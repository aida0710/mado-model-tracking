import { DomainError } from '../domain/errors.js';

export interface RateLimit {
  attempts: number;
  windowMs: number;
}

// Limits per API process. They are memory-only: a restart resets them, which is acceptable
// because they slow online guessing rather than enforce an account lockout.
// A shared office NAT can send many legitimate logins from one address within a minute.
export const LOCAL_LOGIN_IP_LIMIT: RateLimit = { attempts: 30, windowMs: 60_000 };
// Guessing one account from many addresses is bounded by failures on that username.
export const LOCAL_LOGIN_USERNAME_FAILURE_LIMIT: RateLimit = {
  attempts: 10,
  windowMs: 15 * 60_000,
};
// Each OIDC start stores a state row; this bounds rows one address can create.
export const OIDC_START_IP_LIMIT: RateLimit = { attempts: 20, windowMs: 60_000 };
// A stolen session must not be able to brute-force the current password.
export const CURRENT_PASSWORD_LIMIT: RateLimit = { attempts: 10, windowMs: 15 * 60_000 };
// One Argon2id check uses about 19 MiB; four keep login bursts from exhausting API memory.
export const MAX_CONCURRENT_PASSWORD_CHECKS = 4;
// Clients retry a busy password check after this many seconds.
export const PASSWORD_CHECK_BUSY_RETRY_SECONDS = 1;
// Bounds the bucket map when many addresses or usernames are tried.
const MAX_BUCKETS = 2_000;

interface Bucket {
  count: number;
  resetAt: number;
}

// Routes copy retryAfterSeconds into the Retry-After header before the shared error handler responds.
export class RateLimitedError extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, '試行回数の上限に達しました。しばらく待ってから再試行してください', 'rate_limited');
  }
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class AuthRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private activePasswordChecks = 0;

  constructor(
    private readonly maxConcurrentPasswordChecks = MAX_CONCURRENT_PASSWORD_CHECKS,
    private readonly maxBuckets = MAX_BUCKETS,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (maxBuckets < 1) throw new Error('maxBuckets must be at least 1');
  }

  // Counts one attempt, throwing RateLimitedError once the window's allowance is used up.
  consumeOrThrow(key: string, limit: RateLimit): void {
    const decision = this.consume(key, limit);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
  }

  // Throws RateLimitedError when the key is exhausted, without counting an attempt.
  checkOrThrow(key: string, limit: RateLimit): void {
    const decision = this.check(key, limit);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
  }

  // Counts one attempt and refuses it once the window's allowance is used up.
  consume(key: string, limit: RateLimit): RateLimitDecision {
    const exhausted = this.check(key, limit);
    if (!exhausted.allowed) return exhausted;
    this.record(key, limit);
    return { allowed: true };
  }

  // Reports whether the key is exhausted without counting an attempt.
  check(key: string, limit: RateLimit): RateLimitDecision {
    const bucket = this.liveBucket(key);
    if (!bucket || bucket.count < limit.attempts) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000)),
    };
  }

  // Counts an attempt, for limits that only count failures.
  record(key: string, limit: RateLimit): void {
    const bucket = this.liveBucket(key);
    if (bucket) {
      // Map insertion order doubles as recency so eviction removes the least recently used key.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
      bucket.count += 1;
      return;
    }
    this.ensureCapacity();
    this.buckets.set(key, { count: 1, resetAt: this.now() + limit.windowMs });
  }

  // Runs a password hash or verification, refusing with 429 when too many already run.
  async passwordCheck<T>(task: () => Promise<T>): Promise<T> {
    if (this.activePasswordChecks >= this.maxConcurrentPasswordChecks)
      throw new RateLimitedError(PASSWORD_CHECK_BUSY_RETRY_SECONDS);
    this.activePasswordChecks += 1;
    try {
      return await task();
    } finally {
      this.activePasswordChecks -= 1;
    }
  }

  private liveBucket(key: string): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= this.now()) {
      this.buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  private ensureCapacity(): void {
    if (this.buckets.size < this.maxBuckets) return;
    const now = this.now();
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
    while (this.buckets.size >= this.maxBuckets) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
