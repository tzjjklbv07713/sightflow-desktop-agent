import { AppType } from './rpa/types'
import { ReplyOutputConfig, ReplySendOptions } from './rpa/input-utils'
import { LatestMessageInspection } from './rpa/latest-message-inspector'
import { BBox } from './rpa/vision-utils'
import { AutomationSafetyResult } from './automation-safety'
import { ObservedChatMessage } from './chat/message-types'

export interface DesktopDevice {
  setAppType(appType: AppType): void
  setApiKey(apiKey: string, model?: string, baseURL?: string): void
  setReplyOutputConfig?(config: ReplyOutputConfig): void

  onSessionStart?(): Promise<void> | void
  onSessionStop?(): Promise<void> | void

  measureLayout(): Promise<{ success: boolean; error?: string }>
  checkAutomationSafety?(): Promise<AutomationSafetyResult>
  screenshot(): Promise<string>
  inspectLatestMessage(screenshot?: string): Promise<LatestMessageInspection>
  inspectLatestObserved?(options?: { chatName?: string; chatType?: 'direct' | 'group' | 'service' | 'official' | 'unknown' }): Promise<ObservedChatMessage | null>

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
  activeUnreadByClick(coordinates: [number, number]): Promise<void>
  clickUnreadContact(coordinates: [number, number]): Promise<void>
  clickAt(x: number, y: number): Promise<void>
}
