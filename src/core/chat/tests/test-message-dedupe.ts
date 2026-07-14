import { buildMessageDedupeKey, MessageDedupePool } from '../message-dedupe'
import type { ObservedChatMessage } from '../message-types'
import type { AppType } from '../../rpa/types'

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

function makeObserved(overrides: Partial<ObservedChatMessage> = {}): ObservedChatMessage {
  return {
    chat: { id: 'wechat:chat:abc', type: 'direct', name: 'Customer', whitelisted: false },
    direction: 'contact',
    kind: 'text',
    content: 'hello there',
    confidence: 0.9,
    source: 'uiautomation',
    timestamp: 1700000000000,
    ...overrides
  } as ObservedChatMessage
}

// 1. Same message id observed twice must reuse the dedupe key.
const stableObs = makeObserved({ id: 'msg-stable-1' })
const k1 = buildMessageDedupeKey({ appType: 'wechat' as AppType, observedMessage: stableObs })
const k2 = buildMessageDedupeKey({ appType: 'wechat' as AppType, observedMessage: stableObs })
expect('stable message id produces identical dedupe keys', k1 === k2, `${k1} != ${k2}`)

// 2. Different message ids must produce different dedupe keys.
const anotherObs = makeObserved({ id: 'msg-stable-2' })
const kOther = buildMessageDedupeKey({ appType: 'wechat' as AppType, observedMessage: anotherObs })
expect('different message ids produce different dedupe keys', k1 !== kOther, `${k1} == ${kOther}`)

// 3. The pool only allows one entry per key; subsequent starts return started=false with the current status.
const pool = new MessageDedupePool({ ttlMs: 60_000, maxEntries: 100 })
const firstStart = pool.start(k1, 1000)
const secondStart = pool.start(k1, 1100)
expect('first start returns started=true', firstStart.started === true)
expect('second start returns started=false with status=in_progress', secondStart.started === false && secondStart.status === 'in_progress', JSON.stringify(secondStart))
pool.complete(k1, 1200)
const thirdStart = pool.start(k1, 1300)
expect('after complete(), the entry is still tracked (started=false, status=completed)', thirdStart.started === false && thirdStart.status === 'completed', JSON.stringify(thirdStart))

// 4. release() drops the entry so it can be started again immediately.
const pool2 = new MessageDedupePool()
pool2.start('chat:x', 1000)
pool2.release('chat:x')
const restart = pool2.start('chat:x', 1001)
expect('release() allows the key to be started again', restart.started === true, JSON.stringify(restart))

// 5. TTL prunes stale entries; using a key after the TTL elapses must succeed.
const pool3 = new MessageDedupePool({ ttlMs: 1000, maxEntries: 100 })
pool3.start('chat:y', 1000)
// Far past TTL
const afterTtl = pool3.start('chat:y', 1000 + 5_000)
expect('expired entries are pruned so a new start succeeds', afterTtl.started === true, JSON.stringify(afterTtl))

// 6. maxEntries evicts the oldest entries when capacity is hit.
const pool4 = new MessageDedupePool({ maxEntries: 2 })
pool4.start('chat:a', 1000)
pool4.start('chat:b', 1100)
pool4.start('chat:c', 1200) // evicts chat:a
const retryA = pool4.start('chat:a', 1300)
expect('oldest entry is evicted when maxEntries is exceeded', retryA.started === true, JSON.stringify(retryA))

// 7. reset() clears all state.
const pool5 = new MessageDedupePool()
pool5.start('chat:z', 1000)
pool5.reset()
const afterReset = pool5.start('chat:z', 1100)
expect('reset() clears the pool so the same key can be started again', afterReset.started === true, JSON.stringify(afterReset))

// 8. Content-only observations fall back to a preview-based hash and bucket by 5 minutes.
const previewObs = makeObserved({ content: 'price please', timestamp: 1700000000000 })
const sameTimeObs = makeObserved({ content: 'price please', timestamp: 1700000000000 + 60_000 })
const laterObs = makeObserved({ content: 'price please', timestamp: 1700000000000 + 6 * 60 * 1000 })
const pk1 = buildMessageDedupeKey({ appType: 'wechat' as AppType, observedMessage: previewObs })
const pk2 = buildMessageDedupeKey({ appType: 'wechat' as AppType, observedMessage: sameTimeObs })
const pk3 = buildMessageDedupeKey({ appType: 'wechat' as AppType, observedMessage: laterObs })
expect('preview fallback produces a stable key within the same 5-min bucket', pk1 === pk2, `${pk1} != ${pk2}`)
expect('preview fallback rolls over once we cross a 5-min bucket', pk1 !== pk3, `${pk1} == ${pk3}`)

console.log('[MessageDedupe] results', results)
if (failed > 0) {
  console.error('[MessageDedupe] failed: ' + failed)
  process.exit(1)
}
