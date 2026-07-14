import {
  AIClientConfig,
  ConnectionTestResult,
  ReplyContext,
  ReplyGenerationClient,
  ReplyModelClient,
  VisionModelClient
} from './model-clients'
import { type VisionDetectionClient } from './vision-client'

export type { AIClientConfig, ReplyContext } from './model-clients'
export { ReplyModelClient, VisionModelClient } from './model-clients'

export class AIClient implements ReplyGenerationClient, VisionDetectionClient {
  private readonly replyClient: ReplyModelClient
  private readonly visionClient: VisionModelClient

  constructor(config: Partial<AIClientConfig> & { apiKey: string; systemPrompt?: string }) {
    this.replyClient = new ReplyModelClient(config)
    this.visionClient = new VisionModelClient(config)
  }

  async getReply(screenshotBase64: string, context?: ReplyContext): Promise<string | null> {
    return this.replyClient.getReply(screenshotBase64, context)
  }

  async detectVision(prompt: string, screenshotBase64: string, timeoutMs?: number): Promise<string> {
    return this.visionClient.detectVision(prompt, screenshotBase64, timeoutMs)
  }

  async callText(userMessage: string): Promise<string> {
    return this.replyClient.callText(userMessage)
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return this.replyClient.testConnection()
  }

  updateConfig(config: Partial<AIClientConfig> & { systemPrompt?: string }): void {
    this.replyClient.updateConfig(config)
    this.visionClient.updateConfig(config)
  }

  getApiKey(): string {
    return this.replyClient.getApiKey()
  }
}
