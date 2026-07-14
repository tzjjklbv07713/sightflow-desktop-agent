import { desktopCapturer } from 'electron'
import { DesktopDevice } from './device'
import { LatestMessageInspection } from './rpa/latest-message-inspector'
import { BBox } from './rpa/vision-utils'

export class MockDevice implements DesktopDevice {
  setAppType(): void {
    // Mock 不依赖窗口类型。
  }

  setApiKey(): void {
    // Mock 不需要 API key。
  }

  async measureLayout(): Promise<{ success: boolean; error?: string }> {
    console.log('[MockDevice] 布局测量：模拟成功')
    return { success: true }
  }

  async screenshot(): Promise<string> {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })
    if (sources && sources.length > 0) {
      return sources[0].thumbnail.toDataURL()
    }
    throw new Error('No screen sources found')
  }

  async inspectLatestMessage(): Promise<LatestMessageInspection> {
    return {
      detected: false,
      latestFromSelf: false,
      confidence: 0,
      reason: 'mock'
    }
  }

  async hasUnreadMessage(): Promise<{
    hasUnread: boolean
    chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  }> {
    return { hasUnread: Math.random() > 0.85 }
  }

  async isChatContactUnread(): Promise<{
    isUnread: boolean
    firstContactCoords?: [number, number]
  }> {
    return { isUnread: true, firstContactCoords: [200, 200] }
  }

  clearUnreadCache(): void {
    console.log('[MockDevice] 清除未读缓存：模拟')
  }

  async setChatBaseline(): Promise<boolean> {
    console.log('[MockDevice] 设置聊天区基线：模拟')
    return true
  }

  async hasChatAreaChanged(): Promise<{ hasDiff: boolean; hasBaseline: boolean }> {
    return { hasDiff: Math.random() > 0.9, hasBaseline: true }
  }

  clearChatBaseline(): void {
    console.log('[MockDevice] 清除聊天区基线：模拟')
  }

  async sendMessage(text: string): Promise<boolean> {
    console.log(`[MockDevice] Sent: ${text}`)
    return true
  }

  async activeUnreadByClick(coordinates: [number, number]): Promise<void> {
    console.log(`[MockDevice] activeUnreadByClick: (${coordinates[0]}, ${coordinates[1]})`)
  }

  async clickUnreadContact(coordinates: [number, number]): Promise<void> {
    console.log(`[MockDevice] clickUnreadContact: (${coordinates[0]}, ${coordinates[1]})`)
  }

  async clickAt(x: number, y: number): Promise<void> {
    console.log(`[MockDevice] Click: (${x}, ${y})`)
  }
}
