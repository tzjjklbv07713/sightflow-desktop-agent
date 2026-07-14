import { intToRGBA, Jimp } from 'jimp'
import { BBox, bboxToCropBounds, bboxToScreenCoords } from './vision-utils'
import { captureWechatWindow, cropDataUrlImage } from './screenshot-utils'
import { AppType } from './types'

export interface VisibleUnreadContact {
  bbox: BBox
  coordinates: [number, number]
  percentage: number
}

interface RedBadgeCandidate {
  redPixels: number
  totalPixels: number
}

interface EdgeAnalysis {
  touchTop: boolean
  touchRight: boolean
  touchBottom: boolean
  touchLeft: boolean
  hasEdgeTouch: boolean
}

export async function findVisibleUnreadContact(
  appType: AppType,
  firstContactBbox: BBox,
  bounds: { x: number; y: number; width: number; height: number },
  scaleFactor: number,
  windowScreenshotBase64?: string
): Promise<VisibleUnreadContact | null> {
  const [x1, y1, x2, y2] = firstContactBbox
  const rowHeight = Math.max(24, y2 - y1)
  const rowStep = Math.max(rowHeight + 6, appType === 'wework' ? 48 : 52)
  const maxBottom = appType === 'wework' ? 910 : 930

  for (let top = y1; top + rowHeight <= maxBottom; top += rowStep) {
    const rowBbox: BBox = [x1, top, x2, Math.min(1000, top + rowHeight)]
    let rowImage: string | null = null

    if (windowScreenshotBase64) {
      const cropBounds = bboxToCropBounds(rowBbox, bounds)
      rowImage = cropDataUrlImage(windowScreenshotBase64, cropBounds, scaleFactor)
    }

    if (!rowImage) {
      const cropBounds = bboxToCropBounds(rowBbox, bounds)
      const screenshotResult = await captureWechatWindow(appType, cropBounds)
      if (!screenshotResult.success || !screenshotResult.screenshotBase64) continue
      rowImage = screenshotResult.screenshotBase64
    }

    if (!rowImage) continue

    const badge = await detectRedBadgeInAvatarCrop(rowImage, scaleFactor)
    if (!badge) continue

    return {
      bbox: rowBbox,
      coordinates: bboxToScreenCoords(rowBbox, bounds, scaleFactor),
      percentage: (badge.redPixels / Math.max(1, badge.totalPixels)) * 100
    }
  }

  return null
}

export async function detectRedBadgeInAvatarCrop(
  base64Image: string,
  scaleFactor: number
): Promise<RedBadgeCandidate | null> {
  try {
    const buffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    const image = await Jimp.read(buffer)
    const { width, height } = image.bitmap
    if (width <= 0 || height <= 0) return null

    const startX = Math.floor(width * 0.45)
    const endY = Math.floor(height * 0.55)
    const totalPixels = width * height
    const visited = new Uint8Array(width * height)
    const maxBadgeSize = Math.max(12, Math.round(34 * scaleFactor))
    const minRedPixels = Math.max(8, Math.round(12 * scaleFactor * scaleFactor))

    for (let y = 0; y < endY; y++) {
      for (let x = startX; x < width; x++) {
        const index = y * width + x
        if (visited[index]) continue
        const rgba = intToRGBA(image.getPixelColor(x, y))
        if (!isUnreadRedPixel(rgba.r, rgba.g, rgba.b, rgba.a)) {
          visited[index] = 1
          continue
        }

        const component = floodFillRedComponent(image, visited, x, y, startX, endY, intToRGBA)
        const componentWidth = component.maxX - component.minX + 1
        const componentHeight = component.maxY - component.minY + 1
        const componentArea = componentWidth * componentHeight
        const density = component.redPixels / Math.max(1, componentArea)

        if (
          component.redPixels >= minRedPixels &&
          componentWidth <= maxBadgeSize &&
          componentHeight <= maxBadgeSize &&
          density >= 0.25
        ) {
          return { redPixels: component.redPixels, totalPixels }
        }
      }
    }
  } catch (error) {
    console.error('[UnreadStrategy] visible contact red badge scan failed:', error)
  }

  return null
}

export async function analyzeRedPixelEdge(base64Image: string): Promise<EdgeAnalysis | null> {
  try {
    const buffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    const image = await Jimp.read(buffer)
    const { width, height } = image.bitmap

    if (width === 0 || height === 0) return null

    const EDGE_MARGIN = 2
    let touchTop = false
    let touchRight = false
    let touchBottom = false
    let touchLeft = false

    const centerX = width / 2
    const centerY = height / 2

    for (let x = Math.floor(centerX); x < width; x++) {
      for (let y = 0; y < Math.floor(centerY); y++) {
        const rgba = intToRGBA(image.getPixelColor(x, y))
        const { r, g, b, a } = rgba

        if (a > 128 && r > 150 && r > g * 1.5 && r > b * 1.5) {
          if (y < EDGE_MARGIN) touchTop = true
          if (x >= width - EDGE_MARGIN) touchRight = true
          if (y >= Math.floor(centerY) - EDGE_MARGIN) touchBottom = true
          if (x < Math.floor(centerX) + EDGE_MARGIN) touchLeft = true
        }
      }
    }

    return {
      touchTop,
      touchRight,
      touchBottom,
      touchLeft,
      hasEdgeTouch: touchTop || touchRight || touchBottom || touchLeft
    }
  } catch (error) {
    console.error('[UnreadStrategy] edge analysis failed:', error)
    return null
  }
}

function floodFillRedComponent(
  image: any,
  visited: Uint8Array,
  startX: number,
  startY: number,
  scanStartX: number,
  scanEndY: number,
  toRGBA: (color: number) => { r: number; g: number; b: number; a: number }
): {
  redPixels: number
  minX: number
  maxX: number
  minY: number
  maxY: number
} {
  const { width } = image.bitmap
  const stack: Array<[number, number]> = [[startX, startY]]
  let redPixels = 0
  let minX = startX
  let maxX = startX
  let minY = startY
  let maxY = startY

  while (stack.length > 0) {
    const item = stack.pop()
    if (!item) continue
    const [x, y] = item
    if (x < scanStartX || y < 0 || x >= width || y >= scanEndY) continue

    const index = y * width + x
    if (visited[index]) continue
    visited[index] = 1

    const rgba = toRGBA(image.getPixelColor(x, y))
    if (!isUnreadRedPixel(rgba.r, rgba.g, rgba.b, rgba.a)) continue

    redPixels++
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y

    stack.push([x + 1, y])
    stack.push([x - 1, y])
    stack.push([x, y + 1])
    stack.push([x, y - 1])
  }

  return { redPixels, minX, maxX, minY, maxY }
}

function isUnreadRedPixel(r: number, g: number, b: number, a: number): boolean {
  return a > 128 && r > 150 && r > g * 1.5 && r > b * 1.5
}
