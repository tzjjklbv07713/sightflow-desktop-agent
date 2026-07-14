import { __testing__ } from '../chat-messages'

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

const { normalizeRow, normalizeSuccess } = __testing__

const centerX = 500
const pane = { x: 0, y: 0, width: 1000, height: 800 }

const selfRow = normalizeRow(
  {
    text: 'Hello, here is the quote you asked for',
    direction: 'self',
    automationId: 'message-42',
    runtimeId: '42-7',
    bounds: { x: 600, y: 100, width: 380, height: 60 }
  },
  centerX
)
const contactRow = normalizeRow(
  {
    text: 'Thanks! Please send me the invoice',
    direction: 'contact',
    automationId: 'message-43',
    runtimeId: '42-8',
    bounds: { x: 20, y: 180, width: 380, height: 60 }
  },
  centerX
)
const fallbackRow = normalizeRow(
  {
    text: 'Window-aligned fallback row',
    bounds: { x: 0, y: 240, width: 400, height: 60 }
  },
  centerX
)
const emptyRow = normalizeRow(
  {
    text: '   '
  },
  centerX
)

expect('automation id becomes a stable messageId', selfRow?.messageId === 'uia:message-42')
expect('contact direction preserved', contactRow?.direction === 'contact')
expect('self direction preserved', selfRow?.direction === 'self')
expect('bounds-only row gets a hash id', Boolean(fallbackRow?.messageId.startsWith('uia:hash:')))
expect('empty rows are dropped', emptyRow === null)

const snapshot = normalizeSuccess('wechat', {
  ok: true,
  paneBounds: pane,
  chatCenterX: centerX,
  rows: [selfRow, contactRow, fallbackRow, emptyRow] as never
})
expect('snapshot total excludes empty rows', snapshot.total === 3)
expect('snapshot rows contain stable ids', snapshot.rows.every((row) => row.messageId.startsWith('uia:')))
expect('snapshot keeps pane bounds', Boolean(snapshot.paneBounds?.width === 1000))
expect('snapshot app type matches', snapshot.appType === 'wechat')

console.log('[UIAutomation chat-messages] results', results)
if (failed > 0) {
  console.error(`[UIAutomation chat-messages] failed: ${failed}`)
  process.exit(1)
}
