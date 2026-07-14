import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelObservation,
  SendVerificationResult
} from './channel-adapter'
import type { DesktopDevice } from './device'
import type { ReplyOutputConfig, ReplySendOptions } from './rpa/input-utils'
import type { AppType } from './rpa/types'

abstract class BaseDesktopChannelAdapter implements ChannelAdapter {
  abstract readonly kind: 'official-api' | 'native-pc' | 'rpa-fallback'

  constructor(protected readonly device: DesktopDevice) {}

  setAppType(appType: AppType): void {
    this.device.setAppType(appType)
  }

  setApiKey(apiKey: string, model?: string, baseURL?: string): void {
    this.device.setApiKey(apiKey, model, baseURL)
  }

  setReplyOutputConfig(config: ReplyOutputConfig): void {
    this.device.setReplyOutputConfig?.(config)
  }

  onSessionStart(): Promise<void> | void {
    return this.device.onSessionStart?.()
  }

  onSessionStop(): Promise<void> | void {
    return this.device.onSessionStop?.()
  }

  async healthCheck(): Promise<ChannelHealth> {
    try {
      const screenshot = await this.device.screenshot()
      return screenshot
        ? { ok: true }
        : { ok: false, reason: 'screenshot_unavailable', details: 'empty screenshot payload' }
    } catch (error: unknown) {
      return {
        ok: false,
        reason: 'screenshot_failed',
        details: error instanceof Error ? error.message : String(error)
      }
    }
  }

  measureLayout(): Promise<{ success: boolean; error?: string }> {
    return this.device.measureLayout()
  }

  async checkAutomationSafety() {
    if (!this.device.checkAutomationSafety) {
      return { safe: true }
    }
    return this.device.checkAutomationSafety()
  }

  screenshot(): Promise<string> {
    return this.device.screenshot()
  }

  inspectLatestMessage(screenshot?: string) {
    return this.device.inspectLatestMessage(screenshot)
  }

  inspectLatestObserved(options?: {
    chatName?: string
    chatType?: 'direct' | 'group' | 'service' | 'official' | 'unknown'
  }) {
    return this.device.inspectLatestObserved?.(options) || Promise.resolve(null)
  }

  hasUnreadMessage() {
    return this.device.hasUnreadMessage()
  }

  isChatContactUnread() {
    return this.device.isChatContactUnread()
  }

  clearUnreadCache(): void {
    this.device.clearUnreadCache()
  }

  setChatBaseline(screenshot?: string) {
    return this.device.setChatBaseline(screenshot)
  }

  hasChatAreaChanged(screenshot?: string) {
    return this.device.hasChatAreaChanged(screenshot)
  }

  clearChatBaseline(): void {
    this.device.clearChatBaseline()
  }

  sendMessage(text: string, options?: ReplySendOptions): Promise<boolean> {
    return this.device.sendMessage(text, options)
  }

  async verifySend(_text: string, options?: ReplySendOptions): Promise<SendVerificationResult> {
    try {
      const screenshot = await this.device.screenshot()
      const diff = await this.device.hasChatAreaChanged(screenshot)
      if (!diff.hasBaseline) {
        return {
          ok: true,
          mode: options?.submit === false ? 'drafted' : 'sent',
          reason: 'missing_baseline'
        }
      }
      if (diff.hasDiff) {
        return {
          ok: true,
          mode: options?.submit === false ? 'drafted' : 'sent',
          reason: 'verified',
          evidence: {
            diffPercentage: diff.diffPercentage,
            screenshot
          }
        }
      }
      return {
        ok: false,
        mode: options?.submit === false ? 'drafted' : 'sent',
        reason: 'no_visual_change',
        details: diff.error,
        evidence: {
          diffPercentage: diff.diffPercentage,
          screenshot
        }
      }
    } catch (error: unknown) {
      return {
        ok: false,
        mode: options?.submit === false ? 'drafted' : 'sent',
        reason: 'verify_failed',
        details: error instanceof Error ? error.message : String(error)
      }
    }
  }

  activeUnreadByClick(coordinates: [number, number]): Promise<void> {
    return this.device.activeUnreadByClick(coordinates)
  }

  clickUnreadContact(coordinates: [number, number]): Promise<void> {
    return this.device.clickUnreadContact(coordinates)
  }

  clickAt(x: number, y: number): Promise<void> {
    return this.device.clickAt(x, y)
  }

  abstract observe(options?: {
    screenshot?: string
    chatName?: string
    chatType?: 'direct' | 'group' | 'service' | 'official' | 'unknown'
  }): Promise<ChannelObservation>
}

export class NativePcChannelAdapter extends BaseDesktopChannelAdapter {
  readonly kind = 'native-pc' as const

  async observe(options?: {
    screenshot?: string
    chatName?: string
    chatType?: 'direct' | 'group' | 'service' | 'official' | 'unknown'
  }): Promise<ChannelObservation> {
    const screenshot = options?.screenshot || (await this.device.screenshot())
    const stages: ChannelObservation['stages'] = []

    const observedMessage =
      (await this.device.inspectLatestObserved?.({
        chatName: options?.chatName,
        chatType: options?.chatType
      })) || null

    stages.push({
      stage: 'accessibility',
      hit: Boolean(observedMessage),
      reason: observedMessage ? 'uia_observed_message' : 'no_uia_message',
      confidence: observedMessage?.confidence
    })

    if (observedMessage) {
      return {
        latestMessage: await this.device.inspectLatestMessage(screenshot),
        observedMessage,
        screenshot,
        source: 'accessibility',
        stages
      }
    }

    stages.push(
      {
        stage: 'native-structure',
        hit: false,
        reason: 'native_structure_not_configured'
      },
      {
        stage: 'ocr',
        hit: false,
        reason: 'ocr_not_configured'
      }
    )

    const latestMessage = await this.device.inspectLatestMessage(screenshot)
    stages.push({
      stage: 'vision',
      hit: latestMessage.detected,
      reason: latestMessage.reason || latestMessage.error || 'vision_latest_message',
      confidence: latestMessage.confidence
    })
    return {
      latestMessage,
      observedMessage: null,
      screenshot,
      source: 'vision',
      stages
    }
  }
}

export class RpaFallbackChannelAdapter extends BaseDesktopChannelAdapter {
  readonly kind = 'rpa-fallback' as const

  async observe(options?: {
    screenshot?: string
    chatName?: string
    chatType?: 'direct' | 'group' | 'service' | 'official' | 'unknown'
  }): Promise<ChannelObservation> {
    void options
    const screenshot = (options && options.screenshot) || (await this.device.screenshot())
    const latestMessage = await this.device.inspectLatestMessage(screenshot)
    return {
      latestMessage,
      observedMessage: null,
      screenshot,
      source: 'vision',
      stages: [
        {
          stage: 'accessibility',
          hit: false,
          reason: 'rpa_fallback_has_no_structured_observer'
        },
        {
          stage: 'native-structure',
          hit: false,
          reason: 'rpa_fallback_has_no_native_structure'
        },
        {
          stage: 'ocr',
          hit: false,
          reason: 'ocr_not_configured'
        },
        {
          stage: 'vision',
          hit: latestMessage.detected,
          reason: latestMessage.reason || latestMessage.error || 'vision_latest_message',
          confidence: latestMessage.confidence
        }
      ]
    }
  }
}

export function createDesktopChannelAdapter(
  device: DesktopDevice,
  kind: 'native-pc' | 'rpa-fallback'
): ChannelAdapter {
  return kind === 'native-pc'
    ? new NativePcChannelAdapter(device)
    : new RpaFallbackChannelAdapter(device)
}
