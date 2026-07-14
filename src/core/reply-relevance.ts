import { messagePreview, type ObservedChatMessage } from './chat/message-types'

export type ReplyRelevanceSource = 'heuristic' | 'model' | 'heuristic+model'

export interface ReplyRelevanceResult {
  allowed: boolean
  reason: string
  score: number
  source: ReplyRelevanceSource
}

const STOP_WORDS = new Set([
  '的',
  '了',
  '吗',
  '呢',
  '啊',
  '哦',
  '嗯',
  '我',
  '你',
  '他',
  '她',
  '我们',
  '你们',
  '他们',
  '她们',
  'and',
  'the',
  'is',
  'are',
  'to',
  'a',
  'an'
])

export function assessReplyRelevance(
  observedMessage: ObservedChatMessage | null | undefined,
  replyText: string
): ReplyRelevanceResult {
  const sourceText = messagePreview(observedMessage)
  const reply = normalizeText(replyText)

  if (!sourceText) {
    return { allowed: true, reason: 'no_observed_message', score: 0.5, source: 'heuristic' }
  }

  if (!reply) {
    return { allowed: false, reason: 'empty_reply', score: 0, source: 'heuristic' }
  }

  if (observedMessage?.direction === 'self' && observedMessage.confidence >= 0.6) {
    return { allowed: false, reason: 'replying_to_self', score: 0, source: 'heuristic' }
  }

  const sourceTokens = tokenize(sourceText)
  const replyTokens = tokenize(reply)

  if (sourceTokens.length === 0 || replyTokens.length === 0) {
    return { allowed: true, reason: 'insufficient_tokens', score: 0.5, source: 'heuristic' }
  }

  const overlap = countOverlap(sourceTokens, replyTokens)
  const sourceHasQuestion =
    /[?？吗么呢]$/.test(sourceText.trim()) || /(什么|怎么|是否|能不能|可以吗)/.test(sourceText)
  const replyHasQuestion = /[?？]/.test(reply) || /(什么|怎么|哪里|是否|可以|方便|要不要)/.test(reply)
  const score = Number((overlap / Math.max(1, sourceTokens.length)).toFixed(2))

  if (score >= 0.2) {
    return { allowed: true, reason: 'token_overlap', score, source: 'heuristic' }
  }

  if (sourceHasQuestion && replyHasQuestion) {
    return {
      allowed: true,
      reason: 'question_followup',
      score: Math.max(score, 0.22),
      source: 'heuristic'
    }
  }

  if (observedMessage?.kind && observedMessage.kind !== 'text' && observedMessage.kind !== 'unknown') {
    return {
      allowed: true,
      reason: 'non_text_message',
      score: Math.max(score, 0.2),
      source: 'heuristic'
    }
  }

  if (reply.length <= 6) {
    return {
      allowed: true,
      reason: 'short_ack_reply',
      score: Math.max(score, 0.18),
      source: 'heuristic'
    }
  }

  return { allowed: false, reason: 'low_relevance', score, source: 'heuristic' }
}

export function shouldRunModelRelevanceReview(
  heuristic: ReplyRelevanceResult,
  observedMessage: ObservedChatMessage | null | undefined,
  replyText: string
): boolean {
  if (!observedMessage) return false
  if (!replyText.trim()) return false
  if (heuristic.reason === 'empty_reply' || heuristic.reason === 'replying_to_self') return false
  if (!heuristic.allowed && heuristic.reason === 'low_relevance') return true
  if (heuristic.allowed && heuristic.score < 0.24 && replyText.trim().length > 6) return true
  if (heuristic.allowed && heuristic.reason === 'short_ack_reply' && replyText.trim().length > 2) return true
  return false
}

export function mergeReplyRelevance(
  heuristic: ReplyRelevanceResult,
  reviewed: ReplyRelevanceResult | null | undefined
): ReplyRelevanceResult {
  if (!reviewed) return heuristic

  if (!heuristic.allowed && heuristic.reason === 'low_relevance') {
    if (reviewed.allowed && reviewed.score >= 0.55) {
      return {
        ...reviewed,
        reason: 'model_override_allow',
        source: 'heuristic+model'
      }
    }
    return {
      ...reviewed,
      source: 'heuristic+model'
    }
  }

  if (heuristic.allowed) {
    if (!reviewed.allowed) {
      return {
        ...reviewed,
        source: 'heuristic+model'
      }
    }
    return {
      ...reviewed,
      source: 'heuristic+model'
    }
  }

  return heuristic
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase()
  const segments = normalized.match(/[\u4e00-\u9fa5]{1,4}|[a-z0-9]+/g) || []
  return segments.filter((token) => token && !STOP_WORDS.has(token))
}

function countOverlap(sourceTokens: string[], replyTokens: string[]): number {
  const replySet = new Set(replyTokens)
  let overlap = 0
  for (const token of sourceTokens) {
    if (replySet.has(token)) overlap += 1
  }
  return overlap
}
