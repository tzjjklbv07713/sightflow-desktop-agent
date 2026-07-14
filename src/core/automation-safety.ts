export type AutomationSafetyReason =
  | 'window_missing'
  | 'login_required'
  | 'risk_or_abnormal_prompt'
  | 'input_unavailable'
  | 'safety_check_failed'

export interface AutomationSafetyResult {
  safe: boolean
  reason?: AutomationSafetyReason
  message?: string
}

export const SAFE_AUTOMATION_RESULT: AutomationSafetyResult = { safe: true }

export function parseVisionSafetyResult(raw: string): AutomationSafetyResult {
  const text = raw.trim()
  const parsed = parseLooseJson(text)
  if (!parsed) {
    return {
      safe: false,
      reason: 'safety_check_failed',
      message: `安全检查返回无法解析：${text.slice(0, 120)}`
    }
  }

  const safe = parsed.safe === true
  if (safe) return SAFE_AUTOMATION_RESULT

  return {
    safe: false,
    reason: normalizeReason(parsed.reason),
    message: typeof parsed.message === 'string' ? parsed.message : undefined
  }
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

function normalizeReason(reason: unknown): AutomationSafetyReason {
  if (
    reason === 'window_missing' ||
    reason === 'login_required' ||
    reason === 'risk_or_abnormal_prompt' ||
    reason === 'input_unavailable' ||
    reason === 'safety_check_failed'
  ) {
    return reason
  }
  return 'safety_check_failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
