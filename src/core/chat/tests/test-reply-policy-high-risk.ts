import { DEFAULT_REPLY_POLICY_CONFIG, ReplyPolicy } from '../reply-policy'
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

function makePolicy(overrides: Partial<typeof DEFAULT_REPLY_POLICY_CONFIG> = {}): ReplyPolicy {
  return new ReplyPolicy({ ...DEFAULT_REPLY_POLICY_CONFIG, ...overrides })
}

function makeObservation(
  appType: AppType,
  content: string,
  overrides: {
    direction?: 'self' | 'contact' | 'system' | 'unknown'
    confidence?: number
    chatType?: 'direct' | 'group' | 'service' | 'official' | 'unknown'
    chatName?: string
    senderName?: string
    mentioned?: boolean
  } = {}
): ObservedChatMessage {
  return {
    chat: {
      id: `${appType}:test`,
      type: overrides.chatType ?? 'direct',
      name: overrides.chatName ?? 'Test Chat',
      whitelisted: false
    },
    direction: overrides.direction ?? 'contact',
    kind: 'text',
    content,
    senderName: overrides.senderName,
    mentioned: overrides.mentioned,
    timestamp: Date.now(),
    confidence: overrides.confidence ?? 0.9,
    source: 'vision'
  }
}

const sensitivePolicy = makePolicy({
  sensitiveKeywords: ['refund', 'complaint', 'transfer'],
  manualHandoffKeywords: ['human', 'agent'],
  negativeIntentKeywords: ['scam', 'garbage'],
  blockedChatKeywords: ['blocked-customer']
})

const sensitiveObservation = makeObservation('wechat', 'I want a refund please')
const d1 = sensitivePolicy.evaluate({
  appType: 'wechat',
  replyText: 'Hi please wait',
  observedMessage: sensitiveObservation,
  now: Date.now()
})
expect('sensitive_intent blocks auto reply', d1.allowed === false && d1.reason === 'sensitive_intent', JSON.stringify(d1))

const handoffObservation = makeObservation('wechat', 'please connect me to a human agent')
const d2 = sensitivePolicy.evaluate({
  appType: 'wechat',
  replyText: 'Hi please wait',
  observedMessage: handoffObservation,
  now: Date.now()
})
expect('manual_handoff_required triggers handoff', d2.allowed === false && d2.reason === 'manual_handoff_required', JSON.stringify(d2))

const negativeObservation = makeObservation('wechat', 'you are a garbage company')
const d3 = sensitivePolicy.evaluate({
  appType: 'wechat',
  replyText: 'Hi',
  observedMessage: negativeObservation,
  now: Date.now()
})
expect('negative_intent blocks auto reply', d3.allowed === false && d3.reason === 'negative_intent', JSON.stringify(d3))

const blockedObservation = makeObservation('wechat', 'hello', { chatName: 'blocked-customer' })
const d4 = sensitivePolicy.evaluate({
  appType: 'wechat',
  replyText: 'Hi',
  observedMessage: blockedObservation,
  now: Date.now()
})
expect('blocked chat keyword blocks', d4.allowed === false && d4.reason === 'blocked_chat', JSON.stringify(d4))

const d5 = sensitivePolicy.evaluate({
  appType: 'wechat',
  replyText: 'hi',
  humanHandoffActive: true,
  now: Date.now()
})
expect('human_handoff_active blocks', d5.allowed === false && d5.reason === 'human_handoff_active', JSON.stringify(d5))

const dailyPolicy = makePolicy({ perChatDailyLimit: 2, minReplyIntervalMs: 0 })
const chatObs = makeObservation('wechat', 'first')
const now = Date.now()
const r1 = dailyPolicy.evaluate({ appType: 'wechat', replyText: 'one', observedMessage: chatObs, now })
expect('daily first allowed', r1.allowed === true)
dailyPolicy.record(r1, now)
const r2 = dailyPolicy.evaluate({ appType: 'wechat', replyText: 'two', observedMessage: chatObs, now: now + 1 })
expect('daily second allowed', r2.allowed === true)
dailyPolicy.record(r2, now + 1)
const r3 = dailyPolicy.evaluate({ appType: 'wechat', replyText: 'three', observedMessage: chatObs, now: now + 2 })
expect('daily limit blocks third', r3.allowed === false && r3.reason === 'chat_daily_limit', JSON.stringify(r3))

const knowledgePolicy = makePolicy({ requireKnowledgeForAutoSend: true })
const obsNoKnowledge = makeObservation('wechat', 'price please')
const k1 = knowledgePolicy.evaluate({
  appType: 'wechat',
  replyText: 'hi',
  observedMessage: obsNoKnowledge,
  knowledgeMatched: false,
  knowledgeConfidence: 0.1,
  now: now + 100
})
expect('knowledge_required blocks without match', k1.allowed === false && k1.reason === 'knowledge_required', JSON.stringify(k1))
const k2 = knowledgePolicy.evaluate({
  appType: 'wechat',
  replyText: 'hi',
  observedMessage: obsNoKnowledge,
  knowledgeMatched: true,
  knowledgeConfidence: 0.6,
  now: now + 200
})
expect('knowledge_required allows with sufficient match', k2.allowed === true, JSON.stringify(k2))

console.log('[ReplyPolicy high-risk] results', results)
if (failed > 0) {
  console.error('[ReplyPolicy high-risk] failed: ' + failed)
  process.exit(1)
}
