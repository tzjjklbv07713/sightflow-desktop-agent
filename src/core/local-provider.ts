import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type ObservedChatMessage } from './chat/message-types'
import { AIClientConfig, ConnectionTestResult, ReplyModelClient } from './reply-client'
import { assessReplyRelevance, mergeReplyRelevance, shouldRunModelRelevanceReview } from './reply-relevance'
import { cropLatestMessageFocusScreenshot } from './rpa/screenshot-utils'
import { ProviderAdapter, ProviderEvent, ProviderInput } from './session-types'

export interface LocalProviderConfig {
  ai: Partial<AIClientConfig> & { apiKey: string }
}

interface ParsedScreenshot {
  buffer: Buffer
  mimeType: string
  extension: string
}

export class LocalProvider implements ProviderAdapter {
  private replyClient: ReplyModelClient

  constructor(config: LocalProviderConfig) {
    this.replyClient = new ReplyModelClient(config.ai)
  }

  async *run(input: ProviderInput): AsyncIterable<ProviderEvent> {
    if (!input.screenshot) {
      yield { type: 'skip' }
      return
    }

    yield { type: 'thinking', content: '正在分析聊天内容...' }
    const focusScreenshot = this.buildFocusScreenshot(input)
    const observedMessage = await this.inspectObservedMessageBestEffort(input, focusScreenshot)
    const replyContext = {
      ...(input.replyContext || {}),
      observedMessage: observedMessage ?? input.replyContext?.observedMessage ?? null
    }

    await this.persistDebugInput({
      ...input,
      replyContext
    })
    if (observedMessage) {
      yield { type: 'observed_message', message: observedMessage }
    }

    try {
      const reply = await this.replyClient.getReply(focusScreenshot, replyContext)

      if (!reply) {
        yield { type: 'skip' }
        return
      }

      const heuristic = assessReplyRelevance(replyContext.observedMessage, reply)
      const reviewed = await this.reviewReplyRelevanceBestEffort(replyContext.observedMessage, reply, heuristic)
      const relevance = mergeReplyRelevance(heuristic, reviewed)

      yield { type: 'reply_relevance', result: relevance, replyText: reply }
      if (!relevance.allowed) {
        console.warn('[LocalProvider] 回复相关性拦截', {
          reason: relevance.reason,
          score: relevance.score,
          reply
        })
        yield { type: 'skip' }
        return
      }

      yield { type: 'reply_text', content: reply }
    } catch (error: unknown) {
      yield {
        type: 'error',
        error: formatUnknownError(error) || 'Provider 调用失败'
      }
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return this.replyClient.testConnection()
  }

  updateConfig(config: Partial<AIClientConfig>): void {
    this.replyClient.updateConfig(config)
  }

  private buildFocusScreenshot(input: ProviderInput): string {
    const latestMessage = input.replyContext?.latestMessage
    if (latestMessage?.latestFromSelf && latestMessage.confidence >= 0.55) {
      return input.screenshot
    }

    return cropLatestMessageFocusScreenshot(input.screenshot, latestMessage?.bubble) || input.screenshot
  }

  private async inspectObservedMessageBestEffort(input: ProviderInput, focusScreenshot: string) {
    try {
      const latestMessage = input.replyContext?.latestMessage
      if (latestMessage?.latestFromSelf && latestMessage.confidence >= 0.55) {
        console.log('[LocalProvider] 最新可见消息已判定为自己，跳过结构化消息提取')
        return null
      }

      if (focusScreenshot !== input.screenshot) {
        console.log('[LocalProvider] 结构化消息提取使用最新消息局部截图')
      }

      return await this.replyClient.inspectObservedMessage(
        focusScreenshot,
        input.appType,
        input.replyContext
      )
    } catch (error: unknown) {
      console.warn('[LocalProvider] 结构化消息提取失败，降级为原始回复流程:', formatUnknownError(error))
      return null
    }
  }

  private async reviewReplyRelevanceBestEffort(
    observedMessage: ObservedChatMessage | null | undefined,
    replyText: string,
    heuristic: ReturnType<typeof assessReplyRelevance>
  ) {
    if (!observedMessage) {
      return null
    }

    if (!shouldRunModelRelevanceReview(heuristic, observedMessage, replyText)) {
      return null
    }

    try {
      return await this.replyClient.reviewReplyRelevance(observedMessage, replyText)
    } catch (error: unknown) {
      console.warn('[LocalProvider] 回复相关性模型复核失败，回退启发式判断:', formatUnknownError(error))
      return null
    }
  }

  private async persistDebugInput(input: ProviderInput): Promise<void> {
    try {
      const parsed = this.parseScreenshotData(input.screenshot)
      if (!parsed) {
        console.warn('[LocalProvider] 未能解析 provider 输入截图，跳过落盘')
        return
      }

      const debugDir = path.join(os.tmpdir(), 'sightflow-desktop-agent', 'provider-inputs')
      await mkdir(debugDir, { recursive: true })

      const stamp = this.createTimestamp()
      const baseName = `${stamp}-${input.appType}`
      const imagePath = path.join(debugDir, `${baseName}.${parsed.extension}`)
      const metaPath = path.join(debugDir, `${baseName}.json`)
      const latestImagePath = path.join(debugDir, `latest-${input.appType}.${parsed.extension}`)
      const latestMetaPath = path.join(debugDir, `latest-${input.appType}.json`)

      const metadata = {
        savedAt: new Date().toISOString(),
        appType: input.appType,
        currentContact: input.currentContact ?? null,
        ocrText: input.ocrText ?? null,
        replyContext: input.replyContext ?? null,
        mimeType: parsed.mimeType,
        imageBytes: parsed.buffer.length,
        imagePath
      }

      await writeFile(imagePath, parsed.buffer)
      await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
      await writeFile(latestImagePath, parsed.buffer)
      await writeFile(latestMetaPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

      console.log(
        `[LocalProvider] 模型输入截图已保存: ${imagePath} (${parsed.buffer.length} bytes, mime=${parsed.mimeType})`
      )
      console.log(`[LocalProvider] 模型输入元数据已保存: ${metaPath}`)
      console.log(`[LocalProvider] 当前最新截图快捷路径: ${latestImagePath}`)
    } catch (error: unknown) {
      console.error('[LocalProvider] 保存模型输入截图失败:', error)
    }
  }

  private parseScreenshotData(screenshot: string): ParsedScreenshot | null {
    const dataUrlMatch = screenshot.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
    if (dataUrlMatch) {
      const mimeType = dataUrlMatch[1]
      const base64 = dataUrlMatch[2]
      const extension = this.mimeTypeToExtension(mimeType)
      return {
        buffer: Buffer.from(base64, 'base64'),
        mimeType,
        extension
      }
    }

    if (!screenshot.trim()) {
      return null
    }

    return {
      buffer: Buffer.from(screenshot, 'base64'),
      mimeType: 'image/png',
      extension: 'png'
    }
  }

  private mimeTypeToExtension(mimeType: string): string {
    switch (mimeType) {
      case 'image/jpeg':
        return 'jpg'
      case 'image/webp':
        return 'webp'
      default:
        return 'png'
    }
  }

  private createTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-')
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
