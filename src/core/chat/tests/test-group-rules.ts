import { enhanceObservedMessage } from '../../model-clients'
import { type ObservedChatMessage } from '../message-types'
import { messagePreview } from '../message-types'
import { AppType } from '../../rpa/types'

export async function runGroupRulesTest(): Promise<void> {
  const appType = parseAppType(process.env.APP_TYPE)
  const samples = buildSamples()

  for (const sample of samples) {
    const baseMessage: ObservedChatMessage = {
      chat: {
        id: `${appType}:current`,
        name: sample.chatName,
        type: 'group',
        nameSource: 'model'
      },
      direction: 'contact',
      kind: 'text',
      content: sample.rawText,
      senderName: sample.senderName || undefined,
      senderNameSource: sample.senderName ? 'model' : 'unknown',
      mentioned: sample.mentioned,
      mentionedSource: typeof sample.mentioned === 'boolean' ? 'model' : 'unknown',
      confidence: 0.8,
      source: 'vision'
    }

    const enhanced = enhanceObservedMessage(appType, baseMessage)
    console.log(`\n[Group Rules] sample=${sample.label}`)
    console.log('[Group Rules] input', baseMessage)
    console.log('[Group Rules] input preview', messagePreview(baseMessage))
    console.log('[Group Rules] enhanced', enhanced)
    console.log('[Group Rules] enhanced preview', messagePreview(enhanced))
  }
}

function parseAppType(raw: string | undefined): AppType {
  return raw === 'wework' ? 'wework' : 'wechat'
}

function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

function buildSamples(): Array<{
  label: string
  chatName: string
  rawText: string
  senderName: string
  mentioned: boolean | undefined
}> {
  if (process.env.SIGHTFLOW_GROUP_MESSAGE) {
    return [
      {
        label: 'custom',
        chatName: process.env.SIGHTFLOW_GROUP_CHAT_NAME || '客户支持群...',
        rawText: process.env.SIGHTFLOW_GROUP_MESSAGE,
        senderName: process.env.SIGHTFLOW_GROUP_SENDER || '',
        mentioned: parseOptionalBoolean(process.env.SIGHTFLOW_GROUP_MENTIONED)
      }
    ]
  }

  return [
    {
      label: 'colon',
      chatName: '客户支持群...',
      rawText: '张三: @我 这个订单什么时候发货？',
      senderName: '',
      mentioned: undefined
    },
    {
      label: 'square',
      chatName: 'VIP订单群（23）',
      rawText: '[李四] 这个报价还能再低一点吗？',
      senderName: '',
      mentioned: undefined
    },
    {
      label: 'corner',
      chatName: '售后处理群聊',
      rawText: '【王五】 @所有人 今天先同步一下进度',
      senderName: '',
      mentioned: undefined
    },
    {
      label: 'reply',
      chatName: '企业微信客户群...',
      rawText: '赵六 回复 小王: 这个方案可以，下午再确认',
      senderName: '',
      mentioned: undefined
    }
  ]
}
