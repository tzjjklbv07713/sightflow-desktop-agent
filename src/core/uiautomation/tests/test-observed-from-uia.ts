import { observedFromUia, pickLatestIncomingRow } from '../observed-from-uia'
import type { UiChatMessageSnapshot } from '../chat-messages'

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

function makeSnapshot(rows: Array<{
  messageId?: string
  text: string
  direction: 'self' | 'contact' | 'system' | 'unknown'
  senderName?: string
}>): UiChatMessageSnapshot {
  return {
    ok: true,
    appType: 'wechat',
    capturedAt: 1700000000000,
    total: rows.length,
    rows: rows.map((r, i) => ({
      messageId: r.messageId ?? `uia:row-${i}`,
      text: r.text,
      direction: r.direction,
      senderName: r.senderName ?? '',
      bounds: { x: 100, y: 100 + i * 40, width: 240, height: 32 }
    })),
    chatCenterX: 200
  }
}

const happySnapshot = makeSnapshot([
  { text: 'old hello', direction: 'contact', senderName: 'Alice' },
  { text: 'self ping', direction: 'self', senderName: 'Me' },
  { text: 'new question', direction: 'contact', senderName: 'Alice' }
])
const happyObs = observedFromUia('wechat', happySnapshot)
expect('happy path returns an observation', happyObs !== null)
expect('happy path message text is from latest contact row', happyObs?.content === 'new question', JSON.stringify(happyObs))
expect('happy path direction is contact', happyObs?.direction === 'contact')
expect('happy path senderName carried over', happyObs?.senderName === 'Alice')
expect('happy path messageId uses row id', happyObs?.messageId === 'uia:row-2')
expect('happy path source is uiautomation', happyObs?.source === 'uiautomation')
expect('happy path chat type defaults to direct', happyObs?.chat.type === 'direct')

const onlySelf = makeSnapshot([
  { text: 'self 1', direction: 'self' },
  { text: 'self 2', direction: 'self' }
])
const onlySelfObs = observedFromUia('wechat', onlySelf)
expect('only-self snapshot still returns last row', onlySelfObs?.direction === 'self')

const emptySnapshot: UiChatMessageSnapshot = {
  ok: true,
  appType: 'wechat',
  capturedAt: 0,
  total: 0,
  rows: []
}
expect('empty snapshot returns null', observedFromUia('wechat', emptySnapshot) === null)

const failureResult = {
  ok: false as const,
  appType: 'wechat' as const,
  reason: 'no_chat_pane' as const,
  message: 'no chat pane'
}
expect('failure snapshot returns null', observedFromUia('wechat', failureResult) === null)

const customObs = observedFromUia('wework', happySnapshot, {
  chatName: '客服小王',
  chatType: 'group'
})
expect('custom chat name produces stable chat id', customObs?.chatId === customObs?.chat.id)
expect('custom chat type overrides default', customObs?.chat.type === 'group')
expect('custom chat name preserved', customObs?.chat.name === '客服小王')

const mixedPicked = pickLatestIncomingRow([
  { messageId: 'a', text: 'a', direction: 'self', senderName: 'me' },
  { messageId: 'b', text: 'b', direction: 'system', senderName: 'sys' },
  { messageId: 'c', text: 'c', direction: 'contact', senderName: 'them' },
  { messageId: 'd', text: 'd', direction: 'self', senderName: 'me' }
])
expect('pickLatestIncomingRow prefers latest contact row', mixedPicked?.messageId === 'c')

const fallbackPicked = pickLatestIncomingRow([
  { messageId: 'x', text: 'x', direction: 'self', senderName: 'me' },
  { messageId: 'y', text: 'y', direction: 'system', senderName: 'sys' }
])
expect('pickLatestIncomingRow falls back to last row when no contact', fallbackPicked?.messageId === 'y')

console.log('[UIA observed-from-uia] results', results)
if (failed > 0) {
  console.error('[UIA observed-from-uia] failed: ' + failed)
  process.exit(1)
}