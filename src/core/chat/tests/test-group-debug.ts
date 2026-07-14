import { readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ReplyModelClient } from '../../reply-client'
import { DEFAULT_REPLY_POLICY_CONFIG, ReplyPolicy } from '../reply-policy'
import { assessReplyRelevance } from '../../reply-relevance'
import { buildChatNameCandidates, normalizeChatName, messagePreview } from '../message-types'
import { AppType } from '../../rpa/types'

export async function runGroupDebugTest(): Promise<void> {
  const appType = parseAppType(process.env.APP_TYPE)
  const screenshot = await loadScreenshotBase64(appType)
  if (!screenshot) {
    console.log(
      '[Group Debug] skipped: missing screenshot. Set SIGHTFLOW_SCREENSHOT_PATH or run a normal provider flow first.'
    )
    return
  }
  const client = new ReplyModelClient({
    apiKey: process.env.SIGHTFLOW_REPLY_API_KEY || '',
    model: process.env.SIGHTFLOW_REPLY_MODEL || 'doubao-seed-2-0-lite-260215',
    baseURL: process.env.SIGHTFLOW_REPLY_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
  })

  if (!client.getApiKey()) {
    console.log('[Group Debug] skipped: missing SIGHTFLOW_REPLY_API_KEY')
    return
  }

  const observedMessage = await client.inspectObservedMessage(screenshot, appType, {})
  console.log('[Group Debug] observed message', observedMessage)

  if (!observedMessage) {
    console.log('[Group Debug] no observed message')
    return
  }

  const whitelist = normalizeList(process.env.SIGHTFLOW_GROUP_WHITELIST || '')
  const keywords = normalizeList(process.env.SIGHTFLOW_GROUP_KEYWORDS || '')
  const policy = new ReplyPolicy({
    ...DEFAULT_REPLY_POLICY_CONFIG,
    groupReplyMode: 'mention-or-keyword',
    groupWhitelist: whitelist,
    groupTriggerKeywords: keywords
  })

  const reply = (await client.getReply(screenshot, { observedMessage })) || '[SKIP]'
  const decision = policy.evaluate({
    appType,
    replyText: reply,
    observedMessage
  })
  const relevance = reply === '[SKIP]' ? null : assessReplyRelevance(observedMessage, reply)

  console.log('[Group Debug] summary', {
    appType,
    chatName: observedMessage.chat.name,
    normalizedChatName: normalizeChatName(observedMessage.chat.name),
    chatNameCandidates: buildChatNameCandidates(observedMessage.chat.name),
    chatNameSource: observedMessage.chat.nameSource,
    chatType: observedMessage.chat.type,
    senderName: observedMessage.senderName,
    senderNameSource: observedMessage.senderNameSource,
    mentioned: observedMessage.mentioned,
    mentionedSource: observedMessage.mentionedSource,
    whitelisted: observedMessage.chat.whitelisted,
    preview: messagePreview(observedMessage),
    reply,
    policyDecision: decision,
    relevance,
    whitelist,
    keywords
  })
}

async function loadScreenshotBase64(appType: AppType): Promise<string | null> {
  const preferredPath = process.env.SIGHTFLOW_SCREENSHOT_PATH
  const fallbackPath = path.join(
    os.tmpdir(),
    'sightflow-desktop-agent',
    'provider-inputs',
    `latest-${appType}.png`
  )
  const targetPath = preferredPath || fallbackPath
  try {
    const buffer = await readFile(targetPath)
    return `data:image/png;base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

function normalizeList(raw: string): string[] {
  return raw
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseAppType(raw: string | undefined): AppType {
  return raw === 'wework' ? 'wework' : 'wechat'
}
