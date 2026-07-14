import { AppType } from '../rpa/types'
import { getWindowInfo } from '../rpa/window-utils'
import { probeUiAutomation, UiAutomationProbeResult } from '../uiautomation/probe'

export interface HybridPerceptionCapabilities {
  windowFound: boolean
  windowUsable: boolean
  textReadable: boolean
  inputDetectable: boolean
  visionRequired: boolean
}

export interface HybridPerceptionSnapshot {
  appType: AppType
  capturedAt: number
  capabilities: HybridPerceptionCapabilities
  source: 'uia' | 'window-utils' | 'none'
  title?: string
  processName?: string
  bounds?: { x: number; y: number; width: number; height: number } | null
  scaleFactor?: number
  screenshot?: string
  uia?: UiAutomationProbeResult
  reason?: string
  message?: string
}

export interface HybridPerceptionOptions {
  includeScreenshot?: boolean
  uiaTimeoutMs?: number
}

const DEFAULT_UIA_TIMEOUT_MS = 2500

export async function probeHybridPerception(
  appType: AppType,
  options: HybridPerceptionOptions = {}
): Promise<HybridPerceptionSnapshot> {
  const includeScreenshot = options.includeScreenshot ?? false
  const capturedAt = Date.now()
  const [uiaResult, windowInfo] = await Promise.all([
    tryProbeUiAutomation(appType, options.uiaTimeoutMs ?? DEFAULT_UIA_TIMEOUT_MS),
    getWindowInfo(appType, includeScreenshot)
  ])
  const uia = uiaResult ?? undefined

  if (uia?.ok) {
    const bounds = normalizeBounds(windowInfo?.bounds) || uia.window.bounds || null
    return {
      appType,
      capturedAt,
      capabilities: {
        windowFound: true,
        windowUsable: Boolean(bounds),
        textReadable: uia.capabilities.textReadable,
        inputDetectable: uia.capabilities.inputDetectable,
        visionRequired: !uia.capabilities.textReadable || !uia.capabilities.inputDetectable
      },
      source: 'uia',
      title: uia.window.title,
      processName: uia.window.processName,
      bounds,
      scaleFactor: windowInfo?.scaleFactor,
      screenshot: windowInfo?.screenshot,
      uia
    }
  }

  if (windowInfo?.bounds) {
    return {
      appType,
      capturedAt,
      capabilities: {
        windowFound: true,
        windowUsable: true,
        textReadable: false,
        inputDetectable: false,
        visionRequired: true
      },
      source: 'window-utils',
      bounds: normalizeBounds(windowInfo.bounds),
      scaleFactor: windowInfo.scaleFactor,
      screenshot: windowInfo.screenshot,
      uia,
      reason: uia?.reason,
      message: uia?.message
    }
  }

  return {
    appType,
    capturedAt,
    capabilities: {
      windowFound: false,
      windowUsable: false,
      textReadable: false,
      inputDetectable: false,
      visionRequired: true
    },
    source: 'none',
    uia,
    reason: uia?.reason || 'window_missing',
    message: uia?.message || '目标窗口丢失或无法定位'
  }
}

function tryProbeUiAutomation(
  appType: AppType,
  timeoutMs: number
): Promise<UiAutomationProbeResult | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (appType !== 'wechat' && appType !== 'wework') return Promise.resolve(null)
  return probeUiAutomation(appType, timeoutMs)
}

function normalizeBounds(
  bounds: { x?: number; y?: number; width?: number; height?: number } | null | undefined
): { x: number; y: number; width: number; height: number } | null {
  if (!bounds) return null
  const x = Number(bounds.x)
  const y = Number(bounds.y)
  const width = Number(bounds.width)
  const height = Number(bounds.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  return { x, y, width, height }
}
