import { DesktopDevice } from './device'
import { type VisionDetectionClient, VisionModelClient } from './vision-client'
import {
  activeUnreadByClickAction,
  clickUnreadContactAction,
  ReplyOutputConfig,
  ReplySendOptions,
  sendReplyAction,
  setReplyOutputConfig
} from './rpa/input-utils'
import { AppType } from './rpa/types'
import {
  BBox,
  clearLayoutCache,
  getInputAreaFromCache,
  getLayoutCache,
  setLayoutCache
} from './rpa/vision-utils'
import { captureChatMainArea, dataUrlToNativeImage } from './rpa/screenshot-utils'
import { detectWechatLayout } from './rpa/layout-detection'
import { detectUnreadArea as detectUnreadAreaFn } from './rpa/unread-detection'
import {
  hasUnreadMessage as hasUnreadMessageDetect,
  isChatContactUnread as isChatContactUnreadDetect
} from './rpa/has-unread'
import {
  checkChatAreaDiff,
  clearChatBaseline as clearChatBaselineFn,
  setChatBaseline as setChatBaselineFn
} from './rpa/image-compare'
import {
  inspectLatestMessageFromScreenshot,
  LatestMessageInspection
} from './rpa/latest-message-inspector'
import { getWechatWindowInfo } from './rpa/window-utils'
import {
  AutomationSafetyResult,
  parseVisionSafetyResult,
  SAFE_AUTOMATION_RESULT
} from './automation-safety'
import { probeHybridPerception } from './perception/hybrid-perception'
import { tryInspectViaUia } from './uiautomation/inspect-helper'
import { extractChatMessages } from './uiautomation/chat-messages'
import { observedFromUia } from './uiautomation/observed-from-uia'
import type { ObservedChatMessage } from './chat/message-types'

type MeasureResult = { success: boolean; error?: string }

const AUTOMATION_SAFETY_PROMPT = `请判断这张微信聊天软件窗口截图是否可以安全执行自动回复操作。
只输出 JSON，不要解释。格式：
{"safe":true}
或者
{"safe":false,"reason":"login_required|risk_or_abnormal_prompt|input_unavailable","message":"简要原因"}

判定 safe=false 的情况：
1. 看到登录二维码、扫码登录、重新登录、登录失败页面。
2. 看到账号异常、风险提示、风控、安全验证、冻结、限制登录、需要验证身份等弹窗或页面。
3. 看不到正常聊天输入框，或当前界面明显不是聊天会话窗口。
如果是正常聊天窗口且可以输入回复，输出 {"safe":true}。`

export class RPADevice implements DesktopDevice {
  private appType: AppType = 'wechat'
  private visionClient: VisionDetectionClient | null = null

  setAppType(appType: AppType): void {
    this.appType = appType
  }

  setApiKey(apiKey: string, model?: string, baseURL?: string): void {
    if (!apiKey) return
    this.visionClient = new VisionModelClient({ apiKey, model, baseURL })
  }

  setReplyOutputConfig(config: ReplyOutputConfig): void {
    setReplyOutputConfig(config)
  }

  onSessionStop(): void {
    clearLayoutCache(this.appType)
  }

  async measureLayout(): Promise<MeasureResult> {
    if (!this.visionClient) {
      return { success: false, error: '视觉模型客户端未初始化' }
    }

    try {
      const windowInfo = await getWechatWindowInfo(this.appType)
      if (!windowInfo) {
        return {
          success: false,
          error: `未找到 ${this.appName()} 窗口，请确保应用已打开且未最小化`
        }
      }

      console.log('[RPADevice] 开始并行测量布局...')
      const [unreadResult, layoutResult] = await Promise.allSettled([
        detectUnreadAreaFn(this.visionClient, this.appType),
        detectWechatLayout(this.visionClient, this.appType)
      ])

      const unreadOk = unreadResult.status === 'fulfilled' && unreadResult.value.success
      const layoutOk = layoutResult.status === 'fulfilled' && layoutResult.value.success
      console.log('[RPADevice] VLM 检测结果', {
        detectUnreadArea: unreadOk ? 'ok' : 'failed',
        detectWechatLayout: layoutOk ? 'ok' : 'failed'
      })

      if (unreadResult.status === 'fulfilled' && unreadResult.value.success) {
        console.log('[RPADevice] 未读区域', {
          chatEntrance: unreadResult.value.chatEntranceArea?.coordinates,
          firstContact: unreadResult.value.firstContact?.coordinates
        })
      } else {
        console.warn('[RPADevice] 未读区域检测失败', settledError(unreadResult))
      }

      if (layoutResult.status === 'fulfilled' && layoutResult.value.success) {
        console.log('[RPADevice] 主布局', {
          searchInputBox: layoutResult.value.searchInputBox?.coordinates,
          headerArea: layoutResult.value.headerArea?.coordinates,
          chatMainArea: layoutResult.value.chatMainArea?.coordinates
        })

        const inputArea = getInputAreaFromCache(this.appType)
        if (inputArea) {
          console.log('[RPADevice] 输入框区域', inputArea.coordinates)
        } else {
          console.warn('[RPADevice] 输入框区域反推失败')
        }
      } else {
        console.warn('[RPADevice] 主布局检测失败', settledError(layoutResult))
      }

      if (!layoutOk || layoutResult.status !== 'fulfilled') {
        return { success: false, error: `布局测量失败: ${settledError(layoutResult)}` }
      }

      const inputArea = getInputAreaFromCache(this.appType)
      if (!layoutResult.value.chatMainArea || !inputArea) {
        return { success: false, error: '布局测量失败: 缺少聊天区或输入框位置' }
      }

      console.log('[RPADevice] 布局测量完成')
      return { success: true }
    } catch (error) {
      console.error('[RPADevice] 布局测量异常:', error)
      return { success: false, error: formatUnknownError(error) }
    }
  }

  async screenshot(): Promise<string> {
    const image = await captureChatMainArea(this.appType)
    if (!image) {
      throw new Error('聊天区截图失败')
    }
    return image.toDataURL()
  }

  async inspectLatestMessage(screenshot?: string): Promise<LatestMessageInspection> {
    if (process.platform === 'win32') {
      try {
        const uiaInspection = await tryInspectViaUia(this.appType)
        if (uiaInspection && uiaInspection.detected) {
          return uiaInspection
        }
      } catch (error) {
        console.warn('[RPADevice] UIA 最新消息识别失败，回退到视觉识别:', error)
      }
    }

    try {
      const screenshotBase64 = screenshot || (await this.screenshot())
      return await inspectLatestMessageFromScreenshot(screenshotBase64, this.appType)
    } catch (error) {
      return {
        detected: false,
        latestFromSelf: false,
        confidence: 0,
        error: formatUnknownError(error)
      }
    }
  }

  /**
   * Preferred perception entry point. Returns a structured
   * `ObservedChatMessage` when UIA succeeds, or null when callers should
   * fall back to the vision-based `inspectLatestMessage`. The chat name
   * and type can be supplied by the session so chat-scoped policies
   * (autoSendScope, blocked chat keyword, daily limit) see the right
   * scope even before a provider returns richer metadata.
   */
  async inspectLatestObserved(options?: {
    chatName?: string
    chatType?: 'direct' | 'group' | 'service' | 'official' | 'unknown'
  }): Promise<ObservedChatMessage | null> {
    if (process.platform !== 'win32') return null
    try {
      const snapshot = await extractChatMessages(this.appType)
      if (!snapshot.ok) return null
      return observedFromUia(this.appType, snapshot, {
        chatName: options?.chatName,
        chatType: options?.chatType
      })
    } catch (error) {
      console.warn('[RPADevice] UIA structured observation failed:', error)
      return null
    }
  }

  async checkAutomationSafety(): Promise<AutomationSafetyResult> {
    const inputArea = getInputAreaFromCache(this.appType)
    if (!inputArea) {
      return {
        safe: false,
        reason: 'input_unavailable',
        message: '未找到可用输入框位置'
      }
    }

    const perception = await probeHybridPerception(this.appType, { includeScreenshot: true })
    console.log('[RPADevice] 混合感知能力', {
      source: perception.source,
      windowFound: perception.capabilities.windowFound,
      windowUsable: perception.capabilities.windowUsable,
      textReadable: perception.capabilities.textReadable,
      inputDetectable: perception.capabilities.inputDetectable,
      visionRequired: perception.capabilities.visionRequired,
      title: perception.title,
      processName: perception.processName,
      reason: perception.reason
    })

    if (!perception.capabilities.windowFound) {
      return {
        safe: false,
        reason: 'window_missing',
        message: perception.message || '目标窗口丢失或无法定位'
      }
    }

    if (!perception.capabilities.windowUsable) {
      return {
        safe: false,
        reason: 'window_missing',
        message: '目标窗口已定位，但无法获取可用窗口边界'
      }
    }

    if (!perception.screenshot) {
      return {
        safe: false,
        reason: 'window_missing',
        message: '目标窗口已定位，但无法截图完成安全检查'
      }
    }

    if (!this.visionClient) return SAFE_AUTOMATION_RESULT

    try {
      const raw = await this.visionClient.detectVision(
        AUTOMATION_SAFETY_PROMPT,
        perception.screenshot,
        8000
      )
      return parseVisionSafetyResult(raw)
    } catch (error: unknown) {
      return {
        safe: false,
        reason: 'safety_check_failed',
        message: formatUnknownError(error)
      }
    }
  }

  async hasUnreadMessage(): Promise<{
    hasUnread: boolean
    percentage?: number
    error?: string
    chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  }> {
    if (!this.visionClient) {
      return { hasUnread: false, error: '视觉模型客户端未初始化' }
    }

    const result = await hasUnreadMessageDetect(this.visionClient, this.appType)
    if (!result.success) {
      console.error('[RPADevice] hasUnreadMessage 失败:', result.error)
      return { hasUnread: false, error: result.error }
    }

    return {
      hasUnread: result.hasUnread || false,
      percentage: result.percentage,
      chatEntranceArea: result.chatEntranceArea
    }
  }

  async isChatContactUnread(): Promise<{
    isUnread: boolean
    percentage?: number
    error?: string
    firstContactCoords?: [number, number]
  }> {
    if (!this.visionClient) {
      return { isUnread: false, error: '视觉模型客户端未初始化' }
    }

    const result = await isChatContactUnreadDetect(this.visionClient, this.appType)
    if (!result.success) {
      console.error('[RPADevice] isChatContactUnread 失败:', result.error)
      return { isUnread: false, error: result.error }
    }

    return {
      isUnread: result.isUnread || false,
      percentage: result.percentage,
      firstContactCoords: result.firstContact?.coordinates
    }
  }

  clearUnreadCache(): void {
    const cache = getLayoutCache(this.appType)
    if (!cache) return

    cache.chatEntranceArea = null
    cache.firstContact = null
    setLayoutCache(this.appType, cache)
    console.log('[RPADevice] 已清除未读区域缓存')
  }

  async setChatBaseline(screenshot?: string): Promise<boolean> {
    if (screenshot) {
      const image = dataUrlToNativeImage(screenshot)
      if (image) {
        return setChatBaselineFn(this.appType, image)
      }
    }
    return setChatBaselineFn(this.appType)
  }

  async hasChatAreaChanged(screenshot?: string): Promise<{
    hasDiff: boolean
    hasBaseline: boolean
    diffPercentage?: number
    identical?: boolean
    error?: string
  }> {
    if (screenshot) {
      const image = dataUrlToNativeImage(screenshot)
      if (image) {
        return checkChatAreaDiff(this.appType, image)
      }
    }
    return checkChatAreaDiff(this.appType)
  }

  clearChatBaseline(): void {
    clearChatBaselineFn()
  }

  async sendMessage(text: string, options?: ReplySendOptions): Promise<boolean> {
    const success = await sendReplyAction(this.appType, text, options)
    if (!success) {
      throw new Error('发送消息失败')
    }
    return true
  }

  async activeUnreadByClick(coordinates: [number, number]): Promise<void> {
    await activeUnreadByClickAction(coordinates, this.appType)
  }

  async clickUnreadContact(coordinates: [number, number]): Promise<void> {
    await clickUnreadContactAction(coordinates)
  }

  async clickAt(x: number, y: number): Promise<void> {
    await clickUnreadContactAction([x, y])
  }

  private appName(): string {
    if (this.appType === 'wechat') return '微信'
    if (this.appType === 'wework') return '企业微信'
    return this.appType
  }
}

function settledError<T extends { error?: string }>(result: PromiseSettledResult<T>): string {
  if (result.status === 'rejected') return formatUnknownError(result.reason)
  return result.value.error || 'unknown error'
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}