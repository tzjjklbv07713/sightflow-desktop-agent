import { extractChatMessages, type UiChatMessageRow } from './chat-messages'
import type { LatestMessageInspection } from '../rpa/latest-message-inspector'

export interface InspectHelperOptions {
  /** When true (default), Windows-only UIA is attempted first. */
  preferUia?: boolean
}

/**
 * Best-effort wrapper around the Windows UIAutomation chat extractor. Returns
 * null when no UIA data is available, so callers can fall back to the
 * existing vision-based inspector.
 */
export async function tryInspectViaUia(
  appType: 'wechat' | 'wework' | 'dingtalk' | 'lark' | 'slack' | 'telegram' | 'generic',
  options: InspectHelperOptions = {}
): Promise<LatestMessageInspection | null> {
  if (options.preferUia === false) return null
  if (process.platform !== 'win32') return null

  try {
    const snapshot = await extractChatMessages(appType)
    if (!snapshot.ok || snapshot.rows.length === 0) return null

    const latest = pickLatestIncoming(snapshot.rows)
    if (!latest) return null

    const bounds = latest.bounds ?? null
    return {
      detected: true,
      latestFromSelf: latest.direction === 'self',
      confidence: latest.direction === 'unknown' ? 0.45 : 0.85,
      reason: `uiautomation:${latest.messageId}`,
      bubble: bounds
        ? {
            kind: latest.direction === 'self' ? 'self-green' : 'self-blue',
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            bottomY: bounds.y + bounds.height,
            centerX: bounds.x + Math.round(bounds.width / 2),
            pixels: 0
          }
        : undefined
    }
  } catch (error) {
    console.warn('[inspect-helper] UIA inspector failed:', error)
    return null
  }
}

function pickLatestIncoming(rows: UiChatMessageRow[]): UiChatMessageRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].direction === 'contact') return rows[i]
  }
  return rows[rows.length - 1] ?? null
}