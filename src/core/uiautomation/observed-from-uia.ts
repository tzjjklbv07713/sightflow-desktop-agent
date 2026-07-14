import type { AppType } from '../rpa/types'
import type {
  ChatMessageKind,
  MessageDirection,
  ObservedChatMessage
} from '../chat/message-types'
import {
  type UiChatMessageRow,
  type UiChatMessageResult
} from './chat-messages'

/**
 * Build a stable id for a row. The extractor already provides a stable
 * `messageId` (UIA automation id when available, otherwise a hash of
 * the bubble content + bounds), so we forward it directly.
 */
function rowId(row: UiChatMessageRow): string | undefined {
  if (!row.messageId) return undefined
  return row.messageId
}

function rowDirection(row: UiChatMessageRow): MessageDirection {
  if (row.direction === 'self') return 'self'
  if (row.direction === 'contact') return 'contact'
  if (row.direction === 'system') return 'system'
  return 'unknown'
}

function rowKind(row: UiChatMessageRow): ChatMessageKind {
  // UIA bubbles are always text for now. Image / file / voice bubbles are
  // detected by the vision path; callers fall back when text is empty.
  if (row.text && row.text.trim().length > 0) return 'text'
  return 'unknown'
}

/**
 * Pick the last incoming (non-self) row from a UIA snapshot, or fall back
 * to the most recent row. This mirrors the existing vision-based
 * "latest message from contact" heuristic.
 */
export function pickLatestIncomingRow(
  rows: UiChatMessageRow[]
): UiChatMessageRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].direction === 'contact') return rows[i]
  }
  return rows[rows.length - 1] ?? null
}

export interface UiaObservationOptions {
  /** Chat name for stable chat id; falls back to `${appType}:current`. */
  chatName?: string
  /** Type of chat for the autoSendScope check. Defaults to 'direct'. */
  chatType?: 'direct' | 'group' | 'service' | 'official' | 'unknown'
  observedAt?: number
}

/**
 * Translate the latest row of a successful UIA snapshot into the structured
 * `ObservedChatMessage` consumed by the rest of the pipeline. Returns null
 * when the snapshot is not ok or contains no usable row.
 */
export function observedFromUia(
  appType: AppType,
  result: UiChatMessageResult,
  options: UiaObservationOptions = {}
): ObservedChatMessage | null {
  if (!result.ok) return null
  if (!result.rows || result.rows.length === 0) return null

  const row = pickLatestIncomingRow(result.rows)
  if (!row || !row.text) return null

  const messageId = rowId(row)
  const observedAt = options.observedAt ?? result.capturedAt ?? Date.now()
  const chatId = options.chatName
    ? `${appType}:chat:${hashText(options.chatName)}`
    : `${appType}:current`

  return {
    id: messageId,
    messageId,
    chatId,
    chat: {
      id: chatId,
      name: options.chatName,
      type: options.chatType ?? 'direct'
    },
    direction: rowDirection(row),
    kind: rowKind(row),
    content: row.text,
    senderName: row.senderName || undefined,
    timestamp: observedAt,
    confidence: row.direction === 'unknown' ? 0.45 : 0.85,
    source: 'uiautomation',
    raw: {
      automationId: row.automationId,
      runtimeId: row.runtimeId,
      className: row.className,
      controlType: row.controlType,
      bounds: row.bounds
    }
  }
}

function hashText(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}