import {
  GenericChannelSession,
  createInitialGenericChannelState,
  type GenericChannelState
} from '../generic-channel-session'
import type {
  ChannelContext,
  RuntimeHostControls,
  SessionEvent,
  ProviderEvent,
  ProviderInput
} from '../session-types'
import type { ObservedChatMessage } from '../chat/message-types'
import type { ReplySendOptions } from '../rpa/input-utils'
import { DEFAULT_AUTOMATION_SETTINGS } from '../automation-settings'
import type { KnowledgeContext } from '../knowledge-base'
import type {
  ChannelAdapter,
  ChannelObservation,
  SendVerificationResult
} from '../channel-adapter'

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

class FakeChannelAdapter implements ChannelAdapter {
  readonly kind = 'native-pc' as const
  sendOk = false
  verifyOk = true
  verifyReason: SendVerificationResult['reason'] = 'verified'

  setAppType(): void {}
  setApiKey(): void {}
  setReplyOutputConfig(): void {}
  onSessionStart(): void {}
  onSessionStop(): void {}

  async healthCheck() {
    return { ok: true }
  }

  async measureLayout() {
    return { success: true }
  }

  async screenshot(): Promise<string> {
    return 'data:image/png;base64,'
  }

  async inspectLatestMessage() {
    return {
      detected: true,
      latestFromSelf: false,
      confidence: 0.85
    }
  }

  async inspectLatestObserved() {
    return null
  }

  async observe(): Promise<ChannelObservation> {
    return {
      screenshot: 'data:image/png;base64,',
      latestMessage: {
        detected: true,
        latestFromSelf: false,
        confidence: 0.85
      },
      observedMessage: null,
      source: 'vision'
    }
  }

  async hasUnreadMessage() {
    return { hasUnread: false }
  }

  async isChatContactUnread() {
    return { isUnread: false }
  }

  clearUnreadCache(): void {}

  async setChatBaseline() {
    return true
  }

  async hasChatAreaChanged() {
    return { hasDiff: true, hasBaseline: true, diffPercentage: 0.9 }
  }

  clearChatBaseline(): void {}

  async sendMessage(_text: string, _options?: ReplySendOptions): Promise<boolean> {
    return this.sendOk
  }

  async verifySend(_text: string, options?: ReplySendOptions): Promise<SendVerificationResult> {
    return {
      ok: this.verifyOk,
      mode: options?.submit === false ? 'drafted' : 'sent',
      reason: this.verifyReason
    }
  }

  async activeUnreadByClick(): Promise<void> {}
  async clickUnreadContact(): Promise<void> {}
  async clickAt(): Promise<void> {}

  async checkAutomationSafety() {
    return { safe: true }
  }
}

interface FakeHost extends RuntimeHostControls {
  logEntries: Array<{ type: string; content: string }>
  enqueued: SessionEvent[]
  stopReasons: string[]
  traceEvents: Array<Record<string, unknown>>
}

function makeHost(): FakeHost {
  const host: FakeHost = {
    logEntries: [],
    enqueued: [],
    stopReasons: [],
    traceEvents: [],
    enqueue(event: SessionEvent) {
      this.enqueued.push(event)
    },
    schedule(): void {},
    async *runProvider(_input: ProviderInput): AsyncIterable<ProviderEvent> {
      // replaced per test
    },
    async getKnowledgeContext(_message: ObservedChatMessage | null | undefined): Promise<KnowledgeContext> {
      return null as unknown as KnowledgeContext
    },
    isHumanHandoffActive(): boolean {
      return false
    },
    setHumanHandoff(): void {},
    async recordTrace(event): Promise<string> {
      const id = 'trace-' + (this.traceEvents.length + 1)
      this.traceEvents.push({ id, ...event })
      return id
    },
    log(type, content) {
      this.logEntries.push({ type, content })
    },
    isRunning(): boolean {
      return true
    },
    async stopSession(reason?: string): Promise<void> {
      this.stopReasons.push(reason || 'unknown')
    }
  }
  return host
}

async function driveUntilIdle(
  session: GenericChannelSession,
  ctx: ChannelContext<GenericChannelState>,
  idleRoundsToStop = 3
): Promise<void> {
  const host = ctx.host as FakeHost
  let idleRounds = 0
  while (idleRounds < idleRoundsToStop) {
    if (host.enqueued.length > 0) {
      const event = host.enqueued.shift()!
      await session.onEvent(event, ctx)
      idleRounds = 0
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
    idleRounds += 1
  }
}

async function runOneRound(
  adapter: FakeChannelAdapter,
  observed: ObservedChatMessage,
  replyText: string
): Promise<{
  host: FakeHost
  ctx: ChannelContext<GenericChannelState>
}> {
  const host = makeHost()
  const state = createInitialGenericChannelState()
  const session = new GenericChannelSession(adapter)
  const ctx: ChannelContext<GenericChannelState> = { appType: 'wechat', state, host }

  ;(host as unknown as { runProvider: (input: ProviderInput) => AsyncIterable<ProviderEvent> }).runProvider =
    async function* (): AsyncIterable<ProviderEvent> {
      yield { type: 'observed_message', message: observed }
      yield { type: 'reply_text', content: replyText }
    }

  await session.onStart(ctx)
  await driveUntilIdle(session, ctx)
  return { host, ctx }
}

async function main(): Promise<void> {
  const observed: ObservedChatMessage = {
    chat: { id: 'wechat:1', type: 'direct', name: 'Tester', whitelisted: false },
    direction: 'contact',
    kind: 'text',
    content: 'hi',
    confidence: 0.9,
    source: 'vision',
    timestamp: 1700000000000
  }

  const adapterFailSend = new FakeChannelAdapter()
  adapterFailSend.sendOk = false
  const { host, ctx } = await runOneRound(adapterFailSend, observed, 'hello back')

  expect(
    'send failure trips stopSession(automation_send_failed)',
    host.stopReasons.includes('automation_send_failed'),
    JSON.stringify(host.stopReasons)
  )
  expect(
    'send failure increments consecutiveExecutionFailures to 1',
    ctx.state.consecutiveExecutionFailures === 1,
    'count=' + ctx.state.consecutiveExecutionFailures
  )

  const failedTraces = host.traceEvents.filter((t) => t.type === 'failed')
  expect(
    'at least one failed trace recorded',
    failedTraces.length >= 1,
    'failed=' + failedTraces.length
  )
  expect(
    'failed trace carries error=send_failed',
    failedTraces[0]?.error === 'send_failed',
    JSON.stringify(failedTraces[0]?.error)
  )

  expect(
    'breaker threshold is 3 by default',
    DEFAULT_AUTOMATION_SETTINGS.maxConsecutiveFailures === 3,
    String(DEFAULT_AUTOMATION_SETTINGS.maxConsecutiveFailures)
  )

  expect(
    'fresh state starts with counter 0',
    createInitialGenericChannelState().consecutiveExecutionFailures === 0,
    'init=' + createInitialGenericChannelState().consecutiveExecutionFailures
  )

  const host2 = makeHost()
  const state2 = createInitialGenericChannelState()
  const adapterProviderError = new FakeChannelAdapter()
  const session2 = new GenericChannelSession(adapterProviderError)
  const ctx2: ChannelContext<GenericChannelState> = { appType: 'wechat', state: state2, host: host2 }
  ;(host2 as unknown as { runProvider: (input: ProviderInput) => AsyncIterable<ProviderEvent> }).runProvider =
    async function* (): AsyncIterable<ProviderEvent> {
      yield { type: 'observed_message', message: observed }
      yield { type: 'error', error: 'provider crashed' }
    }
  await session2.onStart(ctx2)
  await driveUntilIdle(session2, ctx2)
  expect(
    'provider error does not increment send counter',
    ctx2.state.consecutiveExecutionFailures === 0,
    'count=' + ctx2.state.consecutiveExecutionFailures
  )
  expect(
    'provider error triggers a wait_retry (no stopSession)',
    host2.stopReasons.length === 0,
    JSON.stringify(host2.stopReasons)
  )

  const adapterVerifyFail = new FakeChannelAdapter()
  adapterVerifyFail.sendOk = true
  adapterVerifyFail.verifyOk = false
  adapterVerifyFail.verifyReason = 'no_visual_change'
  const { host: host3, ctx: ctx3 } = await runOneRound(adapterVerifyFail, observed, 'verified reply')
  expect(
    'verification failure trips stopSession(automation_no_visual_change)',
    host3.stopReasons.includes('automation_no_visual_change'),
    JSON.stringify(host3.stopReasons)
  )
  expect(
    'verification failure keeps latestVerificationReason',
    ctx3.state.latestVerificationReason === 'no_visual_change',
    String(ctx3.state.latestVerificationReason)
  )
  const verifyEvents = host3.traceEvents.filter((t) => t.type === 'verified')
  expect(
    'verified trace event is recorded before failure',
    verifyEvents.length === 1,
    JSON.stringify(verifyEvents)
  )

  console.log('[GenericChannelSession circuit-breaker] results', results)
  if (failed > 0) {
    console.error('[GenericChannelSession circuit-breaker] failed: ' + failed)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('circuit-breaker test crashed', error)
  process.exit(1)
})
