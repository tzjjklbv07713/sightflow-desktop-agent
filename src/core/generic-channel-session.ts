import { ChannelAdapter, type ChannelObservation } from './channel-adapter'
import { ReplyPolicy } from './chat/reply-policy'
import { buildMessageDedupeKey, MessageDedupePool } from './chat/message-dedupe'
import { chatKey, messageFromLatestInspection, type ObservedChatMessage } from './chat/message-types'
import {
  AutomationSettings,
  buildReplyPolicyConfig,
  DEFAULT_AUTOMATION_SETTINGS
} from './automation-settings'
import {
  formatExecutionFailure,
  formatExecutionPlan,
  formatExecutionResult,
  formatExecutionStart,
  formatExecutionVerification,
  formatGroupDecision,
  formatGroupWhitelistMatch,
  formatMessageDedupeRelease,
  formatMessageDedupeSkip,
  formatMessageDedupeStart,
  formatMessageObservation,
  formatProviderComplete,
  formatProviderFailure,
  formatProviderSkip,
  formatProviderStart,
  formatReplyGrounding,
  formatReplyPolicyDecision,
  formatReplyRelevance,
  formatSafetyBlock,
  formatStructuredMessageObservation,
  formatWaitRetry
} from './automation-log'
import type { KnowledgeContext } from './knowledge-base'
import { LatestMessageInspection } from './rpa/latest-message-inspector'
import { ChannelContext, ChannelSession, ProviderEvent, SessionEvent } from './session-types'

export interface GenericChannelState {
  measuredAt: number | null
  latestChatBaseline: number | null
  latestScreenshot: string | null
  latestMessage: LatestMessageInspection | null
  observedMessage: ObservedChatMessage | null
  duplicateObservedMessage: { key: string; status?: 'in_progress' | 'completed' } | null
  activeMessageKey: string | null
  activeTraceId: string | null
  latestKnowledge: KnowledgeContext | null
  consecutiveExecutionFailures: number
  latestVerificationReason: string | null
}

export function createInitialGenericChannelState(): GenericChannelState {
  return {
    measuredAt: null,
    latestChatBaseline: null,
    latestScreenshot: null,
    latestMessage: null,
    observedMessage: null,
    duplicateObservedMessage: null,
    activeMessageKey: null,
    activeTraceId: null,
    latestKnowledge: null,
    consecutiveExecutionFailures: 0,
    latestVerificationReason: null
  }
}

export class GenericChannelSession implements ChannelSession<GenericChannelState> {
  private readonly retryDelayMs = 5000
  private readonly maxIdleRetryDelayMs = 15000
  private readonly postReplyRecheckDelayMs = 1500
  private consecutiveUnreadFailures = 0
  private consecutiveIdleChecks = 0
  private automationSettings: AutomationSettings
  private readonly replyPolicy: ReplyPolicy
  private readonly messageDedupe = new MessageDedupePool()

  constructor(
    private readonly channel: ChannelAdapter,
    automationSettings: AutomationSettings = DEFAULT_AUTOMATION_SETTINGS
  ) {
    this.automationSettings = { ...automationSettings }
    this.replyPolicy = new ReplyPolicy(buildReplyPolicyConfig(this.automationSettings))
  }

  updateAutomationConfig(settings: AutomationSettings): void {
    this.automationSettings = { ...settings }
    this.replyPolicy.updateConfig(buildReplyPolicyConfig(this.automationSettings))
  }

  async onStart(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.channel.setAppType(ctx.appType)
    this.channel.clearChatBaseline()
    this.consecutiveUnreadFailures = 0
    this.consecutiveIdleChecks = 0
    this.replyPolicy.reset()
    this.messageDedupe.reset()
    this.resetState(ctx.state)
    await this.channel.onSessionStart?.()
    ctx.host.enqueue({ type: 'bootstrap' })
  }

  async onStop(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.channel.clearChatBaseline()
    this.consecutiveUnreadFailures = 0
    this.consecutiveIdleChecks = 0
    this.replyPolicy.reset()
    this.messageDedupe.reset()
    await this.channel.onSessionStop?.()
    this.resetState(ctx.state)
  }

  async onEvent(event: SessionEvent, ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.channel.setAppType(ctx.appType)

    switch (event.type) {
      case 'bootstrap':
        await this.handleBootstrap(ctx)
        break
      case 'observe_chat':
        await this.handleObserveChat(ctx, event.screenshot)
        break
      case 'provider.thinking':
        ctx.host.log('thinking', event.content)
        break
      case 'provider.observed_message':
        await this.handleProviderObservedMessage(ctx, event.message, event.messageKey)
        break
      case 'provider.reply_relevance':
        ctx.host.log(
          event.result.allowed ? 'thinking' : 'skip',
          formatReplyRelevance(this.currentMessageKey(ctx, event.messageKey), event.result, event.replyText)
        )
        break
      case 'provider.reply_text':
        await this.handleProviderReplyText(ctx, event.content, event.messageKey)
        break
      case 'provider.skip':
        await this.handleProviderSkip(ctx, event.messageKey)
        break
      case 'provider.error':
        await this.handleProviderError(ctx, event.error, event.messageKey, event.elapsedMs ?? 0)
        break
      case 'check_unread':
        await this.handleCheckUnread(ctx)
        break
      case 'wait_retry': {
        const delayMs = event.delayMs ?? this.retryDelayMs
        ctx.host.log('skip', formatWaitRetry(event.reason, delayMs))
        ctx.host.schedule(
          event.reason === 'provider_error' ? { type: 'observe_chat' } : { type: 'check_unread' },
          delayMs
        )
        break
      }
    }
  }

  private async handleBootstrap(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    ctx.host.log('thinking', 'Detecting chat window layout...')
    const result = await this.timed(ctx, 'layout_measure', () => this.channel.measureLayout())
    if (!result.success) {
      ctx.host.log('error', `${result.error || 'layout measure failed'}, engine cannot start`)
      await ctx.host.stopSession('bootstrap_failed')
      return
    }

    const health = await this.channel.healthCheck()
    if (!health.ok) {
      ctx.host.log('error', health.details || health.reason || 'channel health check failed')
      await ctx.host.stopSession(`channel_unhealthy:${health.reason || 'unknown'}`)
      return
    }

    ctx.state.measuredAt = Date.now()
    ctx.host.log('thinking', 'Chat window layout detection complete')
    ctx.host.enqueue({ type: 'observe_chat' })
  }

  private async handleObserveChat(
    ctx: ChannelContext<GenericChannelState>,
    screenshotOverride?: string
  ): Promise<void> {
    const observation = await this.timed(ctx, 'observe_chat', () => this.observeChat(screenshotOverride))
    const screenshot = observation.screenshot
    const latestMessage = observation.latestMessage
    ctx.state.latestScreenshot = screenshot
    ctx.state.latestMessage = latestMessage
    ctx.state.observedMessage = observation.observedMessage
    ctx.state.duplicateObservedMessage = null
    ctx.state.latestKnowledge = null

    if (latestMessage.latestFromSelf && latestMessage.confidence >= 0.55) {
      ctx.host.log(
        'skip',
        `Latest visible message is ours, skip reply (confidence=${latestMessage.confidence.toFixed(2)})`
      )
      await this.channel.setChatBaseline(screenshot)
      ctx.state.latestChatBaseline = Date.now()
      ctx.host.enqueue({ type: 'check_unread' })
      return
    }

    if (latestMessage.error) {
      ctx.host.log('skip', `Latest message inspection failed: ${latestMessage.error}`)
    }
    if (latestMessage.detected) {
      ctx.host.log(
        'skip',
        `Latest message source: ${latestMessage.latestFromSelf ? 'self' : 'contact_or_unknown'} confidence=${latestMessage.confidence.toFixed(2)}`
      )
    } else if (latestMessage.reason) {
      ctx.host.log('skip', `Latest message source unclear: ${latestMessage.reason}`)
    }

    const messageKey = buildMessageDedupeKey({
      appType: ctx.appType,
      latestMessage,
      observedMessage: observation.observedMessage || undefined,
      screenshot
    })
    const dedupeResult = this.messageDedupe.start(messageKey)
    if (!dedupeResult.started) {
      ctx.host.log('skip', formatMessageDedupeSkip(dedupeResult.key, dedupeResult.status))
      await this.channel.setChatBaseline(screenshot)
      ctx.state.latestChatBaseline = Date.now()
      ctx.host.enqueue({ type: 'check_unread' })
      return
    }

    ctx.state.activeMessageKey = messageKey
    ctx.state.activeTraceId =
      (await ctx.host.recordTrace?.({
        type: 'start',
        appType: ctx.appType,
        messageKey,
        screenshot,
        latestMessage,
        observationStages: this.normalizeObservationStages(observation.stages)
      })) || null
    ctx.host.log('skip', formatMessageDedupeStart(messageKey))
    ctx.host.log('skip', formatMessageObservation(messageKey, latestMessage))

    this.consecutiveIdleChecks = 0
    void this.forwardProviderEvents(screenshot, ctx, latestMessage, messageKey)
  }

  private async handleProviderObservedMessage(
    ctx: ChannelContext<GenericChannelState>,
    message: ObservedChatMessage,
    messageKey?: string
  ): Promise<void> {
    ctx.state.observedMessage = message
    this.upgradeActiveMessageKeyFromObservedMessage(ctx, message)
    await ctx.host.recordTrace?.({
      type: 'observed_message',
      traceId: ctx.state.activeTraceId || undefined,
      appType: ctx.appType,
      messageKey: this.currentMessageKey(ctx, messageKey),
      observedMessage: message
    })
    ctx.host.log(
      'skip',
      formatStructuredMessageObservation(this.currentMessageKey(ctx, messageKey), message)
    )
  }

  private async handleProviderReplyText(
    ctx: ChannelContext<GenericChannelState>,
    replyText: string,
    messageKey?: string
  ): Promise<void> {
    const observedMessage = ctx.state.observedMessage
    const knowledge =
      (await ctx.host.getKnowledgeContext?.(observedMessage)) || ctx.state.latestKnowledge || null
    ctx.state.latestKnowledge = knowledge
    if (knowledge) {
      await ctx.host.recordTrace?.({
        type: 'knowledge',
        traceId: ctx.state.activeTraceId || undefined,
        appType: ctx.appType,
        messageKey: this.currentMessageKey(ctx, messageKey),
        knowledge
      })
    }

    if (ctx.state.duplicateObservedMessage) {
      ctx.host.log(
        'skip',
        formatMessageDedupeSkip(
          ctx.state.duplicateObservedMessage.key,
          ctx.state.duplicateObservedMessage.status
        )
      )
      this.clearActiveMessageState(ctx)
      await this.rebaselineAndQueueUnread(ctx)
      return
    }

    const decision = this.replyPolicy.evaluate({
      appType: ctx.appType,
      replyText,
      latestMessage: ctx.state.latestMessage,
      observedMessage,
      knowledgeConfidence: knowledge?.confidence,
      knowledgeMatched: knowledge?.hasAnswer,
      humanHandoffActive: ctx.host.isHumanHandoffActive?.(chatKey(observedMessage, ctx.appType))
    })

    await ctx.host.recordTrace?.({
      type: 'provider_reply',
      traceId: ctx.state.activeTraceId || undefined,
      appType: ctx.appType,
      messageKey: this.currentMessageKey(ctx, messageKey),
      replyText
    })
    await ctx.host.recordTrace?.({
      type: 'policy',
      traceId: ctx.state.activeTraceId || undefined,
      appType: ctx.appType,
      messageKey: this.currentMessageKey(ctx, messageKey),
      policyDecision: decision,
      executionMode: this.automationSettings.executionMode
    })

    if (observedMessage?.chat.type === 'group') {
      ctx.host.log(
        'skip',
        formatGroupDecision(
          this.currentMessageKey(ctx, messageKey),
          observedMessage,
          decision.allowed ? 'group_allowed' : decision.reason
        )
      )
      if (observedMessage.chat.whitelisted && observedMessage.chat.whitelistMatch) {
        ctx.host.log(
          'skip',
          formatGroupWhitelistMatch(
            this.currentMessageKey(ctx, messageKey),
            observedMessage,
            'whitelist_hit'
          )
        )
      }
    }

    ctx.host.log(
      'skip',
      formatReplyGrounding(this.currentMessageKey(ctx, messageKey), observedMessage, replyText)
    )
    ctx.host.log(
      decision.allowed ? 'thinking' : 'skip',
      formatReplyPolicyDecision(decision, this.currentMessageKey(ctx, messageKey))
    )

    if (!decision.allowed) {
      await ctx.host.recordTrace?.({
        type: 'blocked',
        traceId: ctx.state.activeTraceId || undefined,
        appType: ctx.appType,
        messageKey: this.currentMessageKey(ctx, messageKey),
        policyDecision: decision,
        detail: decision.reason
      })
      if (
        this.automationSettings.humanHandoffEnabled &&
        ['manual_handoff_required', 'sensitive_intent', 'negative_intent', 'knowledge_required'].includes(
          decision.reason
        )
      ) {
        ctx.host.setHumanHandoff?.(decision.chatKey, true, decision.reason)
      }
      this.completeMessage(ctx, messageKey)
      await this.rebaselineAndQueueUnread(ctx)
      return
    }

    const executionMode = this.automationSettings.executionMode
    if (executionMode === 'dry-run') {
      ctx.host.log(
        'skip',
        formatExecutionPlan(executionMode, decision, this.currentMessageKey(ctx, messageKey))
      )
      this.replyPolicy.record(decision)
      await ctx.host.recordTrace?.({
        type: 'skipped',
        traceId: ctx.state.activeTraceId || undefined,
        appType: ctx.appType,
        messageKey: this.currentMessageKey(ctx, messageKey),
        policyDecision: decision,
        executionMode
      })
      this.completeMessage(ctx, messageKey)
      await this.rebaselineAndQueueUnread(ctx)
      return
    }

    const submit = executionMode !== 'draft'
    const safety = await this.channel.checkAutomationSafety?.()
    if (safety && !safety.safe) {
      ctx.host.log('error', formatSafetyBlock(safety, this.currentMessageKey(ctx, messageKey)))
      this.releaseMessage(ctx, messageKey, 'automation_safety_failed')
      await ctx.host.recordTrace?.({
        type: 'failed',
        traceId: ctx.state.activeTraceId || undefined,
        appType: ctx.appType,
        messageKey: this.currentMessageKey(ctx, messageKey),
        error: safety.message || safety.reason || 'automation_safety_failed'
      })
      await ctx.host.stopSession(`automation_safety:${safety.reason || 'unknown'}`)
      return
    }

    ctx.host.log(
      'thinking',
      formatExecutionStart(executionMode, decision, this.currentMessageKey(ctx, messageKey))
    )
    const sent = await this.timed(ctx, submit ? 'send_reply' : 'input_draft', () =>
      this.channel.sendMessage(decision.text, { submit })
    )
    if (!sent) {
      await this.handleSendFailure(ctx, decision, messageKey, 'send_failed')
      return
    }

    const verification = await this.channel.verifySend(decision.text, { submit })
    ctx.state.latestVerificationReason = verification.reason || null
    ctx.host.log(
      verification.ok ? 'skip' : 'error',
      formatExecutionVerification(verification, this.currentMessageKey(ctx, messageKey))
    )
    await ctx.host.recordTrace?.({
      type: 'verified',
      traceId: ctx.state.activeTraceId || undefined,
      appType: ctx.appType,
      messageKey: this.currentMessageKey(ctx, messageKey),
      verification
    })
    if (!verification.ok) {
      await this.handleSendFailure(
        ctx,
        decision,
        messageKey,
        verification.reason || 'send_verification_failed',
        verification.details
      )
      return
    }

    ctx.state.consecutiveExecutionFailures = 0
    this.replyPolicy.record(decision)
    await ctx.host.recordTrace?.({
      type: submit ? 'sent' : 'drafted',
      traceId: ctx.state.activeTraceId || undefined,
      appType: ctx.appType,
      messageKey: this.currentMessageKey(ctx, messageKey),
      policyDecision: decision,
      executionMode
    })
    this.completeMessage(ctx, messageKey)
    ctx.host.log(
      'skip',
      formatExecutionResult(executionMode, decision, true, this.currentMessageKey(ctx, messageKey))
    )
    ctx.host.log('reply', submit ? decision.text : `[draft] ${decision.text}`)
    await this.sleep(this.postReplyRecheckDelayMs)
    const refreshedScreenshot = await this.channel.screenshot()
    ctx.state.latestScreenshot = refreshedScreenshot
    await this.channel.setChatBaseline(refreshedScreenshot)
    ctx.state.latestChatBaseline = Date.now()
    this.consecutiveIdleChecks = 0
    ctx.host.log('skip', 'Reply completed, continue unread detection')
    ctx.host.enqueue({ type: 'check_unread' })
  }

  private async handleProviderSkip(
    ctx: ChannelContext<GenericChannelState>,
    messageKey?: string
  ): Promise<void> {
    ctx.host.log('skip', formatProviderSkip(this.currentMessageKey(ctx, messageKey)))
    await ctx.host.recordTrace?.({
      type: 'skipped',
      traceId: ctx.state.activeTraceId || undefined,
      appType: ctx.appType,
      messageKey: this.currentMessageKey(ctx, messageKey)
    })
    if (ctx.state.duplicateObservedMessage) {
      this.clearActiveMessageState(ctx)
    } else {
      this.completeMessage(ctx, messageKey)
    }
    await this.rebaselineAndQueueUnread(ctx)
  }

  private async handleProviderError(
    ctx: ChannelContext<GenericChannelState>,
    error: string,
    messageKey?: string,
    elapsedMs = 0
  ): Promise<void> {
    ctx.host.log(
      'error',
      formatProviderFailure(this.currentMessageKey(ctx, messageKey), error, elapsedMs)
    )
    if (ctx.state.duplicateObservedMessage) {
      this.clearActiveMessageState(ctx)
    } else {
      this.releaseMessage(ctx, messageKey, 'provider_error')
    }
    await ctx.host.recordTrace?.({
      type: 'failed',
      traceId: ctx.state.activeTraceId || undefined,
      appType: ctx.appType,
      messageKey: this.currentMessageKey(ctx, messageKey),
      error
    })
    ctx.host.enqueue({
      type: 'wait_retry',
      reason: 'provider_error',
      delayMs: this.retryDelayMs
    })
  }

  private async handleCheckUnread(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    const currentScreenshot = await this.timed(ctx, 'chat_screenshot', () => this.channel.screenshot())
    ctx.state.latestScreenshot = currentScreenshot

    const diffResult = await this.timed(ctx, 'chat_diff', () =>
      this.channel.hasChatAreaChanged(currentScreenshot)
    )
    if (diffResult.hasBaseline) {
      const percentage =
        typeof diffResult.diffPercentage === 'number'
          ? `${diffResult.diffPercentage}%`
          : diffResult.error || 'n/a'
      ctx.host.log(
        'skip',
        `Chat diff: ${diffResult.hasDiff ? 'changed' : 'unchanged'} / ${percentage}`
      )
    } else {
      ctx.host.log('skip', 'Chat diff: no baseline yet')
    }
    if (diffResult.hasDiff) {
      ctx.host.log('thinking', 'Detected new message in current conversation')
      this.consecutiveIdleChecks = 0
      ctx.host.enqueue({ type: 'observe_chat', screenshot: currentScreenshot })
      return
    }

    const unreadResult = await this.timed(ctx, 'unread_entry_check', () => this.channel.hasUnreadMessage())
    this.logUnreadResult(ctx, 'Unread entry check', unreadResult)
    if (!unreadResult.hasUnread) {
      const delayMs = this.nextIdleDelayMs()
      ctx.host.enqueue({ type: 'wait_retry', reason: 'no_unread', delayMs })
      return
    }

    this.consecutiveIdleChecks = 0
    const chatEntranceCoords = unreadResult.chatEntranceArea?.coordinates
    if (!chatEntranceCoords) {
      ctx.host.log('error', 'Unread detected but chat entrance coordinates missing')
      ctx.host.enqueue({
        type: 'wait_retry',
        reason: 'missing_chat_entrance',
        delayMs: this.retryDelayMs
      })
      return
    }

    ctx.host.log('thinking', 'Unread detected, trying to open conversation')
    await this.channel.activeUnreadByClick(chatEntranceCoords)
    await this.sleep(150 + Math.random() * 100)
    const openResult = await this.tryOpenUnreadConversation(ctx)
    if (openResult === 'opened') {
      ctx.host.enqueue({ type: 'observe_chat' })
      return
    }
    ctx.host.enqueue({
      type: 'wait_retry',
      reason: openResult,
      delayMs: this.retryDelayMs
    })
  }

  private async observeChat(screenshotOverride?: string): Promise<{
    screenshot: string
    latestMessage: LatestMessageInspection
    observedMessage: ObservedChatMessage | null
    stages?: ChannelObservation['stages']
  }> {
    if (this.channel.observe) {
      const observation = await this.channel.observe({ screenshot: screenshotOverride })
      return {
        screenshot: observation.screenshot,
        latestMessage:
          observation.latestMessage || {
            detected: false,
            latestFromSelf: false,
            confidence: 0
          },
        observedMessage: observation.observedMessage,
        stages: observation.stages
      }
    }

    const screenshot = screenshotOverride || (await this.channel.screenshot())
    return {
      screenshot,
      latestMessage: await this.channel.inspectLatestMessage(screenshot),
      observedMessage: await this.tryInspectObserved(),
      stages: undefined
    }
  }

  private async tryInspectObserved(): Promise<ObservedChatMessage | null> {
    if (!this.channel.inspectLatestObserved) return null
    try {
      const observed = await this.channel.inspectLatestObserved()
      if (!observed) return null
      if (observed.direction === 'self') return null
      return observed
    } catch (error) {
      console.warn('[GenericChannelSession] structured observation failed:', error)
      return null
    }
  }

  private async handleSendFailure(
    ctx: ChannelContext<GenericChannelState>,
    decision: ReturnType<ReplyPolicy['evaluate']>,
    messageKey: string | undefined,
    reason: string,
    detail?: string
  ): Promise<void> {
    ctx.state.consecutiveExecutionFailures += 1
    ctx.host.log(
      'error',
      formatExecutionFailure(
        this.automationSettings.executionMode,
        decision,
        reason,
        this.currentMessageKey(ctx, messageKey)
      )
    )
    this.releaseMessage(ctx, messageKey, reason)
    await ctx.host.recordTrace?.({
      type: 'failed',
      traceId: ctx.state.activeTraceId || undefined,
      appType: ctx.appType,
      messageKey: this.currentMessageKey(ctx, messageKey),
      error: reason,
      detail
    })
    if (ctx.state.consecutiveExecutionFailures >= this.automationSettings.maxConsecutiveFailures) {
      await ctx.host.stopSession('automation_failure_fuse')
      return
    }
    await ctx.host.stopSession(reason === 'send_failed' ? 'automation_send_failed' : `automation_${reason}`)
  }

  private async rebaselineAndQueueUnread(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    const screenshot = ctx.state.latestScreenshot || (await this.channel.screenshot())
    ctx.state.latestScreenshot = screenshot
    await this.channel.setChatBaseline(screenshot)
    ctx.state.latestChatBaseline = Date.now()
    this.consecutiveIdleChecks = 0
    ctx.host.enqueue({ type: 'check_unread' })
  }

  private async forwardProviderEvents(
    screenshot: string,
    ctx: ChannelContext<GenericChannelState>,
    latestMessage: LatestMessageInspection,
    messageKey: string
  ): Promise<void> {
    const startedAt = Date.now()
    let providerReportedError = false
    try {
      ctx.host.log('thinking', formatProviderStart(messageKey))
      const fallbackMessage =
        ctx.state.observedMessage || messageFromLatestInspection(latestMessage, ctx.appType)
      const knowledge = (await ctx.host.getKnowledgeContext?.(fallbackMessage)) || null
      ctx.state.latestKnowledge = knowledge
      if (knowledge) {
        await ctx.host.recordTrace?.({
          type: 'knowledge',
          traceId: ctx.state.activeTraceId || undefined,
          appType: ctx.appType,
          messageKey,
          knowledge
        })
      }
      for await (const event of ctx.host.runProvider({
        screenshot,
        appType: ctx.appType,
        replyContext: {
          latestMessage,
          observedMessage: ctx.state.observedMessage,
          knowledge,
          traceId: ctx.state.activeTraceId || undefined
        }
      })) {
        if (!ctx.host.isRunning()) break
        if (event.type === 'error') providerReportedError = true
        const sessionEvent = this.mapProviderEvent(event, messageKey)
        if (sessionEvent) ctx.host.enqueue(sessionEvent)
      }
      const elapsedMs = this.logMetric(ctx, 'provider_run', startedAt)
      if (!providerReportedError) {
        ctx.host.log('skip', formatProviderComplete(messageKey, elapsedMs))
      }
    } catch (error) {
      const elapsedMs = this.logMetric(ctx, 'provider_run', startedAt)
      const message = error instanceof Error ? error.message : String(error)
      ctx.host.enqueue({ type: 'provider.error', error: message, messageKey, elapsedMs })
    }
  }

  private mapProviderEvent(event: ProviderEvent, messageKey: string): SessionEvent | null {
    switch (event.type) {
      case 'thinking':
        return { type: 'provider.thinking', content: event.content, messageKey }
      case 'observed_message':
        return { type: 'provider.observed_message', message: event.message, messageKey }
      case 'reply_relevance':
        return {
          type: 'provider.reply_relevance',
          result: event.result,
          replyText: event.replyText,
          messageKey
        }
      case 'reply_text':
        return { type: 'provider.reply_text', content: event.content, messageKey }
      case 'skip':
        return { type: 'provider.skip', messageKey }
      case 'error':
        return { type: 'provider.error', error: event.error, messageKey }
      default:
        return null
    }
  }

  private normalizeObservationStages(
    stages:
      | Array<{
          stage: 'accessibility' | 'native-structure' | 'ocr' | 'vision'
          hit: boolean
          reason?: string
          confidence?: number
        }>
      | undefined
  ) {
    return Array.isArray(stages) && stages.length > 0 ? stages : undefined
  }

  private resetState(state: GenericChannelState): void {
    state.measuredAt = null
    state.latestChatBaseline = null
    state.latestScreenshot = null
    state.latestMessage = null
    state.observedMessage = null
    state.duplicateObservedMessage = null
    state.activeMessageKey = null
    state.activeTraceId = null
    state.latestKnowledge = null
    state.consecutiveExecutionFailures = 0
    state.latestVerificationReason = null
  }

  private completeMessage(ctx: ChannelContext<GenericChannelState>, messageKey: string | undefined): void {
    const key = this.resolveMessageKey(ctx, messageKey)
    if (!key) return
    this.messageDedupe.complete(key)
    this.clearActiveMessageState(ctx)
  }

  private releaseMessage(
    ctx: ChannelContext<GenericChannelState>,
    messageKey: string | undefined,
    reason: string
  ): void {
    const key = this.resolveMessageKey(ctx, messageKey)
    if (!key) return
    this.messageDedupe.release(key)
    this.clearActiveMessageState(ctx)
    ctx.host.log('skip', formatMessageDedupeRelease(key, reason))
  }

  private currentMessageKey(
    ctx: ChannelContext<GenericChannelState>,
    fallback?: string
  ): string {
    return this.resolveMessageKey(ctx, fallback) || 'unknown'
  }

  private resolveMessageKey(
    ctx: ChannelContext<GenericChannelState>,
    fallback?: string
  ): string | undefined {
    return ctx.state.activeMessageKey || fallback || undefined
  }

  private clearActiveMessageState(ctx: ChannelContext<GenericChannelState>): void {
    ctx.state.activeMessageKey = null
    ctx.state.duplicateObservedMessage = null
    ctx.state.activeTraceId = null
    ctx.state.latestKnowledge = null
  }

  private upgradeActiveMessageKeyFromObservedMessage(
    ctx: ChannelContext<GenericChannelState>,
    observedMessage: ObservedChatMessage
  ): void {
    const refinedKey = buildMessageDedupeKey({
      appType: ctx.appType,
      observedMessage,
      now: observedMessage.timestamp ?? Date.now()
    })
    const currentKey = ctx.state.activeMessageKey
    if (!currentKey || currentKey === refinedKey) {
      ctx.state.activeMessageKey = refinedKey
      ctx.state.duplicateObservedMessage = null
      return
    }
    this.messageDedupe.release(currentKey)
    const dedupeResult = this.messageDedupe.start(refinedKey)
    ctx.state.activeMessageKey = refinedKey
    ctx.state.duplicateObservedMessage = dedupeResult.started
      ? null
      : { key: dedupeResult.key, status: dedupeResult.status }
  }

  private async timed<T>(
    ctx: ChannelContext<GenericChannelState>,
    label: string,
    action: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now()
    try {
      return await action()
    } finally {
      this.logMetric(ctx, label, startedAt)
    }
  }

  private logMetric(ctx: ChannelContext<GenericChannelState>, label: string, startedAt: number): number {
    const elapsedMs = Date.now() - startedAt
    ctx.host.log('metric', `metric | ${label} | ${elapsedMs}ms`)
    return elapsedMs
  }

  private nextIdleDelayMs(): number {
    this.consecutiveIdleChecks += 1
    const step = Math.min(this.consecutiveIdleChecks - 1, 4)
    return Math.min(this.maxIdleRetryDelayMs, this.retryDelayMs + step * 2500)
  }

  private async tryOpenUnreadConversation(
    ctx: ChannelContext<GenericChannelState>
  ): Promise<'opened' | string> {
    let contactResult = await this.channel.isChatContactUnread()
    this.logContactResult(ctx, 'Contact unread check', contactResult)
    if (!contactResult.isUnread) {
      ctx.host.log('thinking', 'Current contact is not unread, re-checking...')
      await this.sleep(1000)
      const recheckResult = await this.channel.hasUnreadMessage()
      this.logUnreadResult(ctx, 'Unread entry re-check', recheckResult)
      const recheckCoords = recheckResult.chatEntranceArea?.coordinates
      if (!recheckResult.hasUnread || !recheckCoords) {
        ctx.host.log('skip', 'No unread entry after re-check')
        return 'contact_not_ready'
      }
      ctx.host.log('thinking', 'Unread still exists, trying to reopen conversation')
      await this.channel.activeUnreadByClick(recheckCoords)
      await this.sleep(500)
      contactResult = await this.channel.isChatContactUnread()
      this.logContactResult(ctx, 'Contact unread re-check', contactResult)
    }
    if (!contactResult.isUnread) {
      this.consecutiveUnreadFailures += 1
      if (this.consecutiveUnreadFailures >= 3) {
        ctx.host.log('thinking', `Unread detection failed ${this.consecutiveUnreadFailures} times, resetting cache`)
        this.channel.clearUnreadCache()
        this.consecutiveUnreadFailures = 0
        await this.sleep(500)
        contactResult = await this.channel.isChatContactUnread()
        this.logContactResult(ctx, 'Post-reset contact unread check', contactResult)
        if (!contactResult.isUnread) {
          ctx.host.log('thinking', 'Post-reset still not ready, retrying unread entry')
          const retryUnread = await this.channel.hasUnreadMessage()
          this.logUnreadResult(ctx, 'Post-reset unread entry check', retryUnread)
          const retryCoords = retryUnread.chatEntranceArea?.coordinates
          if (!retryUnread.hasUnread || !retryCoords) {
            ctx.host.log('skip', 'No usable unread entry after reset')
            return 'contact_not_ready'
          }
          await this.channel.activeUnreadByClick(retryCoords)
          await this.sleep(500)
          contactResult = await this.channel.isChatContactUnread()
          this.logContactResult(ctx, 'Final contact unread check', contactResult)
          if (!contactResult.isUnread) {
            ctx.host.log('skip', 'Final contact unread check failed')
            return 'contact_not_ready'
          }
        }
      } else {
        ctx.host.log('skip', `Unread contact activation failed (${this.consecutiveUnreadFailures})`)
        return 'contact_not_ready'
      }
    }

    this.consecutiveUnreadFailures = 0
    if (!contactResult.firstContactCoords) {
      ctx.host.log('skip', 'Missing unread contact coordinates')
      return 'contact_not_ready'
    }
    ctx.host.log('thinking', 'Opening unread contact')
    await this.channel.clickUnreadContact(contactResult.firstContactCoords)
    await this.sleep(500 + Math.random() * 300)
    this.channel.clearChatBaseline()
    ctx.state.latestChatBaseline = null
    ctx.state.latestScreenshot = null
    return 'opened'
  }

  private logUnreadResult(
    ctx: ChannelContext<GenericChannelState>,
    label: string,
    result: { hasUnread: boolean; percentage?: number; error?: string }
  ): void {
    const percentage =
      typeof result.percentage === 'number'
        ? `${result.percentage.toFixed(2)}%`
        : result.error || 'n/a'
    ctx.host.log('skip', `${label}: ${result.hasUnread ? 'has_unread' : 'no_unread'} / ${percentage}`)
  }

  private logContactResult(
    ctx: ChannelContext<GenericChannelState>,
    label: string,
    result: { isUnread: boolean; percentage?: number; error?: string }
  ): void {
    const percentage =
      typeof result.percentage === 'number'
        ? `${result.percentage.toFixed(2)}%`
        : result.error || 'n/a'
    ctx.host.log('skip', `${label}: ${result.isUnread ? 'is_unread' : 'not_unread'} / ${percentage}`)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
