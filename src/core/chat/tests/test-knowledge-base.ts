
import { KnowledgeBase } from '../../knowledge-base'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync, mkdtempSync } from 'node:fs'
import type { ObservedChatMessage } from '../message-types'

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

function buildMessage(content: string): ObservedChatMessage {
  return {
    chat: { id: 'wechat:kb', type: 'direct', name: 'Test', whitelisted: false },
    direction: 'contact',
    kind: 'text',
    content,
    confidence: 0.9,
    source: 'vision',
    timestamp: 1700000000000
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sightflow-kb-'))
  const file = join(dir, 'knowledge-base.json')
  const kb = new KnowledgeBase(file)

  const empty = kb.search(buildMessage('anything'))
  expect('empty KB returns empty context',
    empty.matches.length === 0 && empty.confidence === 0 && empty.hasAnswer === false,
    JSON.stringify(empty))

  // Seed the knowledge base with mixed FAQ + forbidden entries.
  const faqEntries = [
    { kind: 'faq', title: 'Pricing', content: 'Basic plan 99 per month, Pro plan 299 per month, Enterprise plan 999 per month.', keywords: ['price', 'pricing', 'plan'] },
    { kind: 'faq', title: 'Refund', content: '7-day no-questions-asked refund. Request from the order page.', keywords: ['refund'] },
    { kind: 'policy', title: 'Complaints', content: 'Email support@example.com for complaints.', keywords: ['complaint'] }
  ]
  await kb.replace(faqEntries as never)
  const forbidden = { kind: 'forbidden' as const, title: 'Forbidden phrases', content: 'Never promise 100 percent fix, never mention competitors, never send external links.', keywords: ['100%'] }
  await kb.replace([...faqEntries, forbidden] as never)

  const priceHit = kb.search(buildMessage('what is the price of the pro plan'))
  expect('price query has hasAnswer', priceHit.hasAnswer, JSON.stringify(priceHit))
  expect('price query top match is Pricing',
    priceHit.matches[0]?.entry.title === 'Pricing',
    priceHit.matches[0]?.entry.title)
  expect('price query confidence > 0.2', priceHit.confidence > 0.2, String(priceHit.confidence))

  const refundHit = kb.search(buildMessage('how do I get a refund'))
  expect('refund query top match is Refund',
    refundHit.matches[0]?.entry.title === 'Refund',
    refundHit.matches[0]?.entry.title)

  const forbiddenHit = kb.search(buildMessage('can you promise 100% solve'))
  expect('forbidden keyword flags forbiddenMatched',
    forbiddenHit.forbiddenMatched === true,
    JSON.stringify(forbiddenHit))

  const irrelevant = kb.search(buildMessage('zzqqxx something completely unrelated'))
  expect('irrelevant query returns no hasAnswer',
    irrelevant.hasAnswer === false,
    JSON.stringify(irrelevant))

  const before = kb.list().length
  const all = kb.list()
  const pricingEntry = all.find((e) => e.title === 'Pricing')
  if (pricingEntry) {
    await kb.replace(all.map((e) => (e.title === 'Pricing' ? { ...e, enabled: false } : e)) as never)
  }
  const afterDisable = kb.search(buildMessage('price please'))
  expect('disabled entries are excluded from search',
    afterDisable.matches.every((m) => m.entry.title !== 'Pricing'),
    JSON.stringify(afterDisable.matches.map((m) => m.entry.title)))
  void before

  const listed = kb.list()
  listed.pop()
  const stillThere = kb.list()
  expect('list() returns a copy (mutation does not affect storage)',
    stillThere.length === all.length,
    String(stillThere.length))

  unlinkSync(file)
  console.log('[KnowledgeBase] results', results)
  if (failed > 0) {
    console.error('[KnowledgeBase] failed: ' + failed)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('knowledge base test crashed', error)
  process.exit(1)
})
