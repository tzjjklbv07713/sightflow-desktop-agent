import { AppType, ScreenRect } from './types'

const IS_WINDOWS = process.platform === 'win32'

export type BBox = [number, number, number, number]

export interface LayoutAreaItem {
  bbox?: BBox
  rect?: ScreenRect
  coordinates: [number, number]
  source?: 'vlm' | 'box-select' | 'derived'
}

export interface LayoutCache {
  chatEntranceArea: LayoutAreaItem | null
  firstContact: LayoutAreaItem | null
  searchInputBox: LayoutAreaItem | null
  headerArea: LayoutAreaItem | null
  chatMainArea: LayoutAreaItem | null
  messageInputArea: LayoutAreaItem | null
  timestamp: number
  appType: AppType
}

const layoutCacheMemory = new Map<AppType, LayoutCache>()

export function getLayoutCache(appType: AppType): LayoutCache | null {
  return layoutCacheMemory.get(appType) || null
}

export function setLayoutCache(appType: AppType, cache: LayoutCache): void {
  layoutCacheMemory.set(appType, cache)
}

export function clearLayoutCache(appType: AppType): void {
  layoutCacheMemory.delete(appType)
}

export function bboxToScreenCoords(
  bbox: BBox,
  bounds: { x: number; y: number; width: number; height: number },
  scaleFactor: number
): [number, number] {
  const [x1, y1, x2, y2] = bbox
  const logicalX = ((x1 + x2) / 2 / 1000) * bounds.width
  const logicalY = ((y1 + y2) / 2 / 1000) * bounds.height

  if (IS_WINDOWS) {
    return [Math.round((bounds.x + logicalX) * scaleFactor), Math.round((bounds.y + logicalY) * scaleFactor)]
  }

  return [Math.round(bounds.x + logicalX), Math.round(bounds.y + logicalY)]
}

export function pointToScreenCoords(
  point: [number, number],
  bounds: { x: number; y: number; width: number; height: number },
  scaleFactor: number
): [number, number] {
  const [px, py] = point
  const logicalX = (px / 1000) * bounds.width
  const logicalY = (py / 1000) * bounds.height

  if (IS_WINDOWS) {
    return [Math.round((bounds.x + logicalX) * scaleFactor), Math.round((bounds.y + logicalY) * scaleFactor)]
  }

  return [Math.round(bounds.x + logicalX), Math.round(bounds.y + logicalY)]
}

export function bboxToCropBounds(
  bbox: BBox,
  windowBounds: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const [bx1, by1, bx2, by2] = bbox
  const x1 = (bx1 / 1000) * windowBounds.width
  const y1 = (by1 / 1000) * windowBounds.height
  const x2 = (bx2 / 1000) * windowBounds.width
  const y2 = (by2 / 1000) * windowBounds.height

  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  }
}
