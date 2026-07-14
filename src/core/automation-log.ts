import type { AutomationExecutionMode } from './automation-settings'
import type { AutomationSafetyResult } from './automation-safety'
import { messagePreview, type ObservedChatMessage } from './chat/message-types'
import type { ReplyPolicyDecision } from './chat/reply-policy'
import type { MessageDedupeStatus } from './chat/message-dedupe'
import type { LatestMessageInspection } from './rpa/latest-message-inspector'
import type { ReplyRelevanceResult } from './reply-relevance'
import type { SendVerificationResult } from './channel-adapter'

type AutomationLogValue = string | number | boolean | null | undefined

export function formatAutomationLog(
  event: string,
  fields: Record<string, AutomationLogValue> = {}
): string {
  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${sanitizeLogValue(String(value))}`)

  return details.length > 0 ? `${event} | ${details.join(' | ')}` : event
}

export function formatReplyPolicyDecision(
  decision: ReplyPolicyDecision,
  messageKey?: string
): string {
  if (decision.allowed) {
    return formatAutomationLog('自动化决策：允许回复', {
      messageKey,
      decision: 'allowed',
      chatKey: decision.chatKey,
      replyChars: decision.text.length,
      reason: decision.reasons.join(',')
    })
  }

  return formatAutomationLog('自动化决策：跳过回复', {
    messageKey,
    decision: 'blocked',
    reason: decision.reason,
    chatKey: decision.chatKey,
    replyChars: decision.text.length,
    retryAfterMs: decision.retryAfterMs
  })
}

export function formatReplyPolicyBlock(decision: ReplyPolicyDecision): string {
  return formatReplyPolicyDecision(decision)
}

export function formatMessageDedupeStart(key: string): string {
  return formatAutomationLog('自动化消息：开始处理', {
    messageKey: key
  })
}

export function formatMessageObservation(
  key: string,
  latestMessage: LatestMessageInspection
): string {
  return formatAutomationLog('自动化消息：观察结果', {
    messageKey: key,
    detected: latestMessage.detected,
    latestFromSelf: latestMessage.latestFromSelf,
    confidence: latestMessage.confidence.toFixed(2),
    reason: latestMessage.reason,
    bubble: formatBubble(latestMessage),
    error: latestMessage.error
  })
}

export function formatStructuredMessageObservation(
  key: string,
  message: ObservedChatMessage
): string {
  return formatAutomationLog('自动化消息：结构化摘要', {
    messageKey: key,
    chatType: message.chat.type,
    chatName: message.chat.name,
    chatNameSource: message.chat.nameSource,
    direction: message.direction,
    kind: message.kind,
    senderName: message.senderName,
    senderNameSource: message.senderNameSource,
    mentioned: message.mentioned,
    mentionedSource: message.mentionedSource,
    confidence: message.confidence.toFixed(2),
    source: message.source,
    messageId: message.messageId,
    content: messagePreview(message)
  })
}

export function formatGroupDecision(
  key: string,
  message: ObservedChatMessage | null | undefined,
  reason: string
): string {
  return formatAutomationLog('自动化群聊决策', {
    messageKey: key,
    chatType: message?.chat.type,
    chatName: message?.chat.name,
    whitelisted: message?.chat.whitelisted,
    whitelistMatch: message?.chat.whitelistMatch,
    mentioned: message?.mentioned,
    reason
  })
}

export function formatGroupWhitelistMatch(
  key: string,
  message: ObservedChatMessage | null | undefined,
  reason: string
): string {
  return formatAutomationLog('自动化白名单命中', {
    messageKey: key,
    chatName: message?.chat.name,
    whitelistMatch: message?.chat.whitelistMatch,
    reason
  })
}

export function formatReplyGrounding(
  key: string,
  message: ObservedChatMessage | null | undefined,
  replyText: string
): string {
  return formatAutomationLog('自动化回复依据', {
    messageKey: key,
    chatType: message?.chat.type,
    chatName: message?.chat.name,
    direction: message?.direction,
    kind: message?.kind,
    userMessage: messagePreview(message),
    reply: replyText
  })
}

export function formatReplyRelevance(
  key: string,
  result: ReplyRelevanceResult,
  replyText: string
): string {
  return formatAutomationLog('自动化回复相关性', {
    messageKey: key,
    allowed: result.allowed,
    reason: result.reason,
    score: result.score,
    source: result.source,
    reply: replyText
  })
}

export function formatMessageDedupeSkip(
  key: string,
  status: MessageDedupeStatus | undefined
): string {
  return formatAutomationLog('自动化消息：跳过重复', {
    reason: 'duplicate_message',
    status: status || 'unknown',
    messageKey: key
  })
}

export function formatMessageDedupeRelease(key: string, reason: string): string {
  return formatAutomationLog('自动化消息：释放重试', {
    reason,
    messageKey: key
  })
}

export function formatProviderStart(messageKey: string): string {
  return formatAutomationLog('自动化回复服务：开始', {
    messageKey
  })
}

export function formatProviderComplete(messageKey: string, elapsedMs: number): string {
  return formatAutomationLog('自动化回复服务：完成', {
    messageKey,
    providerMs: elapsedMs
  })
}

export function formatProviderFailure(messageKey: string, error: string, elapsedMs: number): string {
  return formatAutomationLog('自动化回复服务：异常', {
    messageKey,
    providerMs: elapsedMs,
    error
  })
}

export function formatProviderSkip(messageKey: string): string {
  return formatAutomationLog('自动化回复服务：无需回复', {
    messageKey
  })
}

export function formatExecutionPlan(
  mode: AutomationExecutionMode,
  decision: ReplyPolicyDecision,
  messageKey?: string
): string {
  const submit = mode === 'auto-send'
  return formatAutomationLog('自动化执行：计划回复', {
    messageKey,
    mode,
    sent: false,
    submit,
    chatKey: decision.chatKey,
    replyChars: decision.text.length,
    plannedReply: decision.text
  })
}

export function formatExecutionStart(
  mode: AutomationExecutionMode,
  decision: ReplyPolicyDecision,
  messageKey?: string
): string {
  return formatAutomationLog('自动化执行：开始', {
    messageKey,
    mode,
    submit: mode === 'auto-send',
    chatKey: decision.chatKey,
    replyChars: decision.text.length
  })
}

export function formatExecutionResult(
  mode: AutomationExecutionMode,
  decision: ReplyPolicyDecision,
  success: boolean,
  messageKey?: string
): string {
  return formatAutomationLog('自动化执行：完成', {
    messageKey,
    mode,
    sent: mode === 'auto-send' && success,
    drafted: mode === 'draft' && success,
    success,
    chatKey: decision.chatKey,
    replyChars: decision.text.length
  })
}

export function formatExecutionFailure(
  mode: AutomationExecutionMode,
  decision: ReplyPolicyDecision,
  reason: string,
  messageKey?: string
): string {
  return formatAutomationLog('自动化执行：失败', {
    messageKey,
    mode,
    reason,
    sent: false,
    chatKey: decision.chatKey,
    replyChars: decision.text.length
  })
}

export function formatExecutionVerification(
  result: SendVerificationResult,
  messageKey?: string
): string {
  return formatAutomationLog('自动化执行：发送校验', {
    messageKey,
    ok: result.ok,
    mode: result.mode,
    reason: result.reason,
    details: result.details,
    diffPercentage: result.evidence?.diffPercentage
  })
}

export function formatSafetyBlock(result: AutomationSafetyResult, messageKey?: string): string {
  return formatAutomationLog('自动化安全：暂停执行', {
    messageKey,
    safe: result.safe,
    reason: result.reason || 'unknown',
    message: result.message
  })
}

export function formatWaitRetry(reason: string | undefined, delayMs: number): string {
  return formatAutomationLog('自动化等待：进入下一轮', {
    reason: reason || 'unknown',
    delayMs
  })
}

function formatBubble(message: LatestMessageInspection): string | undefined {
  if (!message.bubble) return undefined
  const { kind, x, y, width, height, bottomY } = message.bubble
  return `${kind}@${Math.round(x)},${Math.round(y)},${Math.round(width)}x${Math.round(height)},bottom=${Math.round(bottomY)}`
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 800)
}
