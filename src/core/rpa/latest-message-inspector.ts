import { intToRGBA, Jimp } from 'jimp'
import { AppType } from './types'

type BubbleKind = 'self-blue' | 'self-green'
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

interface BubbleComponent {
  kind: BubbleKind
  pixels: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  density: number
}

export interface LatestMessageInspection {
  detected: boolean
  latestFromSelf: boolean
  confidence: number
  reason?: string
  bubble?: {
    kind: BubbleKind
    x: number
    y: number
    width: number
    height: number
    bottomY: number
    centerX: number
    pixels: number
  }
  error?: string
}

export async function inspectLatestMessageFromScreenshot(
  base64Image: string,
  appType: AppType
): Promise<LatestMessageInspection> {
  if (appType !== 'wechat' && appType !== 'wework') {
    return {
      detected: false,
      latestFromSelf: false,
      confidence: 0,
      reason: 'unsupported_app'
    }
  }

  try {
    const buffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    const image = await Jimp.read(buffer)
    const { width, height } = image.bitmap
    if (width <= 0 || height <= 0) {
      return {
        detected: false,
        latestFromSelf: false,
        confidence: 0,
        reason: 'empty_image'
      }
    }

    const selfBubbles = findSelfBubbleComponents(image, appType)
    if (selfBubbles.length === 0) {
      return {
        detected: false,
        latestFromSelf: false,
        confidence: 0,
        reason: 'no_self_bubble'
      }
    }

    const latestSelfBubble = selfBubbles.sort((a, b) => b.maxY - a.maxY || b.maxX - a.maxX)[0]
    const lowerActivity = countLowerNonSelfActivity(image, latestSelfBubble.maxY, appType)
    const bubble = toPublicBubble(latestSelfBubble)

    if (lowerActivity.hasActivity) {
      return {
        detected: true,
        latestFromSelf: false,
        confidence: 0.66,
        reason: `non_self_activity_below_self_bubble:${lowerActivity.count}`,
        bubble
      }
    }

    return {
      detected: true,
      latestFromSelf: true,
      confidence: scoreSelfBubble(latestSelfBubble, width, height),
      reason: 'latest_visible_bubble_is_self',
      bubble
    }
  } catch (error: unknown) {
    return {
      detected: false,
      latestFromSelf: false,
      confidence: 0,
      reason: 'inspect_failed',
      error: formatUnknownError(error)
    }
  }
}

function findSelfBubbleComponents(image: JimpImage, appType: AppType): BubbleComponent[] {
  const { width, height } = image.bitmap
  const visited = new Uint8Array(width * height)
  const components: BubbleComponent[] = []
  const scanStartX = Math.floor(width * 0.35)

  for (let y = 0; y < height; y++) {
    for (let x = scanStartX; x < width; x++) {
      const index = y * width + x
      if (visited[index]) continue

      const kind = getSelfBubblePixelKind(intToRGBA(image.getPixelColor(x, y)), appType)
      if (!kind) {
        visited[index] = 1
        continue
      }

      const component = floodFillSelfBubble(image, visited, x, y, scanStartX, appType, kind)
      if (isSelfBubbleCandidate(component, width, height)) {
        components.push(component)
      }
    }
  }

  return components
}

function floodFillSelfBubble(
  image: JimpImage,
  visited: Uint8Array,
  startX: number,
  startY: number,
  scanStartX: number,
  appType: AppType,
  seedKind: BubbleKind
): BubbleComponent {
  const { width, height } = image.bitmap
  const stack: Array<[number, number]> = [[startX, startY]]
  let pixels = 0
  let minX = startX
  let maxX = startX
  let minY = startY
  let maxY = startY

  while (stack.length > 0) {
    const next = stack.pop()
    if (!next) continue

    const [x, y] = next
    if (x < scanStartX || x >= width || y < 0 || y >= height) continue

    const index = y * width + x
    if (visited[index]) continue
    visited[index] = 1

    const kind = getSelfBubblePixelKind(intToRGBA(image.getPixelColor(x, y)), appType)
    if (!kind) continue

    pixels++
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y

    stack.push([x + 1, y])
    stack.push([x - 1, y])
    stack.push([x, y + 1])
    stack.push([x, y - 1])
  }

  const area = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1))
  return {
    kind: seedKind,
    pixels,
    minX,
    maxX,
    minY,
    maxY,
    density: pixels / area
  }
}

function isSelfBubbleCandidate(
  component: BubbleComponent,
  imageWidth: number,
  imageHeight: number
): boolean {
  const width = component.maxX - component.minX + 1
  const height = component.maxY - component.minY + 1
  const centerX = (component.minX + component.maxX) / 2
  const minPixels = Math.max(60, Math.round(imageWidth * imageHeight * 0.00018))

  return (
    component.pixels >= minPixels &&
    width >= Math.max(20, imageWidth * 0.025) &&
    height >= 12 &&
    width <= imageWidth * 0.72 &&
    height <= imageHeight * 0.35 &&
    component.density >= 0.16 &&
    centerX >= imageWidth * 0.54 &&
    component.maxY >= imageHeight * 0.12
  )
}

function countLowerNonSelfActivity(
  image: JimpImage,
  afterY: number,
  appType: AppType
): { hasActivity: boolean; count: number } {
  const { width, height } = image.bitmap
  const startY = Math.min(height, afterY + 6)
  const leftLimit = Math.floor(width * 0.72)
  const threshold = Math.max(30, Math.round(width * height * 0.00006))
  let count = 0
  let minY = height
  let maxY = startY

  for (let y = startY; y < height; y++) {
    for (let x = 0; x < leftLimit; x++) {
      const rgba = intToRGBA(image.getPixelColor(x, y))
      if (getSelfBubblePixelKind(rgba, appType)) continue
      if (!isLowerMessageActivityPixel(rgba)) continue

      count++
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (count >= threshold && maxY - minY >= 4) {
        return { hasActivity: true, count }
      }
    }
  }

  return { hasActivity: false, count }
}

function getSelfBubblePixelKind(rgba: Rgba, appType: AppType): BubbleKind | null {
  if (rgba.a <= 140) return null
  const { r, g, b } = rgba

  const isWeworkBlue = b >= 165 && g >= 145 && r >= 70 && b >= r + 22 && g >= r + 8
  const isWechatGreen = g >= 155 && r >= 80 && b <= 170 && g >= r + 22 && g >= b + 32

  if (appType === 'wework' && isWeworkBlue) return 'self-blue'
  if (appType === 'wechat' && isWechatGreen) return 'self-green'
  if (isWeworkBlue) return 'self-blue'
  if (isWechatGreen) return 'self-green'
  return null
}

function isLowerMessageActivityPixel(rgba: Rgba): boolean {
  if (rgba.a <= 140) return false

  const { r, g, b } = rgba
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)

  if (r < 105 && g < 105 && b < 105) return true
  if (max < 235 && max - min > 42) return true
  if (max < 205 && max - min > 18) return true
  return false
}

function scoreSelfBubble(
  component: BubbleComponent,
  imageWidth: number,
  imageHeight: number
): number {
  const width = component.maxX - component.minX + 1
  const centerX = (component.minX + component.maxX) / 2
  const horizontalScore = clamp((centerX / imageWidth - 0.52) / 0.28, 0, 1)
  const bottomScore = clamp(component.maxY / imageHeight, 0, 1)
  const densityScore = clamp(component.density / 0.42, 0, 1)
  const sizeScore = clamp(width / (imageWidth * 0.2), 0, 1)
  return Number(
    (
      0.45 +
      horizontalScore * 0.18 +
      bottomScore * 0.12 +
      densityScore * 0.15 +
      sizeScore * 0.1
    ).toFixed(2)
  )
}

function toPublicBubble(component: BubbleComponent): LatestMessageInspection['bubble'] {
  const width = component.maxX - component.minX + 1
  const height = component.maxY - component.minY + 1
  return {
    kind: component.kind,
    x: component.minX,
    y: component.minY,
    width,
    height,
    bottomY: component.maxY,
    centerX: Math.round((component.minX + component.maxX) / 2),
    pixels: component.pixels
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
