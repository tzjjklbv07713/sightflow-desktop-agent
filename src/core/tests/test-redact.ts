import { redactPII, redactTrace, redactTraces, redactSettingsSummary, DEFAULT_REDACTION_OPTIONS } from '../redact'

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

// === PII redaction ===
expect('CN mobile redacted',
  redactPII('call me at 13812345678 thanks').includes('[REDACTED]'),
  redactPII('call me at 13812345678 thanks'))
expect('+86 mobile redacted',
  redactPII('+86 13812345678').includes('[REDACTED]'),
  redactPII('+86 13812345678'))
expect('email redacted',
  redactPII('ping alice@example.com').includes('[REDACTED]'),
  redactPII('ping alice@example.com'))
expect('18-digit id redacted',
  redactPII('card 11010119900101001X done').includes('[REDACTED]'),
  redactPII('card 11010119900101001X done'))
expect('plain text unchanged',
  redactPII('hello world no PII') === 'hello world no PII',
  redactPII('hello world no PII'))

// === Default options ===
expect('default stripScreenshots', DEFAULT_REDACTION_OPTIONS.stripScreenshots === true)
expect('default redactPII', DEFAULT_REDACTION_OPTIONS.redactPII === true)
expect('default keepKnowledgeTitles', DEFAULT_REDACTION_OPTIONS.keepKnowledgeTitles === false)

// === Trace redaction ===
const sampleTrace = {
  id: 'wechat_xyz',
  status: 'sent',
  replyText: 'Hi 13812345678 your order #12345 is on the way',
  chat: { id: 'wechat:alice', type: 'direct', name: 'Alice Wang <alice@example.com>', whitelisted: false },
  observedMessage: {
    direction: 'contact',
    content: 'where is my order',
    senderName: 'Alice' 
  },
  knowledge: { matches: [], confidence: 0.7, hasAnswer: true, forbiddenMatched: false, summary: 'see shipping FAQ', title: 'Shipping', content: 'Standard 3-5 days' },
  screenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  screenshotEvidence: { capturedAt: 1700000000000, dataUrl: 'data:image/png;base64,longdata...' },
  events: [{ at: '2026-01-01T00:00:00Z', type: 'trace_started', detail: 'hello' }]
}
const redacted = redactTrace(sampleTrace) as Record<string, unknown>
expect('trace id preserved', redacted.id === 'wechat_xyz', String(redacted.id))
expect('trace status preserved', redacted.status === 'sent')
const chat = redacted.chat as Record<string, unknown>
expect('chat name PII redacted', !String(chat.name).includes('alice@example.com'), String(chat.name))
expect('chat id preserved', chat.id === 'wechat:alice')
expect('chat type preserved', chat.type === 'direct')
expect('replyText truncated+redacted', String(redacted.replyText).includes('[truncated]') || String(redacted.replyText).includes('[REDACTED]'), String(redacted.replyText))
expect('mobile in replyText redacted', !String(redacted.replyText).includes('13812345678'))
const obs = redacted.observedMessage as Record<string, unknown>
expect('observed content redacted field', typeof obs.content === 'string' && obs.content !== 'where is my order', String(obs.content))
expect('observed senderName redacted', typeof obs.senderName === 'string' && obs.senderName !== 'Alice', String(obs.senderName))
const kw = redacted.knowledge as Record<string, unknown>
expect('knowledge summary redacted', typeof kw.summary === 'string' && kw.summary !== 'see shipping FAQ', String(kw.summary))
expect('knowledge title redacted by default', typeof kw.title === 'string' && kw.title !== 'Shipping', String(kw.title))
expect('screenshot stripped', String(redacted.screenshot) === '[stripped]', String(redacted.screenshot))
const ev = redacted.screenshotEvidence as Record<string, unknown>
expect('screenshotEvidence stripped', ev.stripped === true && typeof ev.capturedAt === 'number', JSON.stringify(ev))
const events = redacted.events as Array<Record<string, unknown>>
expect('events preserved', Array.isArray(events) && events.length === 1 && events[0].type === 'trace_started')

// === Keep knowledge titles when requested ===
const keepTitles = redactTrace(sampleTrace, { keepKnowledgeTitles: true }) as Record<string, unknown>
const kw2 = keepTitles.knowledge as Record<string, unknown>
expect('keepKnowledgeTitles preserves title', kw2.title === 'Shipping', String(kw2.title))

// === Multiple traces batch ===
const batch = redactTraces([sampleTrace, sampleTrace])
expect('redactTraces returns array of length 2', Array.isArray(batch) && batch.length === 2)
expect('batch items are redacted', String((batch[0] as Record<string, unknown>).chat && (batch[0] as { chat: { name: string } }).chat.name).length > 0 && !String((batch[0] as { chat: { name: string } }).chat.name).includes('alice@example.com'))

// === Settings summary redaction (less aggressive) ===
const settings = {
  appType: 'wechat',
  replyPolicy: { sensitiveKeywords: ['refund'], contactEmail: 'ops@company.com' },
  model: { baseUrl: 'https://api.openai.com/v1', name: 'gpt-4' }
}
const sRed = redactSettingsSummary(settings) as Record<string, unknown>
const rp = sRed.replyPolicy as Record<string, unknown>
expect('settings appType preserved', sRed.appType === 'wechat')
const se = rp.contactEmail as string
expect('settings email redacted', !se.includes('ops@company.com'), se)

console.log('[Redact] results', results)
if (failed > 0) { console.error('[Redact] failed: ' + failed); process.exit(1) }

