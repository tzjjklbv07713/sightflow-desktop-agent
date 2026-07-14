import { AppType } from '../rpa/types'
import { LatestMessageInspection } from '../rpa/latest-message-inspector'
import type { GroupReplyMode } from '../automation-settings'
import {
  buildChatNameCandidates,
  chatKey,
  messageFromLatestInspection,
  normalizeChatName,
  ObservedChatMessage
} from './message-types'
import { KeyedSlidingWindowRateLimiter, RateLimitRule } from './rate-limiter'

export interface ReplyPolicyConfig {
  minReplyIntervalMs: number
  duplicateReplyWindowMs: number
  maxReplyChars: number
  latestFromSelfConfidence: number
  globalRateLimit: RateLimitRule
  perChatRateLimit: RateLimitRule
  groupReplyMode: GroupReplyMode
  groupTriggerKeywords: string[]
  groupWhitelist: string[]
  autoSendScope: 'direct-only' | 'direct-and-whitelist-groups' | 'all'
  perChatDailyLimit: number
  globalDailyLimit: number
  sensitiveKeywords: string[]
  blockedChatKeywords: string[]
  manualHandoffKeywords: string[]
  humanHandoffEnabled: boolean
  requireKnowledgeForAutoSend: boolean
  minKnowledgeConfidence: number
  negativeIntentKeywords: string[]
}

export interface ReplyPolicyContext {
  appType: AppType
  replyText: string
  latestMessage?: LatestMessageInspection | null
  observedMessage?: ObservedChatMessage | null
  knowledgeConfidence?: number
  knowledgeMatched?: boolean
  humanHandoffActive?: boolean
  now?: number
}

export type ReplyPolicyDecision =
  | {
      allowed: true
      text: string
      chatKey: string
      reasons: string[]
    }
  | {
      allowed: false
      text: string
      chatKey: string
      reason: string
      retryAfterMs?: number
    }

export const DEFAULT_REPLY_POLICY_CONFIG: ReplyPolicyConfig = {
  minReplyIntervalMs: 3000,
  duplicateReplyWindowMs: 5 * 60 * 1000,
  maxReplyChars: 1200,
  latestFromSelfConfidence: 0.45,
  globalRateLimit: {
    windowMs: 60 * 1000,
    maxEvents: 12
  },
  perChatRateLimit: {
    windowMs: 60 * 1000,
    maxEvents: 4
  },
  groupReplyMode: 'off',
  groupTriggerKeywords: [],
  groupWhitelist: [],
  autoSendScope: 'direct-only',
  perChatDailyLimit: 80,
  globalDailyLimit: 800,
  sensitiveKeywords: [],
  blockedChatKeywords: [],
  manualHandoffKeywords: [],
  humanHandoffEnabled: true,
  requireKnowledgeForAutoSend: false,
  minKnowledgeConfidence: 0.35,
  negativeIntentKeywords: []
}

export class ReplyPolicy {
  private globalLimiter: KeyedSlidingWindowRateLimiter
  private perChatLimiter: KeyedSlidingWindowRateLimiter
  private readonly recentReplyHashes = new Map<string, { hash: string; at: number }>()
  private readonly dailyCounters = new Map<string, { day: string; count: number }>()
  private lastReplyAt = 0

  constructor(private config: ReplyPolicyConfig = DEFAULT_REPLY_POLICY_CONFIG) {
    this.globalLimiter = new KeyedSlidingWindowRateLimiter(config.globalRateLimit)
    this.perChatLimiter = new KeyedSlidingWindowRateLimiter(config.perChatRateLimit)
  }

  updateConfig(config: ReplyPolicyConfig): void {
    this.config = config
    this.globalLimiter = new KeyedSlidingWindowRateLimiter(config.globalRateLimit)
    this.perChatLimiter = new KeyedSlidingWindowRateLimiter(config.perChatRateLimit)
  }

  evaluate(ctx: ReplyPolicyContext): ReplyPolicyDecision {
    const now = ctx.now ?? Date.now()
    const text = normalizeReplyText(ctx.replyText)
    const observedMessage =
      ctx.observedMessage ?? messageFromLatestInspection(ctx.latestMessage, ctx.appType, now)
    applyGroupWhitelist(observedMessage, this.config.groupWhitelist)
    const key = chatKey(observedMessage, ctx.appType)

    if (!text) {
      return { allowed: false, text, chatKey: key, reason: 'empty_reply' }
    }

    if (ctx.humanHandoffActive && this.config.humanHandoffEnabled) {
      return { allowed: false, text, chatKey: key, reason: 'human_handoff_active' }
    }

    if (text.length > this.config.maxReplyChars) {
      return { allowed: false, text, chatKey: key, reason: 'reply_too_long' }
    }

    if (
      observedMessage?.direction === 'self' &&
      observedMessage.confidence >= this.config.latestFromSelfConfidence
    ) {
      return { allowed: false, text, chatKey: key, reason: 'latest_message_from_self' }
    }

    const scopeBlockReason = autoSendScopeBlockReason(observedMessage, this.config.autoSendScope)
    if (scopeBlockReason) {
      return { allowed: false, text, chatKey: key, reason: scopeBlockReason }
    }

    const groupBlockReason = groupReplyBlockReason(
      observedMessage,
      this.config.groupReplyMode,
      this.config.groupTriggerKeywords
    )
    if (groupBlockReason) {
      return { allowed: false, text, chatKey: key, reason: groupBlockReason }
    }

    const blockedChatReason = blockedChatBlockReason(observedMessage, this.config.blockedChatKeywords)
    if (blockedChatReason) {
      return { allowed: false, text, chatKey: key, reason: blockedChatReason }
    }

    const manualHandoffReason = keywordBlockReason(
      observedMessage,
      this.config.humanHandoffEnabled ? this.config.manualHandoffKeywords : [],
      'manual_handoff_required'
    )
    if (manualHandoffReason) {
      return { allowed: false, text, chatKey: key, reason: manualHandoffReason }
    }

    const sensitiveReason = keywordBlockReason(
      observedMessage,
      this.config.sensitiveKeywords,
      'sensitive_intent'
    )
    if (sensitiveReason) {
      return { allowed: false, text, chatKey: key, reason: sensitiveReason }
    }

    const negativeReason = keywordBlockReason(
      observedMessage,
      this.config.negativeIntentKeywords,
      'negative_intent'
    )
    if (negativeReason) {
      return { allowed: false, text, chatKey: key, reason: negativeReason }
    }

    if (
      this.config.requireKnowledgeForAutoSend &&
      (!ctx.knowledgeMatched || (ctx.knowledgeConfidence ?? 0) < this.config.minKnowledgeConfidence)
    ) {
      return { allowed: false, text, chatKey: key, reason: 'knowledge_required' }
    }

    const dailyLimitReason = this.dailyLimitBlockReason(key, now)
    if (dailyLimitReason) {
      return { allowed: false, text, chatKey: key, reason: dailyLimitReason }
    }

    const sinceLastReply = now - this.lastReplyAt
    if (this.lastReplyAt > 0 && sinceLastReply < this.config.minReplyIntervalMs) {
      return {
        allowed: false,
        text,
        chatKey: key,
        reason: 'global_reply_cooldown',
        retryAfterMs: this.config.minReplyIntervalMs - sinceLastReply
      }
    }

    const globalCheck = this.globalLimiter.check('global', now)
    if (!globalCheck.allowed) {
      return {
        allowed: false,
        text,
        chatKey: key,
        reason: 'global_rate_limited',
        retryAfterMs: globalCheck.retryAfterMs
      }
    }

    const chatCheck = this.perChatLimiter.check(key, now)
    if (!chatCheck.allowed) {
      return {
        allowed: false,
        text,
        chatKey: key,
        reason: 'chat_rate_limited',
        retryAfterMs: chatCheck.retryAfterMs
      }
    }

    const replyHash = hashText(text)
    const recentReply = this.recentReplyHashes.get(key)
    if (
      recentReply?.hash === replyHash &&
      now - recentReply.at <= this.config.duplicateReplyWindowMs
    ) {
      return { allowed: false, text, chatKey: key, reason: 'duplicate_reply' }
    }

    return {
      allowed: true,
      text,
      chatKey: key,
      reasons: observedMessage ? ['observed_message'] : ['vision_context_only']
    }
  }

  record(decision: ReplyPolicyDecision, now = Date.now()): void {
    if (!decision.allowed) return

    this.lastReplyAt = now
    this.globalLimiter.record('global', now)
    this.perChatLimiter.record(decision.chatKey, now)
    this.recordDaily(decision.chatKey, now)
    this.recentReplyHashes.set(decision.chatKey, {
      hash: hashText(decision.text),
      at: now
    })
  }

  reset(): void {
    this.lastReplyAt = 0
    this.recentReplyHashes.clear()
    this.dailyCounters.clear()
    this.globalLimiter.reset()
    this.perChatLimiter.reset()
  }

  private dailyLimitBlockReason(chatKeyValue: string, now: number): string | null {
    const day = dailyBucket(now)
    const global = this.dailyCounters.get('global')
    if (this.config.globalDailyLimit > 0 && global?.day === day && global.count >= this.config.globalDailyLimit) {
      return 'global_daily_limit'
    }

    const chat = this.dailyCounters.get(chatKeyValue)
    if (this.config.perChatDailyLimit > 0 && chat?.day === day && chat.count >= this.config.perChatDailyLimit) {
      return 'chat_daily_limit'
    }

    return null
  }

  private recordDaily(chatKeyValue: string, now: number): void {
    const day = dailyBucket(now)
    incrementDailyCounter(this.dailyCounters, 'global', day)
    incrementDailyCounter(this.dailyCounters, chatKeyValue, day)
  }
}

function normalizeReplyText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

function hashText(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function groupReplyBlockReason(
  message: ObservedChatMessage | null | undefined,
  mode: GroupReplyMode,
  triggerKeywords: string[]
): string | null {
  if (message?.chat.type !== 'group') return null

  if (mode === 'off') return 'group_reply_disabled'
  if (mode === 'whitelist') return message.chat.whitelisted ? null : 'group_not_whitelisted'
  if (mode === 'mention-only') return message.mentioned ? null : 'group_not_mentioned'

  const content = message.content || ''
  const keywordMatched = triggerKeywords.some((keyword) => keyword && content.includes(keyword))
  return message.mentioned || keywordMatched ? null : 'group_not_triggered'
}

function autoSendScopeBlockReason(
  message: ObservedChatMessage | null | undefined,
  scope: ReplyPolicyConfig['autoSendScope']
): string | null {
  if (!message) return null
  if (scope === 'all') return null
  if (message.chat.type === 'direct' || message.chat.type === 'service') return null
  if (scope === 'direct-and-whitelist-groups' && message.chat.type === 'group' && message.chat.whitelisted) {
    return null
  }
  if (message.chat.type === 'group') return 'group_not_in_auto_send_scope'
  return 'chat_type_not_in_auto_send_scope'
}

function blockedChatBlockReason(
  message: ObservedChatMessage | null | undefined,
  blockedKeywords: string[]
): string | null {
  if (!message || blockedKeywords.length === 0) return null
  const chatName = normalizeChatName(message.chat.name)
  if (!chatName) return null
  return blockedKeywords.some((keyword) => keyword && chatName.includes(normalizeChatName(keyword)))
    ? 'blocked_chat'
    : null
}

function keywordBlockReason(
  message: ObservedChatMessage | null | undefined,
  keywords: string[],
  reason: string
): string | null {
  if (!message || keywords.length === 0) return null
  const content = [message.content, message.summary].filter(Boolean).join(' ')
  if (!content) return null
  return keywords.some((keyword) => keyword && content.includes(keyword.trim())) ? reason : null
}

function dailyBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function incrementDailyCounter(
  counters: Map<string, { day: string; count: number }>,
  key: string,
  day: string
): void {
  const current = counters.get(key)
  if (!current || current.day !== day) {
    counters.set(key, { day, count: 1 })
    return
  }
  current.count += 1
}

function applyGroupWhitelist(
  message: ObservedChatMessage | null | undefined,
  whitelist: string[]
): void {
  if (!message || message.chat.type !== 'group') return
  const candidates = buildChatNameCandidates(message.chat.name)
  const whitelistNames = whitelist.map((item) => normalizeChatName(item)).filter(Boolean)
  const matched = candidates.find((candidate) =>
    whitelistNames.some((entry) => entry === candidate || entry.startsWith(candidate) || candidate.startsWith(entry))
  )

  message.chat.whitelisted = Boolean(matched)
  message.chat.whitelistMatch = matched
}
