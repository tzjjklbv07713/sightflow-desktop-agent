// src/core/box-select-device.ts
// BoxSelectDevice — DesktopDevice 的"用户手动框选 4 个区域"实现。
//
// 与 RPADevice 的关系：两者都实现同一 DesktopDevice 接口、由 GenericChannelSession 统一驱动。
// 区别在于"如何知道 chatEntrance / firstContact / inputBox / chatMain 在屏幕上哪里"：
//   - RPADevice  : 用 VLM 在线推理 wechat / wework 的布局，自动落到 LayoutCache。
//   - BoxSelectDevice: 用户在主进程的"框选向导"里手动画 4 个矩形，存到 settings，
//     这里直接读出来用。适用于钉钉 / 飞书 / Slack / Telegram 等非 wechat 场景，
//     以及 wechat VLM 检测失败时的兜底策略。
//
// 坐标系统一约定：BoxRegions 里的矩形都是逻辑像素的绝对屏幕坐标，与 captureScreenRegion、
// humanLikeMove、screen.getDisplayMatching 一致；裁剪到物理像素的换算由 captureScreenRegion 内部处理。

import { DesktopDevice } from './device'
import { AppType, BoxRegions, ScreenRect } from './rpa/types'
import { BBox } from './rpa/vision-utils'
import { calculateRedDotPercentage, captureScreenRegion } from './rpa/screenshot-utils'
import { comparePngBuffers } from './rpa/image-compare'
import {
  activeUnreadByClickAction,
  clickUnreadContactAction,
  defaultClickPolicy,
  sendReplyByCoordsAction
} from './rpa/input-utils'

// 红点检测阈值（百分比）。低阈值 1% 用于联系人列表整体的粗检测；高阈值 4% 用于精确锁定首联系人。
const UNREAD_COARSE_THRESHOLD = 1
const UNREAD_FINE_THRESHOLD = 4

// 默认用 contactList 顶部一条带作为"首联系人"扫描区域。
// 取 contactList 高度的 12%（最小 56 px、最大 120 px）作为顶部带，逻辑上对齐
// RPADevice 的"firstContact 一般在联系人列表第一行"约定。
const FIRST_CONTACT_BAND_RATIO = 0.12
const FIRST_CONTACT_BAND_MIN = 56
const FIRST_CONTACT_BAND_MAX = 120

function rectCenter(rect: ScreenRect): [number, number] {
  return [rect.x + rect.width / 2, rect.y + rect.height / 2]
}

// 把 ScreenRect 包装成 DesktopDevice 接口要求的 { bbox, coordinates } 形状。
// bbox 用占位值 [0, 0, 1000, 1000] —— BoxSelectDevice 走的是绝对屏幕坐标，
// 上层只读 coordinates，bbox 仅是接口签名兼容。
function rectToHitBox(rect: ScreenRect): { bbox: BBox; coordinates: [number, number] } {
  return { bbox: [0, 0, 1000, 1000], coordinates: rectCenter(rect) }
}

// 取 contactList 顶部一条窄带，用作首联系人扫描区。
function firstContactBand(contactList: ScreenRect): ScreenRect {
  const ratioHeight = Math.round(contactList.height * FIRST_CONTACT_BAND_RATIO)
  const bandHeight = Math.max(FIRST_CONTACT_BAND_MIN, Math.min(FIRST_CONTACT_BAND_MAX, ratioHeight))
  return {
    x: contactList.x,
    y: contactList.y,
    width: contactList.width,
    height: Math.min(bandHeight, contactList.height)
  }
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

  // BoxSelectDevice 不需要视觉密钥；保留 no-op 以满足接口（engine:updateConfig 会调）。
  setApiKey(apiKey: string): void {
    void apiKey
  }

  setRegions(regions: BoxRegions | null): void {
    this.regions = regions
  }

  getRegions(): BoxRegions | null {
    return this.regions
  }

  // ── 生命周期 ──
  // box-select 没有 wechat layoutCache 之类的全局缓存，唯一的 baseline 是聊天区像素截图。
  onSessionStop(): void {
    this.chatBaseline = null
  }

  // ── 感知层 ──

  async measureLayout(): Promise<{ success: boolean; error?: string }> {
    if (!this.regions) {
      return { success: false, error: '尚未保存框选区域，请先完成框选向导' }
    }

    // 校验四个必选矩形非零；unreadIndicator 允许为 null（hasUnreadMessage 会回退到 chatMain diff）。
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
    return { success: true }
  }

  // 把 chatMain 区域截图作为"会话上下文"返回给 provider VLM 分析。
  // 比起 RPADevice 整窗截图，这里更聚焦于聊天内容，省 token 且与目标 app 无关。
  async screenshot(): Promise<string> {
    if (!this.regions) throw new Error('尚未保存框选区域')
    const result = await captureScreenRegion(this.regions.chatMain)
    if (!result.success || !result.screenshotBase64) {
      throw new Error(result.error || 'chatMain 截图失败')
    }
    return result.screenshotBase64
  }

  // 红点粗检测：对 unreadIndicator 区域做整图红像素占比扫描。
  // 当用户跳过了 unreadIndicator（如 Slack/Telegram 的非红色徽标），
  // 退化为"chatMain 像素差异 > 0 即视作未读"——配合 hasChatAreaChanged 串起来用。
  async hasUnreadMessage(): Promise<{
    hasUnread: boolean
    chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  }> {
    if (!this.regions) return { hasUnread: false }

    const probeRect = this.regions.unreadIndicator || this.regions.contactList
    const result = await captureScreenRegion(probeRect)
    if (!result.success || !result.screenshotBase64) {
      console.warn('[BoxSelectDevice] hasUnreadMessage 截图失败:', result.error)
      return { hasUnread: false }
    }

    if (!this.regions.unreadIndicator) {
      // 无红点区域 → 退化为"contactList 区域只要被截到就走联系人精检测"，
      // 让 GenericChannelSession 进入下一步 isChatContactUnread；
      // 真正的"是否有新对话"判定交给 chatMain diff 去做。
      return { hasUnread: true, chatEntranceArea: rectToHitBox(this.regions.contactList) }
    }

    const percentage = await calculateRedDotPercentage(result.screenshotBase64, false)
    const hasUnread = (percentage ?? 0) >= UNREAD_COARSE_THRESHOLD
    return {
      hasUnread,
      chatEntranceArea: hasUnread ? rectToHitBox(this.regions.unreadIndicator) : undefined
    }
  }

  // 联系人精检测：扫描 contactList 顶部一条带，回退也走它。
  async isChatContactUnread(): Promise<{
    isUnread: boolean
    firstContactCoords?: [number, number]
  }> {
    if (!this.regions) return { isUnread: false }

    const band = firstContactBand(this.regions.contactList)
    const result = await captureScreenRegion(band)
    if (!result.success || !result.screenshotBase64) {
      console.warn('[BoxSelectDevice] isChatContactUnread 截图失败:', result.error)
      return { isUnread: false }
    }

    if (!this.regions.unreadIndicator) {
      // 同 hasUnreadMessage 的退化路径：直接判定为有未读，让上层通过 diff 确认。
      return { isUnread: true, firstContactCoords: rectCenter(band) }
    }

    const percentage = await calculateRedDotPercentage(result.screenshotBase64, false)
    const isUnread = (percentage ?? 0) >= UNREAD_FINE_THRESHOLD
    return {
      isUnread,
      firstContactCoords: isUnread ? rectCenter(band) : undefined
    }
  }

  // box-select 没有 VLM 缓存可清；no-op。
  clearUnreadCache(): void {
    // intentionally empty
  }

  // ── chatMainArea Diff ──

  async setChatBaseline(): Promise<boolean> {
    if (!this.regions) return false
    const result = await captureScreenRegion(this.regions.chatMain)
    if (!result.success || !result.nativeImage) {
      console.warn('[BoxSelectDevice] baseline 设置失败:', result.error)
      return false
    }
    this.chatBaseline = result.nativeImage.toPNG()
    return true
  }

  async hasChatAreaChanged(): Promise<{ hasDiff: boolean; hasBaseline: boolean }> {
    if (!this.chatBaseline) return { hasDiff: false, hasBaseline: false }
    if (!this.regions) return { hasDiff: false, hasBaseline: true }

    const result = await captureScreenRegion(this.regions.chatMain)
    if (!result.success || !result.nativeImage) {
      return { hasDiff: false, hasBaseline: true }
    }
    const current = result.nativeImage.toPNG()
    const cmp = comparePngBuffers(this.chatBaseline, current, {
      threshold: 0.1,
      changeThreshold: 0.5
    })
    return { hasDiff: cmp.hasChanged && !cmp.identical, hasBaseline: true }
  }

  clearChatBaseline(): void {
    this.chatBaseline = null
  }

  // ── 动作层 ──

  async sendMessage(text: string): Promise<void> {
    if (!this.regions) throw new Error('尚未保存框选区域')
    const [x, y] = rectCenter(this.regions.inputBox)
    // 给中心点加一点点抖动，模拟人类
    const jitterX = x + (Math.random() - 0.5) * 6
    const jitterY = y + (Math.random() - 0.5) * 4
    const ok = await sendReplyByCoordsAction(jitterX, jitterY, text)
    if (!ok) throw new Error('发送消息失败')
  }

  // 通用 IM 一般单击就能切换会话，统一走 defaultClickPolicy(appType)，
  // wechat 双击的特例由 RPADevice 自己负责。
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
