import type { ReplyPolicyConfig } from './chat/reply-policy'

export type AutomationExecutionMode = 'auto-send' | 'draft' | 'dry-run'

export type GroupReplyMode = 'off' | 'mention-only' | 'mention-or-keyword' | 'whitelist'

export interface AutomationSettings {
  executionMode: AutomationExecutionMode
  maxReplyChars: number
  globalRateLimitPerMinute: number
  perChatRateLimitPerMinute: number
  groupReplyMode: GroupReplyMode
  groupTriggerKeywords: string[]
  groupWhitelist: string[]
  autoSendScope: 'direct-only' | 'direct-and-whitelist-groups' | 'all'
  maxConsecutiveFailures: number
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

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  executionMode: 'auto-send',
  maxReplyChars: 1200,
  globalRateLimitPerMinute: 12,
  perChatRateLimitPerMinute: 4,
  groupReplyMode: 'off',
  groupTriggerKeywords: [],
  groupWhitelist: [],
  autoSendScope: 'direct-only',
  maxConsecutiveFailures: 3,
  perChatDailyLimit: 80,
  globalDailyLimit: 800,
  sensitiveKeywords: [
    '退款',
    '退货',
    '投诉',
    '赔偿',
    '转账',
    '银行卡',
    '发票',
    '合同',
    '法律',
    '律师',
    '医疗',
    '诊断'
  ],
  blockedChatKeywords: [],
  manualHandoffKeywords: ['人工', '客服', '投诉', '差评', '生气', '骗子'],
  humanHandoffEnabled: true,
  requireKnowledgeForAutoSend: false,
  minKnowledgeConfidence: 0.35,
  negativeIntentKeywords: ['投诉', '差评', '生气', '不满意', '骗子', '退款', '赔偿']
}

export function buildReplyPolicyConfig(settings: AutomationSettings): ReplyPolicyConfig {
  return {
    minReplyIntervalMs: 3000,
    duplicateReplyWindowMs: 5 * 60 * 1000,
    maxReplyChars: settings.maxReplyChars,
    latestFromSelfConfidence: 0.45,
    globalRateLimit: {
      windowMs: 60 * 1000,
      maxEvents: settings.globalRateLimitPerMinute
    },
    perChatRateLimit: {
      windowMs: 60 * 1000,
      maxEvents: settings.perChatRateLimitPerMinute
    },
    groupReplyMode: settings.groupReplyMode,
    groupTriggerKeywords: settings.groupTriggerKeywords,
    groupWhitelist: settings.groupWhitelist,
    autoSendScope: settings.autoSendScope,
    perChatDailyLimit: settings.perChatDailyLimit,
    globalDailyLimit: settings.globalDailyLimit,
    sensitiveKeywords: settings.sensitiveKeywords,
    blockedChatKeywords: settings.blockedChatKeywords,
    manualHandoffKeywords: settings.manualHandoffKeywords,
    humanHandoffEnabled: settings.humanHandoffEnabled,
    requireKnowledgeForAutoSend: settings.requireKnowledgeForAutoSend,
    minKnowledgeConfidence: settings.minKnowledgeConfidence,
    negativeIntentKeywords: settings.negativeIntentKeywords
  }
}
