import { probeHybridPerception } from '../hybrid-perception'
import { AppType } from '../../rpa/types'

const VALID_APP_TYPES: AppType[] = ['wechat', 'wework', 'dingtalk', 'lark', 'slack', 'telegram', 'generic']

export async function runHybridPerceptionTest(): Promise<void> {
  const appType = parseAppType(process.env.APP_TYPE)
  const result = await probeHybridPerception(appType, { includeScreenshot: true })

  console.log('[Hybrid Perception] result', {
    appType: result.appType,
    source: result.source,
    title: result.title,
    processName: result.processName,
    bounds: result.bounds,
    scaleFactor: result.scaleFactor,
    capabilities: result.capabilities,
    hasScreenshot: Boolean(result.screenshot),
    reason: result.reason,
    message: result.message
  })
}

function parseAppType(raw: string | undefined): AppType {
  return raw && VALID_APP_TYPES.includes(raw as AppType) ? (raw as AppType) : 'wechat'
}
