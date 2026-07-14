import type { AutomationSafetyResult } from './automation-safety'
import type { ObservedChatMessage } from './chat/message-types'
import type { LatestMessageInspection } from './rpa/latest-message-inspector'
import type { ReplyOutputConfig, ReplySendOptions } from './rpa/input-utils'
import type { AppType } from './rpa/types'
import type { BBox } from './rpa/vision-utils'

export type ChannelObservationSource =
  | 'accessibility'
  | 'native-structure'
  | 'ocr'
  | 'vision'
  | 'unknown'

export interface ChannelHealth {
  ok: boolean
  reason?: string
  details?: string
}

export interface ChannelObservation {
  latestMessage: LatestMessageInspection | null
  observedMessage: ObservedChatMessage | null
  screenshot: string
  source: ChannelObservationSource
  stages?: Array<{
    stage: 'accessibility' | 'native-structure' | 'ocr' | 'vision'
    hit: boolean
    reason?: string
    confidence?: number
  }>
}

export interface SendVerificationResult {
  ok: boolean
  mode: 'sent' | 'drafted'
  reason?:
    | 'verified'
    | 'missing_baseline'
    | 'no_visual_change'
    | 'send_failed'
    | 'verify_failed'
    | 'unsupported'
  details?: string
  evidence?: {
    diffPercentage?: number
    screenshot?: string
  }
}

export interface ChannelAdapter {
  readonly kind: 'official-api' | 'native-pc' | 'rpa-fallback'
  setAppType(appType: AppType): void
  setApiKey(apiKey: string, model?: string, baseURL?: string): void
  setReplyOutputConfig?(config: ReplyOutputConfig): void
  onSessionStart?(): Promise<void> | void
  onSessionStop?(): Promise<void> | void

  healthCheck(): Promise<ChannelHealth>
  measureLayout(): Promise<{ success: boolean; error?: string }>
  checkAutomationSafety?(): Promise<AutomationSafetyResult>

  screenshot(): Promise<string>
  inspectLatestMessage(screenshot?: string): Promise<LatestMessageInspection>
  inspectLatestObserved?(options?: {
    chatName?: string
    chatType?: 'direct' | 'group' | 'service' | 'official' | 'unknown'
  }): Promise<ObservedChatMessage | null>
  observe?(options?: {
    screenshot?: string
    chatName?: string
    chatType?: 'direct' | 'group' | 'service' | 'official' | 'unknown'
  }): Promise<ChannelObservation>

  hasUnreadMessage(): Promise<{
    hasUnread: boolean
    percentage?: number
    error?: string
    chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  }>

  isChatContactUnread(): Promise<{
    isUnread: boolean
    percentage?: number
    error?: string
    firstContactCoords?: [number, number]
  }>

  clearUnreadCache(): void
  setChatBaseline(screenshot?: string): Promise<boolean>
  hasChatAreaChanged(screenshot?: string): Promise<{
    hasDiff: boolean
    hasBaseline: boolean
    diffPercentage?: number
    identical?: boolean
    error?: string
  }>
  clearChatBaseline(): void

  sendMessage(text: string, options?: ReplySendOptions): Promise<boolean>
  verifySend(text: string, options?: ReplySendOptions): Promise<SendVerificationResult>
  activeUnreadByClick(coordinates: [number, number]): Promise<void>
  clickUnreadContact(coordinates: [number, number]): Promise<void>
  clickAt(x: number, y: number): Promise<void>
}
