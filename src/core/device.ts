// src/core/device.ts
// Business Atomic Device — 业务原子驱动层
//
// 当前主路径里，这个接口由 ChannelSession 依赖，用于统一访问宿主应用的感知与动作能力。
// 旧的 hook-based 编排已移除，宿主编排只保留 Runtime / Channel / Provider 这条主线。
//
// 实现：
// - `RPADevice`         — 经典 VLM 感知路线（wechat / wework）。
// - `BoxSelectDevice`   — 用户手动框选 4 个区域的通用 IM 路线（钉钉 / 飞书 / Slack / Telegram / generic）。
//   两种实现共享同一接口，由 `GenericChannelSession` 调用，主进程根据 capture strategy 选择实例化哪个。

import { AppType } from './rpa/types'
import { BBox } from './rpa/vision-utils'

export interface DesktopDevice {
  // ── 配置 ──
  setAppType(appType: AppType): void
  setApiKey(apiKey: string): void

  // ── 生命周期 ──
  // session 启停时由 GenericChannelSession 调用，给设备机会做缓存初始化 / 清理。
  // 默认实现可为 no-op；RPADevice 在 onSessionStop 里清掉 layoutCache，BoxSelectDevice 用作 baseline reset。
  onSessionStart?(): Promise<void> | void
  onSessionStop?(): Promise<void> | void

  // ── 感知层 ──

  /**
   * 启动时一次性布局测量。
   * - RPADevice: VLM 定位 chatEntrance / firstContact / inputArea 并缓存。
   * - BoxSelectDevice: 校验已保存的用户框选区域是否有效；缺失则返回 success: false，
   *   主进程会拉起框选向导补齐。
   */
  measureLayout(): Promise<{ success: boolean; error?: string }>

  /** 全窗口截图 → base64 */
  screenshot(): Promise<string>

  /**
   * Step 1 粗检测：聊天入口是否有红点？
   * 内部流程: 定位 chatEntranceArea / contactList → 局部 crop → 红点像素扫描。
   * BoxSelectDevice 在 unreadIndicator 为空时会回退到 chatMain pixel-diff 信号。
   */
  hasUnreadMessage(): Promise<{
    hasUnread: boolean
    chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  }>

  /**
   * Step 2 细检测：第一个联系人头像是否有红点？
   * 内部流程: 定位 firstContact → 局部 crop → 红点扫描 + 边缘分析 + 自适应重试
   */
  isChatContactUnread(): Promise<{
    isUnread: boolean
    firstContactCoords?: [number, number]
  }>

  /**
   * 清除未读区域的坐标缓存（chatEntranceArea + firstContact）。
   * RPADevice: 清 VLM 缓存强制重新检测。
   * BoxSelectDevice: 通常 no-op。
   */
  clearUnreadCache(): void

  // ── chatMainArea Diff 检测 ──

  /**
   * 保存当前 chatMainArea 截图作为 diff baseline
   * 在 channel 消费完 reply / skip 后调用
   */
  setChatBaseline(): Promise<boolean>

  /**
   * 检查 chatMainArea 是否有变化（和 baseline 对比）
   * 发现变化说明当前对话有新消息进来
   */
  hasChatAreaChanged(): Promise<{ hasDiff: boolean; hasBaseline: boolean }>

  /**
   * 清除 diff baseline
   */
  clearChatBaseline(): void

  // ── 动作层 ──

  /** 发送消息（clipboard paste + enter） */
  sendMessage(text: string): Promise<void>

  /**
   * 点击红点区域激活未读消息（视觉路线）
   * 微信场景双击，其他场景单击（具体由设备根据 appType 决定）
   */
  activeUnreadByClick(coordinates: [number, number]): Promise<void>

  /**
   * 点击联系人列表中的第一个联系人
   */
  clickUnreadContact(coordinates: [number, number]): Promise<void>

  /** 点击指定坐标 */
  clickAt(x: number, y: number): Promise<void>
}
