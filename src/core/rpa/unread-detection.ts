import { type VisionDetectionClient } from '../vision-client'
import { AppType } from './types'
import { captureWechatWindow } from './screenshot-utils'
import { getWindowInfo } from './window-utils'
import {
  BBox,
  bboxToScreenCoords,
  getLayoutCache,
  setLayoutCache,
  LayoutCache,
  parseBBoxes
} from './vision-utils'

const UNREAD_AREA_TIMEOUT_MS = 12_000

function createFallbackUnreadArea(appType: AppType): {
  chatEntranceArea: BBox
  firstContact: BBox
} {
  if (appType === 'wework') {
    return {
      chatEntranceArea: [5, 58, 58, 102],
      firstContact: [68, 68, 125, 115]
    }
  }

  return {
    chatEntranceArea: [5, 58, 58, 102],
    firstContact: [68, 68, 125, 115]
  }
}

function buildFallbackUnreadResult(
  appType: AppType,
  bounds: { x: number; y: number; width: number; height: number },
  scaleFactor: number,
  error?: string
): {
  success: boolean
  chatEntranceArea: { bbox: BBox; coordinates: [number, number] }
  firstContact: { bbox: BBox; coordinates: [number, number] }
  error?: string
} {
  const fallbackUnreadArea = createFallbackUnreadArea(appType)
  const chatEntranceArea = {
    bbox: fallbackUnreadArea.chatEntranceArea,
    coordinates: bboxToScreenCoords(fallbackUnreadArea.chatEntranceArea, bounds, scaleFactor)
  }
  const firstContact = {
    bbox: fallbackUnreadArea.firstContact,
    coordinates: bboxToScreenCoords(fallbackUnreadArea.firstContact, bounds, scaleFactor)
  }

  const existingCache = getLayoutCache(appType)
  setLayoutCache(appType, {
    ...(existingCache || {
      searchInputBox: null,
      headerArea: null,
      chatMainArea: null,
      messageInputArea: null
    }),
    chatEntranceArea: { ...chatEntranceArea, source: 'derived' },
    firstContact: { ...firstContact, source: 'derived' },
    timestamp: Date.now(),
    appType
  } as LayoutCache)

  console.warn('[UnreadDetection] 使用默认未读区域兜底', {
    appType,
    error,
    chatEntranceArea: chatEntranceArea.coordinates,
    firstContact: firstContact.coordinates
  })

  return { success: true, chatEntranceArea, firstContact, error }
}

const UNREAD_AREA_PROMPTS: Record<'wechat' | 'wework', { prompt: string; targets: string[] }> = {
  wechat: {
    prompt: `你是一个微信布局解析专家。
## 微信桌面端布局
- 最左侧一列是导航栏，第二列是聊天联系人列表，顶部是搜索输入框
- 聊天入口按钮区域包含图标和可能的红色圆形数字角标
- 联系人列表第一行是最新消息联系人，头像右上角可能有红色未读气泡

## 你的职责
帮我框选以下两个区域，每个区域用 <bbox>x1,y1,x2,y2</bbox> 格式，坐标范围 0-1000：
1. 【聊天入口按钮区域】导航栏中的聊天按钮区域，包含图标和红色角标
2. 【聊天联系人列表第一行】第一联系人头像区域，包含头像和红色未读气泡`,
    targets: ['【聊天入口按钮区域】', '【聊天联系人列表第一行】']
  },
  wework: {
    prompt: `你是一个企业微信布局解析专家。
## 企业微信桌面端布局（三栏式）
- 左侧导航栏：顶部用户头像，功能菜单（消息/通讯录/邮件/日程/工作台），系统分区
- 中间消息列表：顶部搜索栏，下面是联系人消息列表，有未读红点
- 右侧聊天区
## 你的职责
帮我框选以下两个区域，每个区域用 <bbox>x1,y1,x2,y2</bbox> 格式，坐标范围 0-1000：
1. 【消息按钮区域】左侧导航栏中的消息按钮区域，包含按钮和红色角标
2. 【消息列表第一行】中间消息列表第一条消息项的头像区域`,
    targets: ['【消息按钮区域】', '【消息列表第一行】']
  }
}

export async function detectUnreadArea(
  aiClient: VisionDetectionClient,
  appType: AppType
): Promise<{
  success: boolean
  chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  firstContact?: { bbox: BBox; coordinates: [number, number] }
  error?: string
}> {
  try {
    const screenshotResult = await captureWechatWindow(appType)
    if (!screenshotResult.success || !screenshotResult.screenshotBase64) {
      return { success: false, error: screenshotResult.error || '截图失败' }
    }

    const windowInfo = await getWindowInfo(appType, false)
    if (!windowInfo?.bounds || !windowInfo?.scaleFactor) {
      return { success: false, error: '获取窗口信息失败' }
    }

    const promptKey = appType === 'wework' ? 'wework' : 'wechat'
    const config = UNREAD_AREA_PROMPTS[promptKey]

    console.log('[UnreadDetection] 调用 VLM 检测未读区域...')
    let vlmResult = ''
    try {
      vlmResult = await aiClient.detectVision(
        config.prompt,
        screenshotResult.screenshotBase64,
        UNREAD_AREA_TIMEOUT_MS
      )
    } catch (error: any) {
      return buildFallbackUnreadResult(
        appType,
        windowInfo.bounds,
        windowInfo.scaleFactor,
        error?.message || String(error)
      )
    }

    const bboxes = parseBBoxes(vlmResult)
    const fallbackUnreadArea = createFallbackUnreadArea(appType)
    const unreadBBoxes = {
      chatEntranceArea: bboxes[0] || fallbackUnreadArea.chatEntranceArea,
      firstContact: bboxes[1] || fallbackUnreadArea.firstContact
    }

    if (bboxes.length === 0) {
      console.warn('[UnreadDetection] 未返回 bbox，使用默认未读区域兜底', {
        appType,
        fallbackUnreadArea
      })
    }

    const { bounds, scaleFactor } = windowInfo
    const chatEntranceArea = {
      bbox: unreadBBoxes.chatEntranceArea,
      coordinates: bboxToScreenCoords(unreadBBoxes.chatEntranceArea, bounds, scaleFactor),
      source: bboxes[0] ? 'vlm' : 'derived'
    }
    const firstContact = {
      bbox: unreadBBoxes.firstContact,
      coordinates: bboxToScreenCoords(unreadBBoxes.firstContact, bounds, scaleFactor),
      source: bboxes[1] ? 'vlm' : 'derived'
    }

    const existingCache = getLayoutCache(appType)
    setLayoutCache(appType, {
      ...(existingCache || {
        searchInputBox: null,
        headerArea: null,
        chatMainArea: null,
        messageInputArea: null
      }),
      chatEntranceArea,
      firstContact,
      timestamp: Date.now(),
      appType
    } as LayoutCache)

    console.log('[UnreadDetection] 未读区域检测完成', {
      chatEntranceArea: chatEntranceArea.coordinates,
      firstContact: firstContact.coordinates
    })

    return { success: true, chatEntranceArea, firstContact }
  } catch (error: any) {
    console.error('[UnreadDetection] 未读区域检测失败:', error)
    return { success: false, error: error?.message || String(error) }
  }
}

export async function getUnreadAreaWithCache(
  aiClient: VisionDetectionClient,
  appType: AppType
): Promise<{
  chatEntranceArea: { bbox: BBox; coordinates: [number, number] } | null
  firstContact: { bbox: BBox; coordinates: [number, number] } | null
}> {
  const cache = getLayoutCache(appType)

  if (cache?.chatEntranceArea?.bbox && cache?.firstContact?.bbox) {
    return {
      chatEntranceArea: {
        bbox: cache.chatEntranceArea.bbox,
        coordinates: cache.chatEntranceArea.coordinates
      },
      firstContact: { bbox: cache.firstContact.bbox, coordinates: cache.firstContact.coordinates }
    }
  }

  console.log('[UnreadDetection] 缓存不存在，开始 VLM 检测未读区域')
  const result = await detectUnreadArea(aiClient, appType)

  if (!result.success) {
    console.error('[UnreadDetection] 未读区域检测失败:', result.error)
    return {
      chatEntranceArea: cache?.chatEntranceArea?.bbox
        ? { bbox: cache.chatEntranceArea.bbox, coordinates: cache.chatEntranceArea.coordinates }
        : null,
      firstContact: cache?.firstContact?.bbox
        ? { bbox: cache.firstContact.bbox, coordinates: cache.firstContact.coordinates }
        : null
    }
  }

  return {
    chatEntranceArea: result.chatEntranceArea || null,
    firstContact: result.firstContact || null
  }
}
