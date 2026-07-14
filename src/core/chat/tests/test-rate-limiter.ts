import { KeyedSlidingWindowRateLimiter } from '../rate-limiter'

interface TestResult {
  name: string
  pass: boolean
  detail?: string
}

const results: TestResult[] = []
let failed = 0

function expect(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    results.push({ name, pass: true })
  } else {
    results.push({ name, pass: false, detail })
    failed += 1
  }
}

// 1. Basic allow / deny within the window.
const limiter = new KeyedSlidingWindowRateLimiter({ windowMs: 1000, maxEvents: 2 })
const c1 = limiter.check('chat:a', 1000)
expect('first call is allowed', c1.allowed === true && c1.count === 0)
limiter.record('chat:a', 1000)
const c2 = limiter.check('chat:a', 1100)
expect('second call is allowed', c2.allowed === true && c2.count === 1)
limiter.record('chat:a', 1100)
const c3 = limiter.check('chat:a', 1200)
expect('third call is denied and retryAfterMs is positive', c3.allowed === false && c3.count === 2 && c3.retryAfterMs > 0, JSON.stringify(c3))

// 2. Per-key isolation: chat:a is full but chat:b is independent.
const cOther = limiter.check('chat:b', 1200)
expect('per-key isolation: chat:b is unaffected by chat:a', cOther.allowed === true, JSON.stringify(cOther))

// 3. Window slides: after the windowMs elapses, the limit resets.
const later = limiter.check('chat:a', 1000 + 1500)
expect('after the window slides past, the limit is reset', later.allowed === true, JSON.stringify(later))

// 4. retryAfterMs reflects the oldest in-window timestamp.
const lim2 = new KeyedSlidingWindowRateLimiter({ windowMs: 5000, maxEvents: 1 })
lim2.record('chat:x', 1000)
const denied = lim2.check('chat:x', 2000)
expect('retryAfterMs equals the time remaining until the window expires', denied.retryAfterMs === 4000, JSON.stringify(denied))

// 5. reset() clears all keys.
lim2.reset()
const afterReset = lim2.check('chat:x', 2100)
expect('reset() drops the events so the next check is allowed', afterReset.allowed === true, JSON.stringify(afterReset))

// 6. Multiple recordings inside the window are counted until the limit is reached.
const lim3 = new KeyedSlidingWindowRateLimiter({ windowMs: 10_000, maxEvents: 5 })
for (let i = 0; i < 5; i += 1) lim3.record('chat:y', 1000 + i * 100)
const full = lim3.check('chat:y', 1500)
expect('after reaching maxEvents, check returns allowed=false', full.allowed === false && full.count === 5, JSON.stringify(full))

// 7. check() without recording still reports counts based on prior record() calls.
const lim4 = new KeyedSlidingWindowRateLimiter({ windowMs: 1000, maxEvents: 3 })
lim4.record('chat:z', 1000)
lim4.record('chat:z', 1100)
const onlyCheck = lim4.check('chat:z', 1200)
expect('check() does not mutate the counter', onlyCheck.allowed === true && onlyCheck.count === 2, JSON.stringify(onlyCheck))

console.log('[RateLimiter] results', results)
if (failed > 0) {
  console.error('[RateLimiter] failed: ' + failed)
  process.exit(1)
}
