import { AppType } from './rpa/types'
import { LatestMessageInspection } from './rpa/latest-message-inspector'
import { type ObservedChatMessage } from './chat/message-types'
import { type ReplyRelevanceResult } from './reply-relevance'
import { type KnowledgeContext } from './knowledge-base'
import { type SendVerificationResult } from './channel-adapter'

export interface ReplyContext {
  latestMessage?: LatestMessageInspection
  observedMessage?: ObservedChatMessage | null
  knowledge?: KnowledgeContext | null
  traceId?: string
}

export interface ProviderInput {
  screenshot: string
  appType: AppType
  currentContact?: string
  ocrText?: string
  replyContext?: ReplyContext
}

export type ProviderEvent =
  | { type: 'thinking'; content: string }
  | { type: 'observed_message'; message: ObservedChatMessage }
  | { type: 'reply_relevance'; result: ReplyRelevanceResult; replyText: string }
  | { type: 'reply_text'; content: string }
  | { type: 'skip' }
  | { type: 'error'; error: string }

export type SessionEvent =
  | { type: 'bootstrap' }
  | { type: 'observe_chat'; screenshot?: string }
  | { type: 'provider.thinking'; content: string; messageKey?: string }
  | { type: 'provider.observed_message'; message: ObservedChatMessage; messageKey?: string }
  | { type: 'provider.reply_relevance'; result: ReplyRelevanceResult; replyText: string; messageKey?: string }
  | { type: 'provider.reply_text'; content: string; messageKey?: string }
  | { type: 'provider.skip'; messageKey?: string }
  | { type: 'provider.error'; error: string; messageKey?: string; elapsedMs?: number }
  | { type: 'check_unread' }
  | { type: 'wait_retry'; reason?: string; delayMs?: number }

export interface ProviderAdapter {
  run(input: ProviderInput): AsyncIterable<ProviderEvent>
}

export interface RuntimeHostControls {
  enqueue(event: SessionEvent): void
  schedule(event: SessionEvent, delayMs: number): void
  runProvider(input: ProviderInput): AsyncIterable<ProviderEvent>
  getKnowledgeContext?(message: ObservedChatMessage | null | undefined): Promise<KnowledgeContext>
  isHumanHandoffActive?(chatKey: string): boolean
  setHumanHandoff?(chatKey: string, active: boolean, reason?: string): void
  recordTrace?(event: {
    type:
      | 'start'
      | 'observed_message'
      | 'knowledge'
      | 'provider_reply'
      | 'policy'
      | 'sent'
      | 'blocked'
      | 'failed'
      | 'skipped'
      | 'drafted'
      | 'verified'
    traceId?: string
    appType: AppType
    messageKey: string
    screenshot?: string
    latestMessage?: LatestMessageInspection | null
    observedMessage?: ObservedChatMessage | null
    observationStages?: Array<{
      stage: 'accessibility' | 'native-structure' | 'ocr' | 'vision'
      hit: boolean
      reason?: string
      confidence?: number
    }>
    knowledge?: KnowledgeContext | null
    replyText?: string
    policyDecision?: unknown
    executionMode?: string
    error?: string
    detail?: string
    verification?: SendVerificationResult
  }): Promise<string | undefined>
  log(type: 'thinking' | 'reply' | 'skip' | 'error' | 'metric', content: string): void
  isRunning(): boolean
  stopSession(reason?: string): Promise<void>
}

export interface ChannelContext<TState> {
  appType: AppType
  state: TState
  host: RuntimeHostControls
}

export interface ChannelSession<TState> {
  onStart(ctx: ChannelContext<TState>): Promise<void>
  onStop(ctx: ChannelContext<TState>): Promise<void>
  onEvent(event: SessionEvent, ctx: ChannelContext<TState>): Promise<void>
}
