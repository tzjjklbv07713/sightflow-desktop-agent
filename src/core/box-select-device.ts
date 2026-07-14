import { DesktopDevice } from './device'
import { AppType, BoxRegions, ScreenRect, isWechatLike } from './rpa/types'
import { ReplyOutputConfig, ReplySendOptions } from './rpa/input-utils'
import {
  BBox,
  clearLayoutCache,
  getInputAreaFromCache,
  LayoutCache,
  setLayoutCache
} from './rpa/vision-utils'
import { captureChatMainArea, dataUrlToNativeImage } from './rpa/screenshot-utils'
import {
  inspectLatestMessageFromScreenshot,
  LatestMessageInspection
} from './rpa/latest-message-inspector'
import {
  activeUnreadByClickAction,
  clickUnreadContactAction,
  defaultClickPolicy,
  setReplyOutputConfig,
  sendReplyByCoordsAction
} from './rpa/input-utils'
import { comparePngBuffers } from './rpa/image-compare'
import { AutomationSafetyResult, SAFE_AUTOMATION_RESULT } from './automation-safety'
import { probeHybridPerception } from './perception/hybrid-perception'

function rectCenter(rect: ScreenRect): [number, number] {
  return [rect.x + rect.width / 2, rect.y + rect.height / 2]
}

export class BoxSelectDevice implements DesktopDevice {
  private appType: AppType = 'generic'
  private regions: BoxRegions | null
  private chatBaseline: Buffer | null = null

  constructor(regions: BoxRegions | null = null) {
    this.regions = regions
  }

  setAppType(appType: AppType): void {
    this.appType = appType
  }

  setApiKey(apiKey: string, model?: string, baseURL?: string): void {
    void apiKey
    void model
    void baseURL
  }

  setReplyOutputConfig(config: ReplyOutputConfig): void {
    setReplyOutputConfig(config)
  }

  setRegions(regions: BoxRegions | null): void {
    this.regions = regions
  }

  getRegions(): BoxRegions | null {
    return this.regions
  }

  onSessionStop(): void {
    clearLayoutCache(this.appType)
    this.chatBaseline = null
  }

  async measureLayout(): Promise<{ success: boolean; error?: string }> {
    if (!this.regions) {
      return { success: false, error: '尚未保存框选区域，请先完成框选向导' }
    }

    const required: Array<[string, ScreenRect | null | undefined]> = [
      ['contactList', this.regions.contactList],
      ['chatMain', this.regions.chatMain],
      ['inputBox', this.regions.inputBox]
    ]
    for (const [name, rect] of required) {
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return { success: false, error: `框选区域 ${name} 无效，请重新框选` }
      }
    }

    const chatMainCenter = rectCenter(this.regions.chatMain)
    const inputBoxCenter = rectCenter(this.regions.inputBox)
    const layout: LayoutCache = {
      chatEntranceArea: null,
      firstContact: null,
      searchInputBox: null,
      headerArea: null,
      chatMainArea: {
        rect: this.regions.chatMain,
        coordinates: chatMainCenter,
        source: 'box-select'
      },
      messageInputArea: {
        rect: this.regions.inputBox,
        coordinates: inputBoxCenter,
        source: 'box-select'
      },
      timestamp: Date.now(),
      appType: this.appType
    }
    setLayoutCache(this.appType, layout)
    return { success: true }
  }

  async screenshot(): Promise<string> {
    const image = await captureChatMainArea(this.appType)
    if (!image) {
      throw new Error('chatMain 截图失败')
    }
    return image.toDataURL()
  }

  async inspectLatestMessage(screenshot?: string): Promise<LatestMessageInspection> {
    try {
      const screenshotBase64 = screenshot || (await this.screenshot())
      return await inspectLatestMessageFromScreenshot(screenshotBase64, this.appType)
    } catch (error: unknown) {
      return {
        detected: false,
        latestFromSelf: false,
        confidence: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async checkAutomationSafety(): Promise<AutomationSafetyResult> {
    const inputArea = getInputAreaFromCache(this.appType)
    if (!inputArea) {
      return {
        safe: false,
        reason: 'input_unavailable',
        message: '尚未测量输入框区域'
      }
    }

    if (!isWechatLike(this.appType)) return SAFE_AUTOMATION_RESULT

    const perception = await probeHybridPerception(this.appType, { includeScreenshot: false })
    console.log('[BoxSelectDevice] 混合感知能力', {
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

    if (!perception.capabilities.windowFound || !perception.capabilities.windowUsable) {
      return {
        safe: false,
        reason: 'window_missing',
        message: perception.message || '目标窗口丢失、最小化，或无法获取窗口边界'
      }
    }

    return SAFE_AUTOMATION_RESULT
  }

  async hasUnreadMessage(): Promise<{
    hasUnread: boolean
    chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  }> {
    return { hasUnread: false }
  }

  async isChatContactUnread(): Promise<{
    isUnread: boolean
    firstContactCoords?: [number, number]
  }> {
    return { isUnread: false }
  }

  clearUnreadCache(): void {
    // intentionally empty
  }

  async setChatBaseline(screenshot?: string): Promise<boolean> {
    const image = screenshot ? dataUrlToNativeImage(screenshot) : await captureChatMainArea(this.appType)
    if (!image) {
      console.warn('[BoxSelectDevice] baseline 设置失败: chatMain 截图为空')
      return false
    }
    this.chatBaseline = image.toPNG()
    return true
  }

  async hasChatAreaChanged(screenshot?: string): Promise<{
    hasDiff: boolean
    hasBaseline: boolean
    diffPercentage?: number
    identical?: boolean
    error?: string
  }> {
    if (!this.chatBaseline) return { hasDiff: false, hasBaseline: false }

    const image = screenshot ? dataUrlToNativeImage(screenshot) : await captureChatMainArea(this.appType)
    if (!image) {
      return { hasDiff: false, hasBaseline: true, error: '截图失败' }
    }
    const current = image.toPNG()
    const cmp = comparePngBuffers(this.chatBaseline, current, {
      threshold: 0.1,
      changeThreshold: 0.15
    })
    return {
      hasDiff: cmp.hasChanged && !cmp.identical,
      hasBaseline: true,
      diffPercentage: cmp.diffPercentage,
      identical: cmp.identical
    }
  }

  clearChatBaseline(): void {
    this.chatBaseline = null
  }

  async sendMessage(text: string, options?: ReplySendOptions): Promise<boolean> {
    const inputArea = getInputAreaFromCache(this.appType)
    if (!inputArea) throw new Error('尚未测量输入框区域')
    const [x, y] = inputArea.coordinates
    const ok = await sendReplyByCoordsAction(x, y, text, undefined, options)
    if (!ok) throw new Error('发送消息失败')
    return true
  }

  async activeUnreadByClick(coordinates: [number, number]): Promise<void> {
    await activeUnreadByClickAction(coordinates, this.appType, defaultClickPolicy(this.appType))
  }

  async clickUnreadContact(coordinates: [number, number]): Promise<void> {
    await clickUnreadContactAction(coordinates)
  }

  async clickAt(x: number, y: number): Promise<void> {
    await clickUnreadContactAction([x, y])
  }
}
