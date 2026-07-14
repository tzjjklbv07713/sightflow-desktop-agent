import { AppType } from '../rpa/types'
import { LatestMessageInspection } from '../rpa/latest-message-inspector'

export type ChatType = 'direct' | 'group' | 'service' | 'official' | 'unknown'

export type MessageDirection = 'self' | 'contact' | 'system' | 'unknown'

export type ChatMessageKind =
  | 'text'
  | 'image'
  | 'file'
  | 'voice'
  | 'link'
  | 'quote'
  | 'emoji'
  | 'mixed'
  | 'unknown'

export type MessageSource = 'vision' | 'uiautomation' | 'manual' | 'unknown'

export interface ChatIdentity {
  id?: string
  name?: string
  type: ChatType
  whitelisted?: boolean
  whitelistMatch?: string
  nameSource?: 'header' | 'message' | 'model' | 'unknown'
}

export interface ObservedChatMessage {
  id?: string
  messageId?: string
  chatId?: string
  screenshotEvidence?: {
    traceId?: string
    capturedAt: number
    dataUrl?: string
  }
  chat: ChatIdentity
  direction: MessageDirection
  kind: ChatMessageKind
  content?: string
  summary?: string
  senderName?: string
  senderNameSource?: 'prefix' | 'bubble' | 'model' | 'unknown'
  mentioned?: boolean
  mentionedSource?: 'explicit' | 'inferred' | 'model' | 'unknown'
  timestamp?: number
  confidence: number
  source: MessageSource
  raw?: unknown
}

export function messageFromLatestInspection(
  latestMessage: LatestMessageInspection | null | undefined,
  appType: AppType,
  observedAt = Date.now()
): ObservedChatMessage | null {
  if (!latestMessage?.detected) return null

  return {
    chat: {
      id: `${appType}:current`,
      type: 'unknown'
    },
    direction: latestMessage.latestFromSelf ? 'self' : 'contact',
    kind: 'unknown',
    timestamp: observedAt,
    confidence: latestMessage.confidence,
    source: 'vision',
    raw: latestMessage
  }
}

export function chatKey(message: ObservedChatMessage | null | undefined, appType: AppType): string {
  return message?.chatId || message?.chat.id || `${appType}:current`
}

export function buildObservedChatId(appType: AppType, chatName?: string): string {
  const normalized = normalizeChatName(chatName)
  if (!normalized) return `${appType}:current`
  return `${appType}:chat:${hashText(normalized)}`
}

export function messagePreview(message: ObservedChatMessage | null | undefined): string | undefined {
  if (!message) return undefined
  return message.content || message.summary
}

export function normalizeChatName(value: string | undefined): string {
  return (value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[·•]/g, ' ')
    .replace(/…/g, '')
    .replace(/\.\.\.$/, '')
    .replace(/\s+\(\d+\)$/, '')
    .replace(/\s+\[\d+\]$/, '')
    .replace(/\s*（\d+）/, '')
    .replace(/\s*群聊$/, '')
    .replace(/\s+/g, ' ')
}

export function buildChatNameCandidates(value: string | undefined): string[] {
  const raw = value || ''
  const normalized = normalizeChatName(raw)
  const candidates = new Set<string>()
  if (normalized) candidates.add(normalized)

  const noEllipsis = normalizeChatName(raw.replace(/(\.\.\.|…)+$/, ''))
  if (noEllipsis) candidates.add(noEllipsis)

  const noSuffix = normalizeChatName(raw.replace(/\s*群聊$/, ''))
  if (noSuffix) candidates.add(noSuffix)

  return Array.from(candidates).filter(Boolean)
}

export function normalizeSenderName(value: string | undefined): string | undefined {
  const normalized = (value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[:：]$/, '')
  return normalized || undefined
}

function hashText(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
