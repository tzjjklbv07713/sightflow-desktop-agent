import {
  buildObservedChatId,
  messagePreview,
  normalizeChatName,
  normalizeSenderName,
  type ChatMessageKind,
  type ChatType,
  type MessageDirection,
  type ObservedChatMessage
} from './chat/message-types'
import { AppType } from './rpa/types'
import { type ReplyRelevanceResult } from './reply-relevance'
import type { KnowledgeContext } from './knowledge-base'

export interface AIClientConfig {
  apiKey: string
  model: string
  baseURL: string
}

export type DiagnosticErrorCategory =
  | 'auth'
  | 'permission'
  | 'base_url'
  | 'model'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown'

export interface RequestDiagnosticResult {
  success: boolean
  error?: string
  errorCategory?: DiagnosticErrorCategory
  url?: string
  status?: number
  latencyMs?: number
  checkedAt?: string
  normalizedBaseURL?: string
}

export interface ConnectionTestResult extends RequestDiagnosticResult {
  model?: string
  responsePreview?: string
}

export interface VisionDetectionClient {
  detectVision(prompt: string, screenshotBase64: string, timeoutMs?: number): Promise<string>
}

export interface ReplyContext {
  latestMessage?: {
    detected: boolean
    latestFromSelf: boolean
    confidence: number
    reason?: string
    error?: string
  }
  observedMessage?: ObservedChatMessage | null
  knowledge?: KnowledgeContext | null
  traceId?: string
}

export interface ReplyGenerationClient {
  getReply(screenshotBase64: string, context?: ReplyContext): Promise<string | null>
  callText(userMessage: string): Promise<string>
  testConnection(): Promise<ConnectionTestResult>
  updateConfig(config: Partial<AIClientConfig> & { systemPrompt?: string }): void
  getApiKey(): string
}

type ChatMessageContent = string | ChatMessagePart[]

type ChatMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: ChatMessageContent
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown
    }
  }>
}

const DEFAULT_MODEL = 'doubao-seed-2-0-lite-260215'
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

const DEFAULT_REPLY_SYSTEM_PROMPT = `你是一个微信/企业微信自动回复助手。你会收到一张聊天窗口截图。
输入截图可能是完整聊天区，也可能已经裁切到最新消息附近。

## 任务
分析截图中的聊天内容，只针对最新一条对方消息生成自然回复。

## 规则
1. 只输出回复文本，不要解释，不要添加多余内容。
2. 只回复最新一条左侧对方消息，不要回复历史消息、自己上一条回复、系统提示或会话标题。
3. 如果最新消息是系统消息、群公告、红包、转账等非对话消息，输出 [SKIP]。
4. 如果最新左侧消息较短、口语或略模糊，也要围绕它自然回复；不确定对方意思时可以简短追问。
5. 只有在完全看不清最新左侧消息，或最新消息明显不是聊天气泡时，才输出 [SKIP]。
6. 回复要自然、口语化，像真人对话，并且必须直接对应最新消息。`

const DEFAULT_STRUCTURED_REPLY_SYSTEM_PROMPT = `你是一个微信/企业微信聊天回复助手。

你不会再看到整张聊天截图，而是会收到程序提取出的“最新一条需要回复的消息”的结构化摘要。
输入截图可能已经裁切到最新消息附近，请结合结构化摘要理解上下文。

你的任务只有一个：围绕这条最新消息生成自然、简短、直接相关的回复。

要求：
1. 只输出回复文本，不要解释，不要加前缀。
2. 只回复最新这一条消息，不要扩展到历史消息。
3. 如果结构化摘要明确显示最新消息来自自己，输出 [SKIP]。
4. 如果最新消息本身不是可回复的对话内容，输出 [SKIP]。
5. 如果信息不完整，可以做简短追问，但不要跑题。
6. 回复要像真人聊天，口语化、简洁、贴着消息本身说。`

const DEFAULT_MESSAGE_OBSERVATION_PROMPT = `你是一个聊天截图结构化分析器。你会收到一张微信/企业微信聊天窗口截图，以及程序的辅助观察结果。
输入截图可能是完整聊天区，也可能是围绕最新消息裁切后的局部截图。

你的任务：
1. 识别当前截图中“最新一条需要关注的消息”。
2. 输出结构化 JSON，供自动化系统做去重、策略判断和回复。
3. 只关注聊天区，不要把标题栏、联系人列表、系统按钮当作消息。

输出格式：
{"skip":false,"chatName":"会话名","chatType":"direct|group|service|official|unknown","senderName":"发送者名","mentioned":false,"direction":"contact|self|system|unknown","kind":"text|image|file|voice|link|quote|emoji|mixed|unknown","content":"尽量提取的最新消息原文","summary":"如果原文不完整，用一句话概括","confidence":0.0}

如果无法得到有效消息，输出：
{"skip":true,"reason":"latest_message_not_clear|non_chat_content|latest_message_from_self|unsupported_layout","confidence":0.0}

要求：
1. 只输出 JSON，不要解释。
2. 如果能看到最新一条左侧对方消息，direction 必须是 contact。
3. 如果程序观察结果明确提示最新可见消息来自自己，且截图没有更靠下的新左侧消息，输出 skip=true，reason=latest_message_from_self。
4. content 只放最新一条消息，不要拼接历史消息。
5. 如果消息不是纯文本，也要给出 kind 和 summary。
6. 如果界面明显是群聊，chatType 优先输出 group；一对一聊天优先输出 direct。
7. 如果最新消息前带有昵称前缀、群成员名或冒号，尽量填入 senderName。
8. 如果消息正文中出现 @我、@你的昵称、或截图里明显显示被提及，mentioned 优先输出 true。`

const DEFAULT_REPLY_REVIEW_PROMPT = `你是一个聊天回复相关性审核器。你会收到：
1. 一条用户消息的结构化摘要
2. 一条候选回复

请判断候选回复是否和用户消息直接相关，是否像在回应这条消息，而不是跑题、答非所问或像回复了别的上下文。

只输出 JSON：
{"allowed":true,"reason":"directly_relevant","score":0.0}
或
{"allowed":false,"reason":"off_topic|replying_to_self|too_generic|missing_context","score":0.0}

要求：
1. score 取 0 到 1。
2. 只有明确相关时才 allowed=true。
3. 简短确认、追问、澄清也算相关，但不能明显偏题。
4. 只输出 JSON，不要解释。`

export class OpenAICompatClient {
  protected config: AIClientConfig

  constructor(config: Partial<AIClientConfig> & { apiKey: string }) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model || DEFAULT_MODEL,
      baseURL: config.baseURL || DEFAULT_BASE_URL
    }
  }

  updateConfig(config: Partial<AIClientConfig>): void {
    Object.assign(this.config, config)
  }

  getApiKey(): string {
    return this.config.apiKey
  }

  protected async callAPI(messages: ChatMessage[], timeoutMs = 30_000): Promise<unknown> {
    const url = this.buildChatCompletionsUrl(this.config.baseURL)
    const bodyStr = JSON.stringify({
      model: this.config.model,
      messages,
      thinking: { type: 'disabled' },
      stream: false
    })
    const bodySizeKB = (bodyStr.length / 1024).toFixed(0)
    const callStart = Date.now()

    console.log(
      `[AIClient] callAPI start | model=${this.config.model} | payload=${bodySizeKB}KB | timeout=${timeoutMs / 1000}s`
    )

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: bodyStr,
        signal: controller.signal
      })

      const fetchElapsed = ((Date.now() - callStart) / 1000).toFixed(1)
      console.log(`[AIClient] response status=${response.status} (${fetchElapsed}s)`)

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[AIClient] API error: ${response.status}`, errorText)
        throw new Error(buildCompatApiErrorMessage(response.status, errorText))
      }

      const json: unknown = await response.json()
      const totalElapsed = ((Date.now() - callStart) / 1000).toFixed(1)
      console.log(`[AIClient] response parsed (${totalElapsed}s)`)
      return json
    } catch (error: unknown) {
      const elapsed = ((Date.now() - callStart) / 1000).toFixed(1)
      if (isAbortError(error)) {
        console.error(`[AIClient] request timeout after ${elapsed}s, limit=${timeoutMs / 1000}s`)
        throw new Error(`AI API 请求超时 (${timeoutMs / 1000}s)`)
      }
      console.error(`[AIClient] request failed (${elapsed}s):`, formatUnknownError(error))
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  protected extractText(responseData: unknown): string {
    const content = asChatCompletionResponse(responseData)?.choices?.[0]?.message?.content
    if (typeof content === 'string' && content.length > 0) {
      return content
    }
    console.warn('[AIClient] 无法解析回复格式:', safeJsonPreview(responseData))
    return ''
  }

  protected stripBase64Prefix(base64: string): string {
    const idx = base64.indexOf('base64,')
    return idx !== -1 ? base64.slice(idx + 'base64,'.length) : base64
  }

  protected buildChatCompletionsUrl(baseURL: string): string {
    return `${normalizeCompatApiRoot(baseURL, DEFAULT_BASE_URL)}/chat/completions`
  }
}

export class ReplyModelClient extends OpenAICompatClient {
  private systemPrompt: string

  constructor(config: Partial<AIClientConfig> & { apiKey: string; systemPrompt?: string }) {
    super(config)
    this.systemPrompt = config.systemPrompt || DEFAULT_REPLY_SYSTEM_PROMPT
  }

  async getReply(screenshotBase64: string, context: ReplyContext = {}): Promise<string | null> {
    const startTime = Date.now()
    try {
      console.log('[ReplyModelClient] getReply start')
      const observedMessage = context.observedMessage
      const latest = context.latestMessage
      const structuredSource = messagePreview(observedMessage)

      if (
        (latest?.latestFromSelf && latest.confidence >= 0.55) ||
        (observedMessage?.direction === 'self' && observedMessage.confidence >= 0.55)
      ) {
        return null
      }

      const replyText =
        observedMessage && structuredSource
          ? await this.callStructuredReply(context)
          : await this.callVision(
              this.systemPrompt,
              this.withKnowledgeInstruction(this.buildReplyInstruction(context), context.knowledge),
              screenshotBase64
            )

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[ReplyModelClient] getReply done (${elapsed}s):`, replyText?.slice(0, 100))

      if (!replyText || replyText.trim() === '[SKIP]') {
        return null
      }

      return replyText.trim()
    } catch (error: unknown) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.error(`[ReplyModelClient] reply failed (${elapsed}s):`, formatUnknownError(error))
      throw error
    }
  }

  async inspectObservedMessage(
    screenshotBase64: string,
    appType: AppType,
    context: ReplyContext = {}
  ): Promise<ObservedChatMessage | null> {
    const raw = await this.callVision(
      DEFAULT_MESSAGE_OBSERVATION_PROMPT,
      this.buildObservationInstruction(context),
      screenshotBase64
    )
    return parseObservedMessage(raw, appType)
  }

  async reviewReplyRelevance(
    observedMessage: ObservedChatMessage,
    replyText: string
  ): Promise<ReplyRelevanceResult | null> {
    const source = messagePreview(observedMessage)
    if (!source || !replyText.trim()) return null

    const raw = await this.callAPI([
      { role: 'system', content: DEFAULT_REPLY_REVIEW_PROMPT },
      {
        role: 'user',
        content: [
          '结构化消息摘要：',
          `- 会话类型: ${observedMessage.chat.type}`,
          observedMessage.chat.name ? `- 会话名: ${observedMessage.chat.name}` : '',
          `- 消息方向: ${observedMessage.direction}`,
          `- 消息类型: ${observedMessage.kind}`,
          observedMessage.senderName ? `- 发送者: ${observedMessage.senderName}` : '',
          observedMessage.summary ? `- 消息概括: ${observedMessage.summary}` : '',
          `- 消息文本: ${source}`,
          '',
          `候选回复：${replyText}`,
          '',
          '请输出 JSON。'
        ]
          .filter(Boolean)
          .join('\n')
      }
    ])

    return parseReplyRelevanceReview(this.extractText(raw))
  }

  private buildReplyInstruction(context: ReplyContext): string {
    const latest = context.latestMessage
    const observedMessage = context.observedMessage
    const observation = latest
      ? [
          '## 程序观察结果',
          `- 是否检测到最新消息来源: ${latest.detected ? '是' : '否'}`,
          `- 最新可见消息是否来自自己: ${latest.latestFromSelf ? '是' : '否'}`,
          `- 置信度: ${latest.confidence}`,
          latest.reason ? `- 原因: ${latest.reason}` : '',
          latest.error ? `- 检测错误: ${latest.error}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      : '## 程序观察结果\n- 未提供额外观察结果'

    const structuredObservation = observedMessage
      ? [
          '## 结构化消息摘要',
          `- 会话类型: ${observedMessage.chat.type}`,
          observedMessage.chat.name ? `- 会话名: ${observedMessage.chat.name}` : '',
          `- 消息方向: ${observedMessage.direction}`,
          `- 消息类型: ${observedMessage.kind}`,
          observedMessage.senderName ? `- 发送者: ${observedMessage.senderName}` : '',
          typeof observedMessage.mentioned === 'boolean'
            ? `- 是否提及我: ${observedMessage.mentioned ? '是' : '否'}`
            : '',
          observedMessage.content ? `- 最新消息原文: ${observedMessage.content}` : '',
          observedMessage.summary ? `- 最新消息概括: ${observedMessage.summary}` : '',
          `- 结构化置信度: ${observedMessage.confidence}`
        ]
          .filter(Boolean)
          .join('\n')
      : '## 结构化消息摘要\n- 未提供结构化摘要'

    return `${observation}

${structuredObservation}

## 回复要求
请只根据截图中最新一条左侧对方消息生成回复。
- 如果程序观察结果显示“最新可见消息是否来自自己: 是”，必须输出 [SKIP]。
- 如果结构化消息摘要里 direction=self 或 latest_message_from_self，必须输出 [SKIP]。
- 优先参考“结构化消息摘要”里的最新消息原文/概括，但要以截图可见内容为准。
- 如果最新左侧消息看得见，就直接回复或简短追问。
- 不要回复历史消息、右侧自己发出的消息、系统提示或会话标题。
- 只有当最新消息在右侧、完全看不清或不是聊天气泡时才输出 [SKIP]。`
  }

  private buildStructuredReplyInstruction(context: ReplyContext): string {
    const latest = context.latestMessage
    const observedMessage = context.observedMessage
    const source = messagePreview(observedMessage)

    const structuredObservation = observedMessage
      ? [
          '## 最新消息结构化摘要',
          `- 会话类型: ${observedMessage.chat.type}`,
          observedMessage.chat.name ? `- 会话名: ${observedMessage.chat.name}` : '',
          `- 消息方向: ${observedMessage.direction}`,
          `- 消息类型: ${observedMessage.kind}`,
          observedMessage.senderName ? `- 发送者: ${observedMessage.senderName}` : '',
          typeof observedMessage.mentioned === 'boolean'
            ? `- 是否提及我: ${observedMessage.mentioned ? '是' : '否'}`
            : '',
          source ? `- 最新消息内容: ${source}` : '',
          observedMessage.summary ? `- 最新消息概括: ${observedMessage.summary}` : '',
          `- 结构化置信度: ${observedMessage.confidence}`
        ]
          .filter(Boolean)
          .join('\n')
      : '## 最新消息结构化摘要\n- 未提供结构化摘要'

    const observation = latest
      ? [
          '## 程序观察结果',
          `- 是否检测到最新消息来源: ${latest.detected ? '是' : '否'}`,
          `- 最新可见消息是否来自自己: ${latest.latestFromSelf ? '是' : '否'}`,
          `- 置信度: ${latest.confidence}`,
          latest.reason ? `- 原因: ${latest.reason}` : '',
          latest.error ? `- 检测错误: ${latest.error}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      : '## 程序观察结果\n- 未提供额外观察结果'

    return `${structuredObservation}

${observation}

## 回复要求
- 只围绕“最新消息内容”生成回复。
- 如果最新消息来自自己，输出 [SKIP]。
- 如果消息不是需要回复的聊天内容，输出 [SKIP]。
- 如果消息简短或不完整，可以简短追问，但不要跑题。
- 不要引用历史消息，不要总结整段对话。`
  }

  private async callStructuredReply(context: ReplyContext): Promise<string> {
    const raw = await this.callAPI([
      { role: 'system', content: DEFAULT_STRUCTURED_REPLY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: this.withKnowledgeInstruction(
          this.buildStructuredReplyInstruction(context),
          context.knowledge
        )
      }
    ])
    return this.extractText(raw)
  }

  private withKnowledgeInstruction(
    instruction: string,
    knowledge: KnowledgeContext | null | undefined
  ): string {
    return `${instruction}

${this.buildKnowledgeInstruction(knowledge)}`
  }

  private buildKnowledgeInstruction(knowledge: KnowledgeContext | null | undefined): string {
    if (!knowledge || knowledge.matches.length === 0) {
      return [
        '## Knowledge Base',
        '- No matching business knowledge was found.',
        '- If the customer asks for a policy-specific answer, reply cautiously or output [SKIP].'
      ].join('\n')
    }

    return [
      '## Knowledge Base',
      `- confidence: ${knowledge.confidence.toFixed(2)}`,
      `- hasAnswer: ${knowledge.hasAnswer ? 'yes' : 'no'}`,
      knowledge.forbiddenMatched ? '- forbiddenRuleMatched: yes' : '',
      knowledge.summary
    ]
      .filter(Boolean)
      .join('\n')
  }

  private buildObservationInstruction(context: ReplyContext): string {
    const latest = context.latestMessage
    if (!latest) {
      return '请根据截图输出最新消息的结构化 JSON。'
    }

    return [
      '以下是程序的辅助观察结果，请结合截图使用：',
      `- 是否检测到最新消息来源: ${latest.detected ? '是' : '否'}`,
      `- 最新可见消息是否来自自己: ${latest.latestFromSelf ? '是' : '否'}`,
      `- 置信度: ${latest.confidence}`,
      latest.reason ? `- 原因: ${latest.reason}` : '',
      latest.error ? `- 检测错误: ${latest.error}` : '',
      '',
      '请继续输出结构化 JSON，不要解释。'
    ]
      .filter(Boolean)
      .join('\n')
  }

  async callText(userMessage: string): Promise<string> {
    const data = await this.callAPI([{ role: 'user', content: userMessage }])
    return this.extractText(data)
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const url = this.buildChatCompletionsUrl(this.config.baseURL)
    const startedAt = Date.now()
    const checkedAt = new Date(startedAt).toISOString()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: '请只回复“连接成功”。' }],
          thinking: { type: 'disabled' },
          stream: false
        }),
        signal: controller.signal
      })

      const latencyMs = Date.now() - startedAt
      if (!response.ok) {
        const errorText = await response.text()
        const diagnostic = analyzeCompatApiFailure(response.status, errorText)
        return {
          success: false,
          error: diagnostic.message,
          errorCategory: diagnostic.category,
          url,
          status: response.status,
          latencyMs,
          checkedAt,
          normalizedBaseURL: normalizeCompatApiRoot(this.config.baseURL, DEFAULT_BASE_URL),
          model: this.config.model
        }
      }

      const payload: unknown = await response.json()
      const preview = this.extractText(payload).trim()
      return {
        success: true,
        url,
        status: response.status,
        latencyMs,
        checkedAt,
        normalizedBaseURL: normalizeCompatApiRoot(this.config.baseURL, DEFAULT_BASE_URL),
        model: this.config.model,
        responsePreview: preview ? preview.slice(0, 120) : '连接成功'
      }
    } catch (error: unknown) {
      const message = formatUnknownError(error)
      return {
        success: false,
        error: message,
        errorCategory: classifyRuntimeErrorCategory(message),
        url,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        normalizedBaseURL: normalizeCompatApiRoot(this.config.baseURL, DEFAULT_BASE_URL),
        model: this.config.model
      }
    } finally {
      clearTimeout(timer)
    }
  }

  updateConfig(config: Partial<AIClientConfig> & { systemPrompt?: string }): void {
    super.updateConfig(config)
    if (typeof config.systemPrompt === 'string' && config.systemPrompt) {
      this.systemPrompt = config.systemPrompt
    }
  }

  private async callVision(
    systemPrompt: string,
    userText: string,
    imageBase64: string,
    timeoutMs = 30_000
  ): Promise<string> {
    const rawBase64 = this.stripBase64Prefix(imageBase64)
    const imageUrl = rawBase64.startsWith('http') ? rawBase64 : `data:image/png;base64,${rawBase64}`

    const data = await this.callAPI(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: userText }
          ]
        }
      ],
      timeoutMs
    )

    return this.extractText(data)
  }
}

export class VisionModelClient extends OpenAICompatClient {
  async detectVision(prompt: string, screenshotBase64: string, timeoutMs?: number): Promise<string> {
    const rawBase64 = this.stripBase64Prefix(screenshotBase64)
    const imageUrl = rawBase64.startsWith('http') ? rawBase64 : `data:image/png;base64,${rawBase64}`

    const data = await this.callAPI(
      [
        {
          role: 'system',
          content: '你是一个视觉分析专家。请严格按照用户要求输出检测结果。'
        },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: prompt }
          ]
        }
      ],
      timeoutMs
    )

    return this.extractText(data)
  }
}

export const DEFAULT_SYSTEM_PROMPTS = {
  reply: DEFAULT_REPLY_SYSTEM_PROMPT,
  vision: '你是一个视觉分析专家。请严格按照用户要求输出检测结果。'
} as const

function asChatCompletionResponse(value: unknown): ChatCompletionResponse | null {
  if (!value || typeof value !== 'object') return null
  return value as ChatCompletionResponse
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeCompatApiRoot(baseURL: string, fallback: string): string {
  let normalized = (baseURL.trim() || fallback).replace(/\/+$/, '')
  const lower = normalized.toLowerCase()

  for (const suffix of ['/chat/completions', '/models']) {
    if (lower.endsWith(suffix)) {
      normalized = normalized.slice(0, normalized.length - suffix.length)
      break
    }
  }

  return normalized || fallback
}

function buildCompatApiErrorMessage(status: number, rawBody: string): string {
  return analyzeCompatApiFailure(status, rawBody).message
}

function extractCompatApiErrorDetail(rawBody: string): string {
  const text = rawBody.trim()
  if (!text) return ''

  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return text.slice(0, 200)

    const directMessage =
      (typeof (parsed as { message?: unknown }).message === 'string' && (parsed as { message: string }).message) ||
      (typeof (parsed as { error?: unknown }).error === 'string' && (parsed as { error: string }).error)

    if (directMessage) return directMessage.slice(0, 200)

    const nestedError = (parsed as { error?: unknown }).error
    if (nestedError && typeof nestedError === 'object' && typeof (nestedError as { message?: unknown }).message === 'string') {
      return (nestedError as { message: string }).message.slice(0, 200)
    }
  } catch {
    return text.slice(0, 200)
  }

  return text.slice(0, 200)
}

function analyzeCompatApiFailure(
  status: number,
  rawBody: string
): { category: DiagnosticErrorCategory; message: string } {
  const detail = extractCompatApiErrorDetail(rawBody)
  const category = classifyCompatApiErrorCategory(status, detail)

  switch (category) {
    case 'auth':
      return {
        category,
        message: `401 Unauthorized. 请检查 API Key 是否正确，是否把别家平台的 Key 填到了当前 Base URL。${detail ? ` 详情: ${detail}` : ''}`
      }
    case 'permission':
      return {
        category,
        message: `403 Forbidden. 当前 Key 没有访问该模型的权限，或中转站未给这个接口放行。${detail ? ` 详情: ${detail}` : ''}`
      }
    case 'base_url':
      return {
        category,
        message: `404 Not Found. 请检查 Base URL，建议填写兼容接口根路径，例如 /v1 或 /api/v3，而不是 /models 或其他子路径。${detail ? ` 详情: ${detail}` : ''}`
      }
    case 'model':
      return {
        category,
        message: `模型不存在、不可用，或当前 Key 无法访问该模型。${detail ? ` 详情: ${detail}` : ''}`
      }
    case 'rate_limit':
      return {
        category,
        message: `429 Too Many Requests. 请求过快、额度不足，或服务商触发了限流。${detail ? ` 详情: ${detail}` : ''}`
      }
    case 'server':
      return {
        category,
        message: `服务端异常（${status}）。服务商接口当前可能不稳定。${detail ? ` 详情: ${detail}` : ''}`
      }
    default:
      return {
        category,
        message: `API request failed: ${status}${detail ? ` - ${detail}` : ''}`
      }
  }
}

function classifyCompatApiErrorCategory(status: number, detail: string): DiagnosticErrorCategory {
  const normalized = detail.toLowerCase()
  const looksLikeModelIssue =
    /model/.test(normalized) &&
    /(not found|does not exist|invalid|unsupported|unavailable|not exist|unknown)/.test(normalized)

  if (looksLikeModelIssue) return 'model'
  if (status === 401) return 'auth'
  if (status === 403) return 'permission'
  if (status === 404) return 'base_url'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  if (status === 400 && looksLikeModelIssue) return 'model'
  return 'unknown'
}

function classifyRuntimeErrorCategory(message: string): DiagnosticErrorCategory {
  const normalized = message.toLowerCase()
  if (/(timed out|timeout|aborted|超时)/.test(normalized)) return 'timeout'
  if (/(fetch failed|failed to fetch|network|econnrefused|enotfound|socket|certificate|tls)/.test(normalized)) {
    return 'network'
  }
  return 'unknown'
}

function safeJsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500)
  } catch {
    return String(value).slice(0, 500)
  }
}

type RawObservedMessage = {
  skip?: boolean
  reason?: string
  chatName?: string
  chatType?: string
  senderName?: string
  mentioned?: boolean
  direction?: string
  kind?: string
  content?: string
  summary?: string
  confidence?: number
}

function parseObservedMessage(raw: string, appType: AppType): ObservedChatMessage | null {
  const parsed = parseLooseJson(raw)
  if (!parsed) return null

  const data = parsed as RawObservedMessage
  if (data.skip === true) return null

  const confidence = normalizeConfidence(data.confidence)
  const chatName = normalizeText(data.chatName)
  const content = normalizeText(data.content)
  const summary = normalizeText(data.summary)
  const senderName = normalizeText(data.senderName)

  if (!content && !summary) return null

  return enhanceObservedMessage(appType, {
    chat: {
      id: buildObservedChatId(appType, chatName),
      name: chatName,
      type: normalizeChatType(data.chatType),
      nameSource: chatName ? 'model' : 'unknown'
    },
    direction: normalizeDirection(data.direction),
    kind: normalizeKind(data.kind),
    content,
    summary,
    senderName,
    senderNameSource: senderName ? 'model' : 'unknown',
    mentioned: typeof data.mentioned === 'boolean' ? data.mentioned : undefined,
    mentionedSource: typeof data.mentioned === 'boolean' ? 'model' : 'unknown',
    confidence,
    source: 'vision',
    raw: parsed
  })
}

function parseLooseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      const parsed = JSON.parse(match[0])
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
}

function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return 0.6
  return Math.max(0, Math.min(1, Number(numeric.toFixed(2))))
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized || undefined
}

function normalizeChatType(value: unknown): ChatType {
  return value === 'direct' ||
    value === 'group' ||
    value === 'service' ||
    value === 'official' ||
    value === 'unknown'
    ? value
    : 'unknown'
}

function normalizeDirection(value: unknown): MessageDirection {
  return value === 'self' || value === 'contact' || value === 'system' || value === 'unknown'
    ? value
    : 'unknown'
}

function normalizeKind(value: unknown): ChatMessageKind {
  return value === 'text' ||
    value === 'image' ||
    value === 'file' ||
    value === 'voice' ||
    value === 'link' ||
    value === 'quote' ||
    value === 'emoji' ||
    value === 'mixed' ||
    value === 'unknown'
    ? value
    : 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function enhanceObservedMessage(appType: AppType, message: ObservedChatMessage): ObservedChatMessage {
  const preview = messagePreview(message) || ''
  const normalizedChatName = normalizeChatName(message.chat.name)
  const inferredSender = inferSenderName(preview)
  const inferredMentioned = inferMentioned(preview)
  const strippedPreview = stripSenderPrefix(preview, inferredSender)

  const explicitSender = normalizeSenderName(message.senderName)
  const senderName = explicitSender || inferredSender
  const senderNameSource = explicitSender
    ? message.senderNameSource
    : inferredSender
      ? 'prefix'
      : message.senderNameSource
  const mentioned =
    typeof message.mentioned === 'boolean' ? message.mentioned : inferredMentioned ? true : undefined
  const mentionedSource =
    typeof message.mentioned === 'boolean'
      ? message.mentionedSource
      : inferredMentioned
        ? 'explicit'
        : message.mentionedSource

  return {
    ...message,
    chat: {
      ...message.chat,
      id: buildObservedChatId(appType, normalizedChatName || message.chat.name),
      name: normalizedChatName || message.chat.name,
      nameSource: normalizedChatName ? message.chat.nameSource : message.chat.nameSource
    },
    content: strippedPreview || message.content,
    senderName,
    senderNameSource,
    mentioned,
    mentionedSource
  }
}

function inferSenderName(text: string): string | undefined {
  const colonMatch = text.match(/^([^:：\n]{1,24})[:：]\s*/)
  const squareMatch = text.match(/^\[([^\]\n]{1,24})\]\s*/)
  const cornerMatch = text.match(/^【([^】\n]{1,24})】\s*/)
  const angleMatch = text.match(/^<([^>\n]{1,24})>\s*/)
  const replyMatch = text.match(/^([^:：\n]{1,24})\s*回复\s*([^:：\n]{1,24})[:：]\s*/)
  const sender =
    replyMatch?.[1] || cornerMatch?.[1] || squareMatch?.[1] || angleMatch?.[1] || colonMatch?.[1]
  if (!sender) return undefined
  return normalizeSenderName(sender)
}

function inferMentioned(text: string): boolean {
  return /@\S+/.test(text) || /艾特|at你|@我|@你|所有人/.test(text)
}

function stripSenderPrefix(text: string, senderName: string | undefined): string | undefined {
  if (!senderName) return undefined
  const pattern = new RegExp(
    `^(?:${escapeRegExp(senderName)}\\s*[:：]\\s*|\\[${escapeRegExp(senderName)}\\]\\s*|【${escapeRegExp(senderName)}】\\s*|<${escapeRegExp(senderName)}>\\s*|${escapeRegExp(senderName)}\\s*回复\\s*[^:：\\n]{1,24}[:：]\\s*)`
  )
  const stripped = text.replace(pattern, '').trim()
  return stripped || undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseReplyRelevanceReview(raw: string): ReplyRelevanceResult | null {
  const parsed = parseLooseJson(raw)
  if (!parsed) return null
  const allowed = parsed.allowed === true
  const reason = typeof parsed.reason === 'string' ? parsed.reason : allowed ? 'model_allow' : 'model_block'
  const score = normalizeConfidence(parsed.score)
  return {
    allowed,
    reason,
    score,
    source: 'model'
  }
}
