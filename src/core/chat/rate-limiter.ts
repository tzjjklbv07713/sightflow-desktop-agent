export interface RateLimitRule {
  windowMs: number
  maxEvents: number
}

export interface RateLimitCheck {
  allowed: boolean
  count: number
  retryAfterMs: number
}

export class KeyedSlidingWindowRateLimiter {
  private readonly events = new Map<string, number[]>()

  constructor(private readonly rule: RateLimitRule) {}

  check(key: string, now = Date.now()): RateLimitCheck {
    const timestamps = this.prune(key, now)
    const allowed = timestamps.length < this.rule.maxEvents
    const retryAfterMs = allowed ? 0 : Math.max(0, this.rule.windowMs - (now - timestamps[0]))

    return {
      allowed,
      count: timestamps.length,
      retryAfterMs
    }
  }

  record(key: string, now = Date.now()): void {
    const timestamps = this.prune(key, now)
    timestamps.push(now)
    this.events.set(key, timestamps)
  }

  reset(): void {
    this.events.clear()
  }

  private prune(key: string, now: number): number[] {
    const cutoff = now - this.rule.windowMs
    const timestamps = (this.events.get(key) || []).filter((timestamp) => timestamp >= cutoff)

    if (timestamps.length > 0) {
      this.events.set(key, timestamps)
    } else {
      this.events.delete(key)
    }

    return timestamps
  }
}
