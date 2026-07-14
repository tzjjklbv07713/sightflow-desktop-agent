import _pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { AppType } from './types'
import { captureChatMainArea } from './screenshot-utils'

const pixelmatch: typeof _pixelmatch =
  typeof _pixelmatch === 'function'
    ? _pixelmatch
    : ((_pixelmatch as any).default as typeof _pixelmatch)

export interface CompareResult {
  hasChanged: boolean
  diffPercentage: number
  identical: boolean
  diffPixelCount: number
  totalPixels: number
}

export interface CompareOptions {
  threshold?: number
  changeThreshold?: number
}

const CHAT_DIFF_CHANGE_THRESHOLD = 0.15

export function comparePngBuffers(
  buf1: Buffer,
  buf2: Buffer,
  options: CompareOptions = {}
): CompareResult {
  const { threshold = 0.1, changeThreshold = 0.5 } = options

  const png1 = PNG.sync.read(buf1)
  const png2 = PNG.sync.read(buf2)

  if (png1.width !== png2.width || png1.height !== png2.height) {
    const totalPixels = Math.max(png1.width * png1.height, png2.width * png2.height)
    return {
      hasChanged: true,
      diffPercentage: 100,
      identical: false,
      diffPixelCount: totalPixels,
      totalPixels
    }
  }

  const { width, height } = png1
  const totalPixels = width * height

  if (totalPixels === 0) {
    return {
      hasChanged: false,
      diffPercentage: 0,
      identical: true,
      diffPixelCount: 0,
      totalPixels: 0
    }
  }

  const diffPixelCount = pixelmatch(
    png1.data as unknown as Uint8Array,
    png2.data as unknown as Uint8Array,
    undefined,
    width,
    height,
    { threshold }
  )

  const diffPercentage = (diffPixelCount / totalPixels) * 100
  const identical = diffPixelCount === 0
  const hasChanged = diffPercentage > changeThreshold

  return {
    hasChanged,
    diffPercentage: Math.round(diffPercentage * 100) / 100,
    identical,
    diffPixelCount,
    totalPixels
  }
}

export function compareImages(
  img1: Electron.NativeImage,
  img2: Electron.NativeImage,
  options: CompareOptions = {}
): CompareResult {
  return comparePngBuffers(img1.toPNG(), img2.toPNG(), options)
}

export function hasImageChanged(
  img1: Electron.NativeImage,
  img2: Electron.NativeImage,
  changeThreshold = 0.5
): boolean {
  return compareImages(img1, img2, { changeThreshold }).hasChanged
}

let chatBaseline: Electron.NativeImage | null = null

export async function setChatBaseline(
  appType: AppType,
  screenshot?: Electron.NativeImage
): Promise<boolean> {
  const image = screenshot || (await captureChatMainArea(appType))
  if (image) {
    chatBaseline = image
    console.log('[ChatDiff] baseline 已设置')
    return true
  }
  console.warn('[ChatDiff] baseline 设置失败：截图为空')
  return false
}

export function clearChatBaseline(): void {
  chatBaseline = null
}

export function hasChatBaseline(): boolean {
  return chatBaseline !== null
}

export async function checkChatAreaDiff(
  appType: AppType,
  screenshot?: Electron.NativeImage
): Promise<{
  hasDiff: boolean
  hasBaseline: boolean
  diffPercentage?: number
  identical?: boolean
  error?: string
}> {
  if (!chatBaseline) {
    console.log('[ChatDiff] 无 baseline，无法对比')
    return { hasDiff: false, hasBaseline: false }
  }

  const current = screenshot || (await captureChatMainArea(appType))
  if (!current) {
    console.log('[ChatDiff] 截图失败，继续轮询')
    return { hasDiff: false, hasBaseline: true, error: '截图失败' }
  }

  const result = compareImages(chatBaseline, current, {
    threshold: 0.1,
    changeThreshold: CHAT_DIFF_CHANGE_THRESHOLD
  })

  console.log('[ChatDiff] 对比结果:', {
    hasChanged: result.hasChanged,
    diffPercentage: `${result.diffPercentage}%`,
    identical: result.identical
  })

  if (result.hasChanged && !result.identical) {
    return {
      hasDiff: true,
      hasBaseline: true,
      diffPercentage: result.diffPercentage,
      identical: result.identical
    }
  }

  return {
    hasDiff: false,
    hasBaseline: true,
    diffPercentage: result.diffPercentage,
    identical: result.identical
  }
}
