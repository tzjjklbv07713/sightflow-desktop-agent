import { execFile } from 'node:child_process'
import { AppType } from '../rpa/types'

export type UiAutomationProbeReason =
  | 'unsupported_platform'
  | 'window_not_found'
  | 'uia_probe_failed'
  | 'invalid_probe_result'

export interface UiAutomationRect {
  x: number
  y: number
  width: number
  height: number
}

export interface UiAutomationTextNode {
  name: string
  value?: string
  controlType?: string
  automationId?: string
  className?: string
  bounds?: UiAutomationRect | null
}

export interface UiAutomationInputCandidate {
  name: string
  value?: string
  controlType?: string
  automationId?: string
  className?: string
  bounds?: UiAutomationRect | null
}

export interface UiAutomationWindowSnapshot {
  title: string
  processId: number
  processName?: string
  className?: string
  nativeWindowHandle?: number
  bounds?: UiAutomationRect | null
  textNodes: UiAutomationTextNode[]
  inputCandidates: UiAutomationInputCandidate[]
}

export interface UiAutomationProbeCapabilities {
  windowFound: boolean
  textReadable: boolean
  inputDetectable: boolean
}

export type UiAutomationProbeResult =
  | {
      ok: true
      appType: AppType
      capturedAt: number
      capabilities: UiAutomationProbeCapabilities
      window: UiAutomationWindowSnapshot
    }
  | {
      ok: false
      appType: AppType
      reason: UiAutomationProbeReason
      message: string
    }

interface RawProbeResult {
  ok?: boolean
  reason?: string
  message?: string
  window?: UiAutomationWindowSnapshot
}

const MAX_STDOUT_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 8000

export async function probeUiAutomation(
  appType: AppType,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<UiAutomationProbeResult> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      appType,
      reason: 'unsupported_platform',
      message: 'UIAutomation 探针当前仅支持 Windows'
    }
  }

  try {
    const raw = await runPowerShellProbe(appType, timeoutMs)
    const parsed = parseProbeJson(raw)
    if (!parsed) {
      return {
        ok: false,
        appType,
        reason: 'invalid_probe_result',
        message: `UIAutomation 探针返回无法解析：${raw.slice(0, 300)}`
      }
    }

    if (!parsed.ok) {
      return {
        ok: false,
        appType,
        reason: normalizeReason(parsed.reason),
        message: parsed.message || 'UIAutomation 探针失败'
      }
    }

    if (!parsed.window || typeof parsed.window.title !== 'string') {
      return {
        ok: false,
        appType,
        reason: 'invalid_probe_result',
        message: 'UIAutomation 探针结果缺少窗口信息'
      }
    }

    const window = normalizeWindowSnapshot(parsed.window)
    return {
      ok: true,
      appType,
      capturedAt: Date.now(),
      capabilities: {
        windowFound: true,
        textReadable: window.textNodes.length > 0,
        inputDetectable: window.inputCandidates.length > 0
      },
      window
    }
  } catch (error: unknown) {
    return {
      ok: false,
      appType,
      reason: 'uia_probe_failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function runPowerShellProbe(appType: AppType, timeoutMs: number): Promise<string> {
  const script = buildProbeScript(appType)
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64')

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_STDOUT_BYTES,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() || error.message
          reject(new Error(detail))
          return
        }
        resolve(stdout.trim())
      }
    )
  })
}

function buildProbeScript(appType: AppType): string {
  const safeAppType = appType === 'wework' ? 'wework' : 'wechat'
  return `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$appType = '${safeAppType}'

function Write-JsonResult($value) {
  $value | ConvertTo-Json -Depth 8 -Compress
}

function Convert-Rect($rect) {
  if ($null -eq $rect -or $rect.IsEmpty) { return $null }
  return @{
    x = [int][Math]::Round($rect.X)
    y = [int][Math]::Round($rect.Y)
    width = [int][Math]::Round($rect.Width)
    height = [int][Math]::Round($rect.Height)
  }
}

function Control-TypeName($controlType) {
  if ($null -eq $controlType) { return $null }
  return [string]$controlType.ProgrammaticName -replace '^ControlType\\.', ''
}

function Read-Value($element) {
  try {
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      return [string]$pattern.Current.Value
    }
  } catch {}
  return $null
}

function Element-Row($element) {
  return @{
    name = [string]$element.Current.Name
    value = Read-Value $element
    controlType = Control-TypeName $element.Current.ControlType
    automationId = [string]$element.Current.AutomationId
    className = [string]$element.Current.ClassName
    bounds = Convert-Rect $element.Current.BoundingRectangle
  }
}

function Window-Score($element, $procName, $tokens) {
  $title = [string]$element.Current.Name
  $className = [string]$element.Current.ClassName
  $score = 0

  foreach ($token in $tokens) {
    if ($title -eq $token) { $score += 120 }
    elseif ($title -like "*$token*") { $score += 90 }
    if ($procName -like "*$token*") { $score += 35 }
    if ($className -like "*$token*") { $score += 10 }
  }

  if ($title.Trim().Length -gt 0) { $score += 10 }
  if ($title -match '图片|视频|Image|Video|VLC|Direct3D') { $score -= 70 }

  $rect = $element.Current.BoundingRectangle
  if ($null -ne $rect -and -not $rect.IsEmpty) {
    if ($rect.Width -ge 600 -and $rect.Height -ge 500) { $score += 8 }
    if ($rect.Width -lt 260 -or $rect.Height -lt 220) { $score -= 20 }
  }

  return $score
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  $wechatTokens = @('微信', 'WeChat', 'Weixin')
  $weworkTokens = @('企业微信', 'WXWork', 'WeCom')
  $tokens = if ($appType -eq 'wework') { $weworkTokens } else { $wechatTokens }

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $candidates = New-Object System.Collections.ArrayList

  foreach ($child in $children) {
    $title = [string]$child.Current.Name
    $className = [string]$child.Current.ClassName
    $processId = [int]$child.Current.ProcessId
    $procName = ''
    try { $procName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch {}

    $haystack = "$title $className $procName"
    $matchedToken = $false
    foreach ($token in $tokens) {
      if ($haystack -like "*$token*") {
        $matchedToken = $true
        break
      }
    }
    if ($matchedToken) {
      [void]$candidates.Add([pscustomobject]@{
        element = $child
        processName = $procName
        score = Window-Score $child $procName $tokens
      })
    }
  }

  if ($candidates.Count -eq 0) {
    Write-JsonResult @{
      ok = $false
      reason = 'window_not_found'
      message = "未找到目标窗口：$appType"
    }
    exit 0
  }

  $selected = $candidates | Sort-Object -Property @{ Expression = 'score'; Descending = $true } | Select-Object -First 1
  $matched = $selected.element
  $processName = $selected.processName

  $descendants = $matched.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $textNodes = New-Object System.Collections.ArrayList
  $inputCandidates = New-Object System.Collections.ArrayList
  $seenText = @{}
  $limit = [Math]::Min($descendants.Count, 240)

  for ($i = 0; $i -lt $limit; $i++) {
    $element = $descendants.Item($i)
    $row = Element-Row $element
    $text = @($row.name, $row.value) -join ' '
    $text = $text.Trim()
    if ($text.Length -gt 0 -and -not $seenText.ContainsKey($text)) {
      $seenText[$text] = $true
      [void]$textNodes.Add($row)
    }

    if ($row.controlType -eq 'Edit' -or $row.className -match 'Edit|RichEdit|Input') {
      [void]$inputCandidates.Add($row)
    }

    if ($textNodes.Count -ge 80 -and $inputCandidates.Count -ge 8) { break }
  }

  Write-JsonResult @{
    ok = $true
    window = @{
      title = [string]$matched.Current.Name
      processId = [int]$matched.Current.ProcessId
      processName = $processName
      className = [string]$matched.Current.ClassName
      nativeWindowHandle = [int]$matched.Current.NativeWindowHandle
      bounds = Convert-Rect $matched.Current.BoundingRectangle
      score = [int]$selected.score
      textNodes = @($textNodes | Select-Object -First 80)
      inputCandidates = @($inputCandidates | Select-Object -First 12)
    }
  }
} catch {
  Write-JsonResult @{
    ok = $false
    reason = 'uia_probe_failed'
    message = $_.Exception.Message
  }
}
`
}

function parseProbeJson(raw: string): RawProbeResult | null {
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as RawProbeResult) : null
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      const parsed = JSON.parse(match[0])
      return isRecord(parsed) ? (parsed as RawProbeResult) : null
    } catch {
      return null
    }
  }
}

function normalizeReason(reason: unknown): UiAutomationProbeReason {
  if (
    reason === 'unsupported_platform' ||
    reason === 'window_not_found' ||
    reason === 'uia_probe_failed' ||
    reason === 'invalid_probe_result'
  ) {
    return reason
  }
  return 'uia_probe_failed'
}

function normalizeWindowSnapshot(window: UiAutomationWindowSnapshot): UiAutomationWindowSnapshot {
  return {
    title: String(window.title || ''),
    processId: Number(window.processId || 0),
    processName: typeof window.processName === 'string' ? window.processName : undefined,
    className: typeof window.className === 'string' ? window.className : undefined,
    nativeWindowHandle: Number.isFinite(Number(window.nativeWindowHandle))
      ? Number(window.nativeWindowHandle)
      : undefined,
    bounds: normalizeRect(window.bounds),
    textNodes: Array.isArray(window.textNodes) ? window.textNodes.map(normalizeTextNode) : [],
    inputCandidates: Array.isArray(window.inputCandidates)
      ? window.inputCandidates.map(normalizeInputCandidate)
      : []
  }
}

function normalizeTextNode(node: UiAutomationTextNode): UiAutomationTextNode {
  return {
    name: String(node?.name || ''),
    value: typeof node?.value === 'string' ? node.value : undefined,
    controlType: typeof node?.controlType === 'string' ? node.controlType : undefined,
    automationId: typeof node?.automationId === 'string' ? node.automationId : undefined,
    className: typeof node?.className === 'string' ? node.className : undefined,
    bounds: normalizeRect(node?.bounds)
  }
}

function normalizeInputCandidate(node: UiAutomationInputCandidate): UiAutomationInputCandidate {
  return normalizeTextNode(node)
}

function normalizeRect(rect: unknown): UiAutomationRect | null {
  if (!isRecord(rect)) return null
  const x = Number(rect.x)
  const y = Number(rect.y)
  const width = Number(rect.width)
  const height = Number(rect.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  return { x, y, width, height }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
