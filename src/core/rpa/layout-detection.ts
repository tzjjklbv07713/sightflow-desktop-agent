import { type VisionDetectionClient } from '../vision-client'
import { AppType } from './types'
import { captureWechatWindow } from './screenshot-utils'
import { getWindowInfo } from './window-utils'
import {
  bboxToScreenCoords,
  BBox,
  parseBBoxes,
  getLayoutCache,
  setLayoutCache,
  LayoutAreaItem,
  LayoutCache
} from './vision-utils'

const LAYOUT_DETECT_TIMEOUT_MS = 12_000

function createFallbackWechatLayout(appType: AppType): {
  searchInputBox: BBox
  headerArea: BBox
  chatMainArea: BBox
} {
  if (appType === 'wework') {
    return {
      searchInputBox: [61, 16, 214, 52],
      headerArea: [223, 0, 735, 63],
      chatMainArea: [223, 64, 735, 895]
    }
  }

  return {
    searchInputBox: [63, 15, 221, 52],
    headerArea: [224, 0, 735, 63],
    chatMainArea: [224, 64, 735, 895]
  }
}

function buildFallbackLayoutResult(
  appType: AppType,
  bounds: { x: number; y: number; width: number; height: number },
  scaleFactor: number,
  error?: string
): {
  success: boolean
  searchInputBox: LayoutAreaItem
  headerArea: LayoutAreaItem
  chatMainArea: LayoutAreaItem
  error?: string
} {
  const fallbackLayout = createFallbackWechatLayout(appType)
  const searchInputBox: LayoutAreaItem = {
    bbox: fallbackLayout.searchInputBox,
    coordinates: bboxToScreenCoords(fallbackLayout.searchInputBox, bounds, scaleFactor),
    source: 'derived'
  }
  const headerArea: LayoutAreaItem = {
    bbox: fallbackLayout.headerArea,
    coordinates: bboxToScreenCoords(fallbackLayout.headerArea, bounds, scaleFactor),
    source: 'derived'
  }
  const chatMainArea: LayoutAreaItem = {
    bbox: fallbackLayout.chatMainArea,
    coordinates: bboxToScreenCoords(fallbackLayout.chatMainArea, bounds, scaleFactor),
    source: 'derived'
  }

  const existingCache = getLayoutCache(appType)
  setLayoutCache(appType, {
    ...(existingCache || {
      chatEntranceArea: null,
      firstContact: null,
      messageInputArea: null
    }),
    searchInputBox,
    headerArea,
    chatMainArea,
    timestamp: Date.now(),
    appType
  } as LayoutCache)

  console.warn('[LayoutDetection] 使用默认主布局兜底', {
    appType,
    error,
    searchInputBox: searchInputBox.coordinates,
    headerArea: headerArea.coordinates,
    chatMainArea: chatMainArea.coordinates
  })

  return { success: true, searchInputBox, headerArea, chatMainArea, error }
}

const LAYOUT_DETECT_PROMPTS: Record<'wechat' | 'wework', { prompt: string; targets: string[] }> = {
  wechat: {
    prompt: `你是一个微信布局解析专家。你熟知微信桌面端的布局。
## 微信桌面端布局
- 最左侧一列是导航栏
- 左侧第二列是聊天联系人列表，顶部是搜索输入框
- 第三列是对话区域，由上中下三部分组成：顶部是 header，中间是聊天记录区，底部是文字输入区域

## 你的职责
帮我框选以下三个区域，每个区域用 <bbox>x1,y1,x2,y2</bbox> 格式，坐标范围 0-1000：
1. 【搜索输入框】聊天联系人列表顶部的搜索框
2. 【对话窗口 Header 区域】对话区域最顶上一条，显示当前对话人的名称
3. 【聊天记录区】对话区域中间部分，显示历史聊天气泡的区域`,
    targets: ['【搜索输入框】', '【对话窗口 Header 区域】', '【聊天记录区】']
  },
  wework: {
    prompt: `你是一个企业微信布局解析专家。企业微信 Mac 客户端界面是三栏式布局：
- 左侧导航栏：顶部用户头像，功能菜单（消息/通讯录/邮件/日程/工作台）
- 中间消息列表：顶部搜索框+加号，下面是消息项
- 右侧聊天区：顶部header、中间聊天记录区、底部输入框

## 你的职责
帮我框选以下三个区域，每个区域用 <bbox>x1,y1,x2,y2</bbox> 格式，坐标范围 0-1000：
1. 【搜索输入框】中间消息列表顶部的搜索栏
2. 【右侧聊天区顶部】右侧聊天区最顶上一条，显示当前聊天人/群名
3. 【聊天记录区】右侧聊天区中间部分，显示聊天气泡的区域`,
    targets: ['【搜索输入框】', '【右侧聊天区顶部】', '【聊天记录区】']
  }
}

export async function detectWechatLayout(
  aiClient: VisionDetectionClient,
  appType: AppType
): Promise<{
  success: boolean
  searchInputBox?: LayoutAreaItem
  headerArea?: LayoutAreaItem
  chatMainArea?: LayoutAreaItem
  error?: string
}> {
  try {
    console.log('[LayoutDetection] 开始微信/企微布局检测...')

    const screenshotResult = await captureWechatWindow(appType)
    if (!screenshotResult.success || !screenshotResult.screenshotBase64) {
      return { success: false, error: screenshotResult.error || '截图失败' }
    }

    const windowInfo = await getWindowInfo(appType, false)
    if (!windowInfo?.bounds || !windowInfo?.scaleFactor) {
      return { success: false, error: '获取窗口信息失败' }
    }

    const promptKey = appType === 'wework' ? 'wework' : 'wechat'
    const config = LAYOUT_DETECT_PROMPTS[promptKey]

    console.log('[LayoutDetection] 调用 VLM 检测布局...')
    let vlmResult = ''
    try {
      vlmResult = await aiClient.detectVision(
        config.prompt,
        screenshotResult.screenshotBase64,
        LAYOUT_DETECT_TIMEOUT_MS
      )
    } catch (error: any) {
      return buildFallbackLayoutResult(
        appType,
        windowInfo.bounds,
        windowInfo.scaleFactor,
        error?.message || String(error)
      )
    }
    console.log('[LayoutDetection] VLM 返回:', vlmResult.slice(0, 300))

    const bboxes = parseBBoxes(vlmResult)
    const fallbackLayout = createFallbackWechatLayout(appType)
    const layoutBBoxes = {
      searchInputBox: bboxes[0] || fallbackLayout.searchInputBox,
      headerArea: bboxes[1] || fallbackLayout.headerArea,
      chatMainArea: bboxes[2] || fallbackLayout.chatMainArea
    }

    if (bboxes.length === 0) {
      console.warn('[LayoutDetection] 未返回 bbox，使用默认布局兜底', {
        appType,
        fallbackLayout
      })
    }

    const { bounds, scaleFactor } = windowInfo
    const searchInputBox: LayoutAreaItem = {
      bbox: layoutBBoxes.searchInputBox,
      coordinates: bboxToScreenCoords(layoutBBoxes.searchInputBox, bounds, scaleFactor),
      source: bboxes[0] ? 'vlm' : 'derived'
    }
    const headerArea: LayoutAreaItem = {
      bbox: layoutBBoxes.headerArea,
      coordinates: bboxToScreenCoords(layoutBBoxes.headerArea, bounds, scaleFactor),
      source: bboxes[1] ? 'vlm' : 'derived'
    }
    const chatMainArea: LayoutAreaItem = {
      bbox: layoutBBoxes.chatMainArea,
      coordinates: bboxToScreenCoords(layoutBBoxes.chatMainArea, bounds, scaleFactor),
      source: bboxes[2] ? 'vlm' : 'derived'
    }

    const existingCache = getLayoutCache(appType)
    setLayoutCache(appType, {
      ...(existingCache || {
        chatEntranceArea: null,
        firstContact: null,
        messageInputArea: null
      }),
      searchInputBox,
      headerArea,
      chatMainArea,
      timestamp: Date.now(),
      appType
    } as LayoutCache)

    console.log('[LayoutDetection] 布局检测完成', {
      searchInputBox: searchInputBox.coordinates,
      headerArea: headerArea.coordinates,
      chatMainArea: chatMainArea.coordinates
    })

    return { success: true, searchInputBox, headerArea, chatMainArea }
  } catch (error: any) {
    console.error('[LayoutDetection] 布局检测失败:', error)
    return { success: false, error: error?.message || String(error) }
  }
}
