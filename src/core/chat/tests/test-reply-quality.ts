import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeBase } from '../../knowledge-base'
import { DEFAULT_REPLY_POLICY_CONFIG, ReplyPolicy } from '../reply-policy'
import type { ObservedChatMessage } from '../message-types'
import type { AppType } from '../../rpa/types'

// Reply quality end-to-end suite:
// - KnowledgeBase search + ReplyPolicy combined to confirm common customer
//   questions route to auto-send vs draft vs human handoff.
// - Confidence threshold, sensitive intent, group policy, blocked chat,
//   duplicate reply, daily limit, and own-message filtering all enforced.

interface TestResult {
  name: string
  pass: boolean
  detail?: string
}

const results: TestResult[] = []
let failed = 0
function expect(name: string, condition: boolean, detail?: string): void {
  if (condition) results.push({ name, pass: true })
  else { results.push({ name, pass: false, detail }); failed += 1 }
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
    chatId?: string
    senderName?: string
    mentioned?: boolean
    whitelisted?: boolean
  } = {}
): ObservedChatMessage {
  return {
    chatId: overrides.chatId ?? `${appType}:pricing`,
    chat: {
      id: overrides.chatId ?? `${appType}:pricing`,
      type: overrides.chatType ?? 'direct',
      name: overrides.chatName ?? 'Pricing Question',
      whitelisted: overrides.whitelisted ?? false
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

// --- Knowledge base setup ---
const kbDir = mkdtempSync(join(tmpdir(), 'sightflow-rq-'))
const kbFile = join(kbDir, 'kb.json')
const kb = new KnowledgeBase(kbFile)
void kbFile
const now = Date.now()

async function seedKb(): Promise<void> {
  await kb.replace([
    { id: 'faq-pricing', kind: 'faq', title: 'Pricing', content: 'Basic plan 99 per month, Pro plan 299 per month, Enterprise 999 per month.', keywords: ['price', 'pricing', 'plan'], enabled: true, updatedAt: new Date().toISOString() },
    { id: 'faq-shipping', kind: 'faq', title: 'Shipping', content: 'Standard shipping 3 to 5 business days. Express next-day delivery is available for 29.', keywords: ['shipping', 'delivery', 'express'], enabled: true, updatedAt: new Date().toISOString() },
    { id: 'faq-hours', kind: 'faq', title: 'Business hours', content: 'We respond Monday through Friday 9 to 18 Beijing time. Weekend messages are queued for Monday.', keywords: ['hours', 'when', 'weekend'], enabled: true, updatedAt: new Date().toISOString() },
    { id: 'forbidden-promise', kind: 'forbidden', title: 'Forbidden phrases', content: 'Never promise 100 percent fix, never mention competitors, never send external links.', keywords: ['100%', 'competitor'], enabled: true, updatedAt: new Date().toISOString() }
  ] as never)
}

async function main(): Promise<void> {
  await seedKb()

  // === Scenario 1: FAQ pricing hits, high confidence, auto-send ===
  const pricingObs = makeObservation('wechat', 'what is the price of the pro plan')
  const pricingCtx = kb.search(pricingObs)
  expect('pricing knowledge has answer', pricingCtx.hasAnswer === true, JSON.stringify(pricingCtx))
  expect('pricing top match is Pricing', pricingCtx.matches[0]?.entry.title === 'Pricing', pricingCtx.matches[0]?.entry.title)
  expect('pricing confidence >= 0.4', pricingCtx.confidence >= 0.4, String(pricingCtx.confidence))
  const pricingPolicy = makePolicy({ requireKnowledgeForAutoSend: true, minKnowledgeConfidence: 0.2 })
  const pricingDecision = pricingPolicy.evaluate({
    appType: 'wechat',
    replyText: 'Our Pro plan is 299 per month.',
    observedMessage: pricingObs,
    knowledgeMatched: pricingCtx.hasAnswer,
    knowledgeConfidence: pricingCtx.confidence,
    now
  })
  expect('pricing FAQ auto-send allowed', pricingDecision.allowed === true, JSON.stringify(pricingDecision))

  // === Scenario 2: Sensitive refund keyword blocks auto-send ===
  const refundObs = makeObservation('wechat', 'I want a refund please')
  const refundCtx = kb.search(refundObs)
  expect('refund query KB has no safe answer', refundCtx.hasAnswer === false || refundCtx.matches[0]?.entry.id !== 'faq-pricing', JSON.stringify(refundCtx))
  const refundPolicy = makePolicy({ sensitiveKeywords: ['refund', 'complaint'] })
  const refundDecision = refundPolicy.evaluate({
    appType: 'wechat',
    replyText: 'We will process your refund.',
    observedMessage: refundObs,
    knowledgeMatched: refundCtx.hasAnswer,
    knowledgeConfidence: refundCtx.confidence,
    now: now + 1
  })
  expect('refund triggers sensitive_intent block', refundDecision.allowed === false && refundDecision.reason === 'sensitive_intent', JSON.stringify(refundDecision))

  // === Scenario 3: Unknown topic with low confidence -> draft not auto-send ===
  const unknownObs = makeObservation('wechat', 'zzqqxx completely unrelated topic')
  const unknownCtx = kb.search(unknownObs)
  expect('unknown topic KB has no answer', unknownCtx.hasAnswer === false, JSON.stringify(unknownCtx))
  expect('unknown topic confidence below threshold', unknownCtx.confidence < 0.2, String(unknownCtx.confidence))
  const strictPolicy = makePolicy({ requireKnowledgeForAutoSend: true, minKnowledgeConfidence: 0.2 })
  const unknownDecision = strictPolicy.evaluate({
    appType: 'wechat',
    replyText: 'Sorry I am not sure.',
    observedMessage: unknownObs,
    knowledgeMatched: unknownCtx.hasAnswer,
    knowledgeConfidence: unknownCtx.confidence,
    now: now + 2
  })
  expect('unknown topic blocks under knowledge_required', unknownDecision.allowed === false && unknownDecision.reason === 'knowledge_required', JSON.stringify(unknownDecision))

  // === Scenario 4: Group chat without mention never auto-sends ===
  const groupObs = makeObservation('wechat', 'hi everyone shipping question', { chatType: 'group', chatName: 'Customer Group', mentioned: false })
  const groupDecision = makePolicy({ groupReplyMode: 'off', autoSendScope: 'all' }).evaluate({
    appType: 'wechat',
    replyText: 'ok',
    observedMessage: groupObs,
    now: now + 3
  })
  expect('group off mode blocks', groupDecision.allowed === false && groupDecision.reason === 'group_reply_disabled', JSON.stringify(groupDecision))

  // === Scenario 5: Group chat with mention + whitelist group passes ===
  const mentionObs = makeObservation('wechat', '@support what is shipping', { chatType: 'group', chatName: 'VIP Group', mentioned: true, whitelisted: true })
  const mentionDecision = makePolicy({ groupReplyMode: 'mention-only', autoSendScope: 'direct-and-whitelist-groups', groupWhitelist: ['VIP Group'] }).evaluate({
    appType: 'wechat',
    replyText: 'Standard shipping 3 to 5 days.',
    observedMessage: mentionObs,
    now: now + 4
  })
  expect('group mention allowed', mentionDecision.allowed === true, JSON.stringify(mentionDecision))

  // === Scenario 6: Own message never triggers reply ===
  const selfObs = makeObservation('wechat', 'ok thanks', { direction: 'self', confidence: 0.95 })
  const selfDecision = makePolicy().evaluate({
    appType: 'wechat',
    replyText: 'hi',
    observedMessage: selfObs,
    now: now + 5
  })
  expect('own message blocks', selfDecision.allowed === false && selfDecision.reason === 'latest_message_from_self', JSON.stringify(selfDecision))

  // === Scenario 7: Forbidden knowledge keyword flags but does not block by itself ===
  const forbiddenObs = makeObservation('wechat', 'can you guarantee 100% solve')
  const forbiddenCtx = kb.search(forbiddenObs)
  expect('forbidden keyword marks KB context', forbiddenCtx.forbiddenMatched === true, JSON.stringify(forbiddenCtx))
  const forbiddenDecision = makePolicy({ sensitiveKeywords: ['100%'] }).evaluate({
    appType: 'wechat',
    replyText: 'We will do our best.',
    observedMessage: forbiddenObs,
    knowledgeMatched: forbiddenCtx.hasAnswer,
    knowledgeConfidence: forbiddenCtx.confidence,
    now: now + 6
  })
  expect('forbidden keyword hits sensitive_intent', forbiddenDecision.allowed === false && forbiddenDecision.reason === 'sensitive_intent', JSON.stringify(forbiddenDecision))

  // === Scenario 8: Duplicate reply in window blocks ===
  const dupPolicy = makePolicy({ minReplyIntervalMs: 0, duplicateReplyWindowMs: 60_000 })
  const dupObs = makeObservation('wechat', 'thanks', { chatId: 'wechat:dup1' })
  const d1 = dupPolicy.evaluate({ appType: 'wechat', replyText: 'you are welcome', observedMessage: dupObs, now: now + 100 })
  expect('first dup reply allowed', d1.allowed === true, JSON.stringify(d1))
  dupPolicy.record(d1, now + 100)
  const d2 = dupPolicy.evaluate({ appType: 'wechat', replyText: 'you are welcome', observedMessage: dupObs, now: now + 200 })
  expect('duplicate reply blocks', d2.allowed === false && d2.reason === 'duplicate_reply', JSON.stringify(d2))

  // === Scenario 9: Per-chat daily limit blocks after N ===
  const dailyPolicy = makePolicy({ perChatDailyLimit: 2, minReplyIntervalMs: 0, duplicateReplyWindowMs: 0 })
  const dailyObs = makeObservation('wechat', 'q1', { chatId: 'wechat:daily' })
  const r1 = dailyPolicy.evaluate({ appType: 'wechat', replyText: 'a1', observedMessage: dailyObs, now: now + 300 })
  expect('daily reply 1 allowed', r1.allowed === true)
  dailyPolicy.record(r1, now + 300)
  const r2 = dailyPolicy.evaluate({ appType: 'wechat', replyText: 'a2', observedMessage: dailyObs, now: now + 301 })
  expect('daily reply 2 allowed', r2.allowed === true)
  dailyPolicy.record(r2, now + 301)
  const r3 = dailyPolicy.evaluate({ appType: 'wechat', replyText: 'a3', observedMessage: dailyObs, now: now + 302 })
  expect('daily reply 3 blocked by per-chat limit', r3.allowed === false && r3.reason === 'chat_daily_limit', JSON.stringify(r3))

  // === Scenario 10: Human handoff active always wins ===
  const handoffDecision = makePolicy({ humanHandoffEnabled: true }).evaluate({
    appType: 'wechat',
    replyText: 'anything',
    observedMessage: makeObservation('wechat', 'hi'),
    humanHandoffActive: true,
    now: now + 400
  })
  expect('handoff blocks', handoffDecision.allowed === false && handoffDecision.reason === 'human_handoff_active', JSON.stringify(handoffDecision))

  // === Scenario 11: Empty reply blocks ===
  const emptyDecision = makePolicy().evaluate({ appType: 'wechat', replyText: '   ', observedMessage: makeObservation('wechat', 'hi'), now: now + 500 })
  expect('empty reply blocks', emptyDecision.allowed === false && emptyDecision.reason === 'empty_reply', JSON.stringify(emptyDecision))

  // === Scenario 12: Shipping FAQ hits, medium confidence, auto-send allowed ===
  const shipObs = makeObservation('wechat', 'how long does shipping take')
  const shipCtx = kb.search(shipObs)
  expect('shipping KB has answer', shipCtx.hasAnswer === true)
  expect('shipping top match is Shipping', shipCtx.matches[0]?.entry.title === 'Shipping')
  const shipDecision = makePolicy({ requireKnowledgeForAutoSend: true, minKnowledgeConfidence: 0.2 }).evaluate({
    appType: 'wechat',
    replyText: 'Standard 3 to 5 business days.',
    observedMessage: shipObs,
    knowledgeMatched: shipCtx.hasAnswer,
    knowledgeConfidence: shipCtx.confidence,
    now: now + 600
  })
  expect('shipping FAQ auto-send allowed', shipDecision.allowed === true, JSON.stringify(shipDecision))

  console.log('[ReplyQuality] results', results)
  if (failed > 0) { console.error('[ReplyQuality] failed: ' + failed); process.exit(1) }
}

void main()

