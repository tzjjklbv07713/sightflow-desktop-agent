import type { AppType } from '../rpa/types'
import type { LatestMessageInspection } from '../rpa/latest-message-inspector'
import { chatKey, messageFromLatestInspection, messagePreview, ObservedChatMessage } from './message-types'

export type MessageDedupeStatus = 'in_progress' | 'completed'

export interface MessageDedupeEntry {
  key: string
  status: MessageDedupeStatus
  firstSeenAt: number
  updatedAt: number
}

export interface MessageDedupeStartResult {
  started: boolean
  key: string
  status?: MessageDedupeStatus
}

export interface MessageDedupeKeyInput {
  appType: AppType
  latestMessage?: LatestMessageInspection | null
  observedMessage?: ObservedChatMessage | null
  screenshot?: string | null
  now?: number
}

export class MessageDedupePool {
  private readonly entries = new Map<string, MessageDedupeEntry>()

  constructor(
    private readonly options: {
      ttlMs?: number
      maxEntries?: number
    } = {}
  ) {}

  start(key: string, now = Date.now()): MessageDedupeStartResult {
    this.prune(now)

    const existing = this.entries.get(key)
    if (existing) {
      existing.updatedAt = now
      return {
        started: false,
        key,
        status: existing.status
      }
    }

    this.entries.set(key, {
      key,
      status: 'in_progress',
      firstSeenAt: now,
      updatedAt: now
    })
    this.trimToMaxEntries()

    return {
      started: true,
      key
    }
  }

  complete(key: string, now = Date.now()): void {
    const existing = this.entries.get(key)
    if (!existing) {
      this.entries.set(key, {
        key,
        status: 'completed',
        firstSeenAt: now,
        updatedAt: now
      })
      this.trimToMaxEntries()
      return
    }

    existing.status = 'completed'
    existing.updatedAt = now
  }

  release(key: string): void {
    this.entries.delete(key)
  }

  reset(): void {
    this.entries.clear()
  }

  private prune(now: number): void {
    const ttlMs = this.options.ttlMs ?? 24 * 60 * 60 * 1000
    const cutoff = now - ttlMs

    for (const [key, entry] of this.entries) {
      if (entry.updatedAt < cutoff) {
        this.entries.delete(key)
      }
    }
  }

  private trimToMaxEntries(): void {
    const maxEntries = this.options.maxEntries ?? 500
    if (this.entries.size <= maxEntries) return

    const extraCount = this.entries.size - maxEntries
    const oldest = Array.from(this.entries.values())
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, extraCount)

    for (const entry of oldest) {
      this.entries.delete(entry.key)
    }
  }
}

export function buildMessageDedupeKey(input: MessageDedupeKeyInput): string {
  const now = input.now ?? Date.now()
  const observedMessage =
    input.observedMessage ?? messageFromLatestInspection(input.latestMessage, input.appType, now)
  const key = chatKey(observedMessage, input.appType)

  if (observedMessage?.id) {
    return `${key}:message:${stableHash(observedMessage.id)}`
  }

  const preview = messagePreview(observedMessage)
  if (preview) {
    const bucket = Math.floor(((observedMessage?.timestamp ?? now) as number) / (5 * 60 * 1000))
    return `${key}:content:${stableHash(preview)}:${bucket}`
  }

  const latestSignature = latestMessageSignature(input.latestMessage)
  const screenshotSignature = input.screenshot ? sampledHash(input.screenshot) : 'no-screenshot'
  return `${key}:vision:${latestSignature}:${screenshotSignature}`
}

function latestMessageSignature(message: LatestMessageInspection | null | undefined): string {
  if (!message) return 'none'

  const bubble = message.bubble
    ? [
        message.bubble.kind,
        Math.round(message.bubble.x / 4),
        Math.round(message.bubble.y / 4),
        Math.round(message.bubble.width / 4),
        Math.round(message.bubble.height / 4),
        Math.round(message.bubble.bottomY / 4)
      ].join(',')
    : 'no-bubble'

  return [
    message.detected ? 'detected' : 'undetected',
    message.latestFromSelf ? 'self' : 'contact',
    Math.round(message.confidence * 100),
    stableHash(message.reason || ''),
    bubble
  ].join(':')
}

function sampledHash(value: string): string {
  if (value.length <= 4096) return stableHash(value)

  const sampleSize = 1024
  const middleStart = Math.max(0, Math.floor(value.length / 2) - Math.floor(sampleSize / 2))
  return stableHash(
    [
      value.length,
      value.slice(0, sampleSize),
      value.slice(middleStart, middleStart + sampleSize),
      value.slice(-sampleSize)
    ].join('|')
  )
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
