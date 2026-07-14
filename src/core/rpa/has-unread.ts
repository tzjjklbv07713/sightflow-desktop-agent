import { type VisionDetectionClient } from '../vision-client'
import { AppType } from './types'
import { captureWechatWindow, calculateRedDotPercentage } from './screenshot-utils'
import { getWindowInfo } from './window-utils'
import { bboxToCropBounds, BBox } from './vision-utils'
import { getUnreadAreaWithCache } from './unread-detection'
import { analyzeRedPixelEdge, findVisibleUnreadContact } from './unread-strategy'

export async function hasUnreadMessage(
  aiClient: VisionDetectionClient,
  appType: AppType
): Promise<{
  success: boolean
  hasUnread?: boolean
  percentage?: number
  chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  error?: string
}> {
  const THRESHOLD = appType === 'wework' ? 0.2 : 1

  try {
    console.log('[HasUnread] Step 1: 检测聊天入口红点')

    const unreadArea = await getUnreadAreaWithCache(aiClient, appType)
    if (!unreadArea.chatEntranceArea?.bbox) {
      return { success: false, error: '无法获取聊天入口区域' }
    }

    const windowInfo = await getWindowInfo(appType, false)
    if (!windowInfo?.bounds) {
      return { success: false, error: '获取窗口信息失败' }
    }

    const cropBounds = bboxToCropBounds(unreadArea.chatEntranceArea.bbox, windowInfo.bounds)
    const entranceScreenshot = await captureWechatWindow(appType, cropBounds)
    if (!entranceScreenshot.success || !entranceScreenshot.screenshotBase64) {
      return { success: false, error: entranceScreenshot.error || '局部截图失败' }
    }

    const percentage = await calculateRedDotPercentage(entranceScreenshot.screenshotBase64, true)
    if (percentage === null) {
      return { success: false, error: '红点计算失败' }
    }

    const hasUnread = percentage > THRESHOLD

    console.log('[HasUnread] Step 1 结果:', {
      percentage: `${percentage.toFixed(2)}%`,
      threshold: `${THRESHOLD}%`,
      hasUnread
    })

    if (!hasUnread && unreadArea.firstContact?.bbox) {
      const visibleUnreadContact = await findVisibleUnreadContact(
        appType,
        unreadArea.firstContact.bbox,
        windowInfo.bounds,
        windowInfo.scaleFactor || 1
      )

      if (visibleUnreadContact) {
        console.log('[HasUnread] Step 1: 发现可见未读联系人', {
          contactCoordinates: visibleUnreadContact.coordinates,
          contactPercentage: `${visibleUnreadContact.percentage.toFixed(2)}%`,
          contactBbox: visibleUnreadContact.bbox
        })

        return {
          success: true,
          hasUnread: true,
          percentage: visibleUnreadContact.percentage,
          chatEntranceArea: unreadArea.chatEntranceArea
        }
      }
    }

    return {
      success: true,
      hasUnread,
      percentage,
      chatEntranceArea: unreadArea.chatEntranceArea
    }
  } catch (error: any) {
    console.error('[HasUnread] Step 1 失败:', error)
    return { success: false, error: error?.message || String(error) }
  }
}

export async function isChatContactUnread(
  aiClient: VisionDetectionClient,
  appType: AppType
): Promise<{
  success: boolean
  isUnread?: boolean
  percentage?: number
  firstContact?: { bbox: BBox; coordinates: [number, number] }
  error?: string
}> {
  const THRESHOLD = appType === 'wework' ? 1 : 4
  const NO_RED_THRESHOLD = appType === 'wework' ? 0.1 : 0.5
  const MAX_RETRIES = 2
  const EXPAND_STEP = 0.1

  try {
    console.log('[HasUnread] Step 2: 检测联系人红点')

    const unreadArea = await getUnreadAreaWithCache(aiClient, appType)
    if (!unreadArea.firstContact?.bbox) {
      return { success: false, error: '无法获取第一个联系人区域' }
    }

    const windowInfo = await getWindowInfo(appType, false)
    if (!windowInfo?.bounds) {
      return { success: false, error: '获取窗口信息失败' }
    }

    const { firstContact } = unreadArea

    const visibleUnreadContact = await findVisibleUnreadContact(
      appType,
      firstContact.bbox,
      windowInfo.bounds,
      windowInfo.scaleFactor || 1
    )
    if (visibleUnreadContact) {
      console.log('[HasUnread] Step 2: 找到未读红点', {
        coordinates: visibleUnreadContact.coordinates,
        percentage: `${visibleUnreadContact.percentage.toFixed(2)}%`,
        bbox: visibleUnreadContact.bbox
      })
      return {
        success: true,
        isUnread: true,
        percentage: visibleUnreadContact.percentage,
        firstContact: {
          bbox: visibleUnreadContact.bbox,
          coordinates: visibleUnreadContact.coordinates
        }
      }
    }

    const cropBounds = bboxToCropBounds(firstContact.bbox, windowInfo.bounds)

    let currentCrop = { ...cropBounds }
    let retryCount = 0
    let lastPercentage = 0

    while (retryCount <= MAX_RETRIES) {
      console.log(`[HasUnread] Step 2: 第 ${retryCount + 1} 次尝试`, {
        crop: currentCrop
      })

      const currentScreenshot = await captureWechatWindow(appType, currentCrop)
      if (!currentScreenshot.success || !currentScreenshot.screenshotBase64) {
        return { success: false, error: currentScreenshot.error || '局部截图失败' }
      }

      const percentage = await calculateRedDotPercentage(currentScreenshot.screenshotBase64, true)
      if (percentage === null) {
        return { success: false, error: '红点计算失败' }
      }

      lastPercentage = percentage

      if (percentage < NO_RED_THRESHOLD) {
        console.log('[HasUnread] Step 2: 判定无红点', {
          percentage: `${percentage.toFixed(2)}%`
        })
        return {
          success: true,
          isUnread: false,
          percentage,
          firstContact
        }
      }

      if (percentage > THRESHOLD) {
        console.log('[HasUnread] Step 2: 判定有红点', {
          percentage: `${percentage.toFixed(2)}%`
        })
        return {
          success: true,
          isUnread: true,
          percentage,
          firstContact
        }
      }

      console.log('[HasUnread] Step 2: 灰区，进行边缘分析', {
        percentage: `${percentage.toFixed(2)}%`
      })

      const edgeAnalysis = await analyzeRedPixelEdge(currentScreenshot.screenshotBase64)
      if (!edgeAnalysis || !edgeAnalysis.hasEdgeTouch) {
        break
      }

      if (retryCount < MAX_RETRIES) {
        const expandX = currentCrop.width * EXPAND_STEP
        const expandY = currentCrop.height * EXPAND_STEP

        if (edgeAnalysis.touchTop) {
          currentCrop.y -= expandY
          currentCrop.height += expandY
        }
        if (edgeAnalysis.touchRight) {
          currentCrop.width += expandX
        }
        if (edgeAnalysis.touchBottom) {
          currentCrop.height += expandY
        }
        if (edgeAnalysis.touchLeft) {
          currentCrop.x -= expandX
          currentCrop.width += expandX
        }

        console.log('[HasUnread] Step 2: 扩展 crop 区域', {
          retryCount: retryCount + 1,
          edge: edgeAnalysis,
          newCrop: currentCrop
        })
      }

      retryCount++
    }

    const isUnread = lastPercentage > THRESHOLD

    console.log('[HasUnread] Step 2 最终结果', {
      percentage: `${lastPercentage.toFixed(2)}%`,
      threshold: `${THRESHOLD}%`,
      isUnread,
      retryCount
    })

    return {
      success: true,
      isUnread,
      percentage: lastPercentage,
      firstContact
    }
  } catch (error: any) {
    console.error('[HasUnread] Step 2 失败:', error)
    return { success: false, error: error?.message || String(error) }
  }
}
