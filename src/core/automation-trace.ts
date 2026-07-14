import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ReplyPolicyDecision } from './chat/reply-policy'
import type { ObservedChatMessage } from './chat/message-types'
import type { KnowledgeContext } from './knowledge-base'
import type { LatestMessageInspection } from './rpa/latest-message-inspector'
import type { AppType } from './rpa/types'
import type { SendVerificationResult } from './channel-adapter'

export type AutomationTraceStatus =
  | 'observing'
  | 'provider_running'
  | 'skipped'
  | 'blocked'
  | 'drafted'
  | 'sent'
  | 'failed'

export interface AutomationTraceEvent {
  at: string
  type: string
  detail?: string
  data?: unknown
}

export interface AutomationTrace {
  id: string
  appType: AppType
  messageKey: string
  status: AutomationTraceStatus
  startedAt: string
  updatedAt: string
  screenshot?: string
  latestMessage?: LatestMessageInspection | null
  observedMessage?: ObservedChatMessage | null
  observationStages?: Array<{
    stage: 'accessibility' | 'native-structure' | 'ocr' | 'vision'
    hit: boolean
    reason?: string
    confidence?: number
  }>
  knowledge?: KnowledgeContext | null
  replyText?: string
  policyDecision?: ReplyPolicyDecision
  executionMode?: string
  verification?: SendVerificationResult
  error?: string
  events: AutomationTraceEvent[]
}

export interface AutomationTraceStats {
  total: number
  sent: number
  failed: number
  blocked: number
  skipped: number
  drafted: number
}

export class AutomationTraceStore {
  private traces: AutomationTrace[] = []

  constructor(
    private readonly filePath: string,
    private readonly maxTraces = 300
  ) {}

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content)
      this.traces = Array.isArray(parsed) ? parsed.filter(isTraceLike).slice(-this.maxTraces) : []
    } catch {
      this.traces = []
    }
  }

  list(limit = 100): AutomationTrace[] {
    return [...this.traces].slice(-limit).reverse()
  }

  get(id: string): AutomationTrace | null {
    return this.traces.find((trace) => trace.id === id) || null
  }

  stats(): AutomationTraceStats {
    return this.traces.reduce(
      (acc, trace) => {
        acc.total += 1
        if (trace.status === 'sent') acc.sent += 1
        if (trace.status === 'failed') acc.failed += 1
        if (trace.status === 'blocked') acc.blocked += 1
        if (trace.status === 'skipped') acc.skipped += 1
        if (trace.status === 'drafted') acc.drafted += 1
        return acc
      },
      { total: 0, sent: 0, failed: 0, blocked: 0, skipped: 0, drafted: 0 }
    )
  }

  async upsert(trace: AutomationTrace): Promise<void> {
    const index = this.traces.findIndex((item) => item.id === trace.id)
    if (index >= 0) {
      this.traces[index] = trace
    } else {
      this.traces.push(trace)
    }
    this.traces = this.traces.slice(-this.maxTraces)
    await this.save()
  }

  create(args: {
    appType: AppType
    messageKey: string
    screenshot?: string
    latestMessage?: LatestMessageInspection | null
  }): AutomationTrace {
    const now = new Date().toISOString()
    return {
      id: createTraceId(args.appType),
      appType: args.appType,
      messageKey: args.messageKey,
      status: 'observing',
      startedAt: now,
      updatedAt: now,
      screenshot: args.screenshot,
      latestMessage: args.latestMessage ?? null,
      observedMessage: null,
      knowledge: null,
      events: [{ at: now, type: 'trace_started', detail: args.messageKey }]
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(this.traces, null, 2)}\n`, 'utf8')
  }
}

export function createAutomationTraceStore(userDataPath: string): AutomationTraceStore {
  return new AutomationTraceStore(path.join(userDataPath, 'automation-traces.json'))
}

export function appendTraceEvent(
  trace: AutomationTrace,
  type: string,
  detail?: string,
  data?: unknown
): AutomationTrace {
  const now = new Date().toISOString()
  trace.updatedAt = now
  trace.events.push({ at: now, type, detail, data })
  return trace
}

function createTraceId(appType: AppType): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `${appType}_${Date.now().toString(36)}_${random}`
}

function isTraceLike(value: unknown): value is AutomationTrace {
  return Boolean(value) && typeof value === 'object' && typeof (value as AutomationTrace).id === 'string'
}
