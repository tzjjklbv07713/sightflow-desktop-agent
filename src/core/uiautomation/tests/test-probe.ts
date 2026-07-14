import { probeUiAutomation } from '../probe'
import { extractChatMessages } from '../chat-messages'
import { observedFromUia } from '../observed-from-uia'
import { tryInspectViaUia } from '../inspect-helper'
import { AppType } from '../../rpa/types'

const VALID_APP_TYPES: AppType[] = ['wechat', 'wework', 'dingtalk', 'lark', 'slack', 'telegram', 'generic']

export async function runUiAutomationProbeTest(): Promise<void> {
  const appType = parseAppType(process.env.APP_TYPE)
  const result = await probeUiAutomation(appType)

  if (!result.ok) {
    console.log('[UIAutomation Probe] failed', {
      appType: result.appType,
      reason: result.reason,
      message: result.message
    })
    await runChatExtractorTest(appType)
    return
  }

  const textPreview = result.window.textNodes
    .map((node) => node.value || node.name)
    .filter(Boolean)
    .slice(0, 20)

  console.log('[UIAutomation Probe] success', {
    appType: result.appType,
    title: result.window.title,
    processId: result.window.processId,
    processName: result.window.processName,
    className: result.window.className,
    bounds: result.window.bounds,
    capabilities: result.capabilities,
    textNodeCount: result.window.textNodes.length,
    inputCandidateCount: result.window.inputCandidates.length,
    textPreview
  })

  if (result.window.inputCandidates.length > 0) {
    console.log(
      '[UIAutomation Probe] input candidates',
      result.window.inputCandidates.slice(0, 5)
    )
  }

  await runChatExtractorTest(appType)
  await runInspectHelperTest(appType)
}

async function runChatExtractorTest(appType: AppType): Promise<void> {
  const snapshot = await extractChatMessages(appType)
  if (!snapshot.ok) {
    console.log('[UIAutomation Chat] not available', snapshot)
    return
  }
  console.log('[UIAutomation Chat] success', {
    appType: snapshot.appType,
    total: snapshot.total,
    capturedAt: snapshot.capturedAt,
    sample: snapshot.rows.slice(0, 3).map((row) => ({
      messageId: row.messageId,
      direction: row.direction,
      senderName: row.senderName,
      textPreview: row.text.slice(0, 60)
    }))
  })

  const observed = observedFromUia(appType, snapshot, {
    chatName: process.env.SIGHTFLOW_UIA_CHAT_NAME,
    chatType: 'direct'
  })
  console.log('[UIAutomation Chat -> Observed]', {
    content: observed?.content?.slice(0, 120),
    direction: observed?.direction,
    senderName: observed?.senderName,
    messageId: observed?.messageId,
    source: observed?.source,
    confidence: observed?.confidence
  })
}

async function runInspectHelperTest(appType: AppType): Promise<void> {
  const inspection = await tryInspectViaUia(appType)
  console.log('[UIAutomation Inspect Helper]', {
    detected: inspection?.detected,
    latestFromSelf: inspection?.latestFromSelf,
    confidence: inspection?.confidence,
    bubble: inspection?.bubble
  })
}

function parseAppType(raw: string | undefined): AppType {
  return raw && VALID_APP_TYPES.includes(raw as AppType) ? (raw as AppType) : 'wechat'
}