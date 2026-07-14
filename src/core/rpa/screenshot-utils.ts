import { intToRGBA, Jimp } from 'jimp'
import { desktopCapturer, nativeImage, screen } from 'electron'
import { getWindowInfo, getWechatWindowInfo } from './window-utils'
import { AppType, ScreenRect } from './types'
import { bboxToCropBounds, getLayoutCache } from './layout-cache'

const IS_MAC = process.platform === 'darwin'

interface ScreenshotCache {
  screenshotBase64: string
  nativeImage: Electron.NativeImage
  bounds: { x: number; y: number; width: number; height: number }
  display: {
    id: number
    bounds: { x: number; y: number; width: number; height: number }
    scaleFactor: number
  }
  timestamp: number
}

interface DisplayFrameCache {
  thumbnail: Electron.NativeImage
  display: {
    id: number
    bounds: { x: number; y: number; width: number; height: number }
    scaleFactor: number
  }
  timestamp: number
}

const screenshotCache = new Map<string, ScreenshotCache>()
const screenshotPendingPromises = new Map<string, Promise<ScreenshotCache | null>>()
const displayFrameCache = new Map<string, DisplayFrameCache>()
const displayFramePendingPromises = new Map<string, Promise<DisplayFrameCache | null>>()

const SCREENSHOT_CACHE_DURATION = 100
const DISPLAY_FRAME_CACHE_DURATION = 300

function getCropHash(crop?: { x: number; y: number; width: number; height: number }): string {
  if (!crop) return 'no-crop'
  return `${crop.x}-${crop.y}-${crop.width}-${crop.height}`
}

function getScreenshotCacheKey(
  displayId: number,
  crop?: { x: number; y: number; width: number; height: number }
): string {
  return `${displayId}-${getCropHash(crop)}`
}

function getDisplayFrameCacheKey(displayId: number): string {
  return String(displayId)
}

function cropFromFrame(
  frame: Electron.NativeImage,
  displayBounds: Electron.Rectangle,
  scaleFactor: number,
  rect: { x: number; y: number; width: number; height: number }
): Electron.NativeImage {
  const cropRect = {
    x: Math.round((rect.x - displayBounds.x) * scaleFactor),
    y: Math.round((rect.y - displayBounds.y) * scaleFactor),
    width: Math.max(1, Math.round(rect.width * scaleFactor)),
    height: Math.max(1, Math.round(rect.height * scaleFactor))
  }

  return frame.crop(cropRect)
}

async function getDisplayFrame(display: {
  id: number
  bounds: Electron.Rectangle
  scaleFactor: number
}): Promise<DisplayFrameCache | null> {
  const cacheKey = getDisplayFrameCacheKey(display.id)
  const now = Date.now()
  const cached = displayFrameCache.get(cacheKey)
  if (cached && now - cached.timestamp < DISPLAY_FRAME_CACHE_DURATION) {
    return cached
  }

  const pending = displayFramePendingPromises.get(cacheKey)
  if (pending) return pending

  const capturePromise = (async (): Promise<DisplayFrameCache | null> => {
    try {
      const physicalWidth = Math.round(display.bounds.width * display.scaleFactor)
      const physicalHeight = Math.round(display.bounds.height * display.scaleFactor)

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('desktopCapturer timeout')), 5000)
      })

      const screenSources = (await Promise.race([
        desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: physicalWidth, height: physicalHeight }
        }),
        timeoutPromise
      ])) as Electron.DesktopCapturerSource[]

      const matchedScreenSource =
        screenSources.find((s) => String(s.display_id) === String(display.id)) || screenSources[0]
      if (!matchedScreenSource) return null

      const result: DisplayFrameCache = {
        thumbnail: matchedScreenSource.thumbnail,
        display,
        timestamp: Date.now()
      }
      displayFrameCache.set(cacheKey, result)
      return result
    } catch (error) {
      console.error('[captureWechatWindow] display frame capture error:', error)
      return null
    } finally {
      displayFramePendingPromises.delete(cacheKey)
    }
  })()

  displayFramePendingPromises.set(cacheKey, capturePromise)
  return capturePromise
}

export function getChatContactAvatarBounds(): {
  x: number
  y: number
  width: number
  height: number
} {
  if (IS_MAC) {
    return { x: 72, y: 64, width: 46, height: 68 }
  }
  return { x: 70, y: 64, width: 46, height: 68 }
}

export function cropDataUrlImage(
  base64Image: string,
  rect: { x: number; y: number; width: number; height: number },
  scaleFactor: number
): string | null {
  try {
    const image = nativeImage.createFromDataURL(base64Image)
    if (image.isEmpty()) return null

    const cropRect = {
      x: Math.max(0, Math.round(rect.x * scaleFactor)),
      y: Math.max(0, Math.round(rect.y * scaleFactor)),
      width: Math.max(1, Math.round(rect.width * scaleFactor)),
      height: Math.max(1, Math.round(rect.height * scaleFactor))
    }

    const cropped = image.crop(cropRect)
    return cropped.toDataURL()
  } catch (error) {
    console.error('[cropDataUrlImage] crop failed:', error)
    return null
  }
}

export function cropLatestMessageFocusScreenshot(
  base64Image: string,
  bubble?: { x: number; y: number; width: number; height: number; bottomY: number; centerX: number } | null
): string | null {
  if (!bubble) return base64Image

  try {
    const image = nativeImage.createFromDataURL(base64Image)
    if (image.isEmpty()) return null

    const { width, height } = image.getSize()
    if (width <= 0 || height <= 0) return null

    const bottomPadding = Math.max(120, Math.round(height * 0.18))
    const minHeight = Math.max(1, Math.round(height * 0.58))
    const endY = Math.min(height, Math.max(minHeight, Math.ceil(bubble.bottomY + bottomPadding)))

    if (endY >= height - Math.max(8, Math.round(height * 0.03))) {
      return base64Image
    }

    const cropped = image.crop({ x: 0, y: 0, width, height: endY })
    return cropped.isEmpty() ? base64Image : cropped.toDataURL()
  } catch (error) {
    console.error('[cropLatestMessageFocusScreenshot] crop failed:', error)
    return base64Image
  }
}

export function dataUrlToNativeImage(base64Image: string): Electron.NativeImage | null {
  try {
    const image = nativeImage.createFromDataURL(base64Image)
    return image.isEmpty() ? null : image
  } catch (error) {
    console.error('[dataUrlToNativeImage] convert failed:', error)
    return null
  }
}

export const takeWeChatScreenshot = async ({ wechatType = 'wechat' }: { wechatType: AppType }) => {
  try {
    const windowInfo = await getWindowInfo(wechatType, true)
    if (!windowInfo) return { success: false, error: '未找到应用窗口' }
    return {
      success: true,
      screenshot: windowInfo.screenshot,
      bounds: windowInfo.bounds,
      scaleFactor: windowInfo.scaleFactor
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function calculateRedDotPercentage(
  base64Image: string,
  onlyFirstQuadrant: boolean = false
): Promise<number | null> {
  try {
    const image = await Jimp.read(
      Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    )
    const { width, height } = image.bitmap
    const totalPixels = width * height
    if (totalPixels === 0) return null

    const centerX = width / 2
    const centerY = height / 2
    let redPixelCount = 0

    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (onlyFirstQuadrant && (x <= centerX || y >= centerY)) continue
        const rgba = intToRGBA(image.getPixelColor(x, y))
        const { r, g, b, a } = rgba
        if (a > 128 && r > 150 && r > g * 1.5 && r > b * 1.5) redPixelCount++
      }
    }
    return (redPixelCount / totalPixels) * 100
  } catch {
    return null
  }
}

export async function captureWechatWindow(
  appType: AppType = 'wechat',
  crop?: { x: number; y: number; width: number; height: number }
): Promise<any> {
  try {
    const windowCoreResult = await getWechatWindowInfo(appType)
    if (!windowCoreResult) return { success: false, error: '未找到窗口' }

    const { display, bounds } = windowCoreResult
    const cacheKey = getScreenshotCacheKey(display.id, crop)

    const cached = screenshotCache.get(cacheKey)
    const now = Date.now()
    if (cached && now - cached.timestamp < SCREENSHOT_CACHE_DURATION) {
      const resultBounds = crop
        ? { x: bounds.x + crop.x, y: bounds.y + crop.y, width: crop.width, height: crop.height }
        : bounds
      return {
        success: true,
        screenshotBase64: cached.screenshotBase64,
        nativeImage: cached.nativeImage,
        bounds: resultBounds,
        display: cached.display,
        timestamp: Date.now()
      }
    }

    const capturePromise = (async (): Promise<ScreenshotCache | null> => {
      try {
        const frame = await getDisplayFrame(display)
        if (!frame) return null

        const targetRect = crop
          ? { x: bounds.x + crop.x, y: bounds.y + crop.y, width: crop.width, height: crop.height }
          : bounds

        const croppedNativeImage = cropFromFrame(
          frame.thumbnail,
          frame.display.bounds,
          frame.display.scaleFactor,
          targetRect
        )
        const croppedScreenshot = croppedNativeImage.toDataURL()

        const resultBounds = crop
          ? { x: bounds.x + crop.x, y: bounds.y + crop.y, width: crop.width, height: crop.height }
          : bounds

        const cacheResult: ScreenshotCache = {
          screenshotBase64: croppedScreenshot,
          nativeImage: croppedNativeImage,
          bounds: resultBounds,
          display,
          timestamp: Date.now()
        }
        screenshotCache.set(cacheKey, cacheResult)
        return cacheResult
      } catch (error) {
        console.error('Screenshot capture error:', error)
        return null
      } finally {
        screenshotPendingPromises.delete(cacheKey)
      }
    })()

    screenshotPendingPromises.set(cacheKey, capturePromise)
    const captureResult = await capturePromise

    if (!captureResult) return { success: false, error: '截图失败', display }

    return {
      success: true,
      screenshotBase64: captureResult.screenshotBase64,
      nativeImage: captureResult.nativeImage,
      bounds: captureResult.bounds,
      display: captureResult.display
    }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

export async function captureScreenRegion(rect: ScreenRect): Promise<{
  success: boolean
  screenshotBase64?: string
  nativeImage?: Electron.NativeImage
  error?: string
  display?: { id: number; bounds: Electron.Rectangle; scaleFactor: number }
}> {
  try {
    const display = screen.getDisplayMatching({
      x: rect.x,
      y: rect.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height)
    })

    const scaleFactor = display.scaleFactor || 1
    const frame = await getDisplayFrame({
      id: display.id,
      bounds: display.bounds,
      scaleFactor
    })
    if (!frame) return { success: false, error: '未找到匹配的屏幕源' }

    const cropped = cropFromFrame(frame.thumbnail, display.bounds, scaleFactor, rect)
    return {
      success: true,
      screenshotBase64: cropped.toDataURL(),
      nativeImage: cropped,
      display: { id: display.id, bounds: display.bounds, scaleFactor }
    }
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) }
  }
}

export async function captureChatMainArea(appType: AppType): Promise<Electron.NativeImage | null> {
  try {
    const layout = getLayoutCache(appType)
    if (!layout?.chatMainArea) {
      console.log('[captureChatMainArea] 未找到 chatMainArea 缓存')
      return null
    }

    if (layout.chatMainArea.rect) {
      const screenshotResult = await captureScreenRegion(layout.chatMainArea.rect)
      if (!screenshotResult.success || !screenshotResult.nativeImage) {
        console.log('[captureChatMainArea] 绝对区域截图失败:', screenshotResult.error)
        return null
      }
      return screenshotResult.nativeImage
    }

    if (!layout.chatMainArea.bbox) {
      console.log('[captureChatMainArea] chatMainArea 缺少 bbox/rect')
      return null
    }

    const windowInfo = await getWindowInfo(appType, false)
    if (!windowInfo?.bounds) {
      console.log('[captureChatMainArea] 获取窗口信息失败')
      return null
    }

    const cropBounds = bboxToCropBounds(layout.chatMainArea.bbox, windowInfo.bounds)
    const crop = {
      x: cropBounds.x,
      y: cropBounds.y,
      width: cropBounds.width,
      height: cropBounds.height
    }

    const screenshotResult = await captureWechatWindow(appType, crop)
    if (!screenshotResult.success) {
      console.log('[captureChatMainArea] 截图失败:', screenshotResult.error)
      return null
    }

    if (screenshotResult.nativeImage) {
      return screenshotResult.nativeImage
    }

    console.log('[captureChatMainArea] 截图结果无 nativeImage:', {
      appType,
      crop,
      keys: Object.keys(screenshotResult),
      hasScreenshotBase64: Boolean(screenshotResult.screenshotBase64)
    })
    return null
  } catch (error: any) {
    console.error('[captureChatMainArea] 异常:', error)
    return null
  }
}
