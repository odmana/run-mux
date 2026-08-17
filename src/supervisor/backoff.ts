/**
 * Restart backoff maths. Pure and timer-free so it can be unit-tested without
 * spawning anything.
 */

export interface BackoffConfig {
  /** Delay before the first restart. */
  baseMs: number;
  /** Ceiling the doubling never exceeds. */
  maxMs: number;
  /** Uptime that counts as "it was actually working", which clears the counter. */
  healthyMs: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 500,
  maxMs: 30_000,
  healthyMs: 60_000,
};

/** Delay before the nth restart, 1-based: base * 2^(n-1), capped at maxMs. */
export function backoffDelay(attempt: number, config: BackoffConfig = DEFAULT_BACKOFF): number {
  if (attempt <= 0) return 0;
  // 2 ** large is Infinity, which Math.min still clamps to the cap correctly.
  return Math.min(config.maxMs, config.baseMs * 2 ** (attempt - 1));
}

/**
 * The attempt number an exit produces. A process that stayed up for healthyMs
 * was not crash-looping, so its next failure starts over at the base delay.
 */
export function nextAttempt(
  previousAttempt: number,
  uptimeMs: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
): number {
  return uptimeMs >= config.healthyMs ? 1 : previousAttempt + 1;
}

/** Per-command counter over the pure functions above. */
export class BackoffTracker {
  private current = 0;

  constructor(readonly config: BackoffConfig = DEFAULT_BACKOFF) {}

  /** Restarts counted since the last healthy run. */
  get attempt(): number {
    return this.current;
  }

  /** Records an exit after `uptimeMs` and returns how long to wait. */
  recordExit(uptimeMs: number): number {
    this.current = nextAttempt(this.current, uptimeMs, this.config);
    return backoffDelay(this.current, this.config);
  }

  reset(): void {
    this.current = 0;
  }
}
