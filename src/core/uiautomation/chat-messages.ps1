# SightFlow UIAutomation chat message extractor (Windows only)
# Reads chat bubble rows from the active WeChat / WeWork window using the
# Windows UIAutomation API and emits them as JSON for the host process.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('wechat', 'wework')]
  [string] $appType,
  [int] $maxRows = 24
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-JsonResult($value) {
  $value | ConvertTo-Json -Depth 6 -Compress
}

function Convert-Rect($rect) {
  if ($null -eq $rect -or $rect.IsEmpty) { return $null }
  return @{
    x      = [int][Math]::Round($rect.X)
    y      = [int][Math]::Round($rect.Y)
    width  = [int][Math]::Round($rect.Width)
    height = [int][Math]::Round($rect.Height)
  }
}

function Control-TypeName($controlType) {
  if ($null -eq $controlType) { return $null }
  return [string]$controlType.ProgrammaticName -replace '^ControlType\.', ''
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  $wechatTokens = @('WeChat', 'Weixin', 'wx')
  $weworkTokens = @('WXWork', 'WeCom')
  $tokens = if ($appType -eq 'wework') { $weworkTokens } else { $wechatTokens }

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $candidates = New-Object System.Collections.ArrayList

  foreach ($child in $children) {
    $title = [string]$child.Current.Name
    $className = [string]$child.Current.ClassName
    $haystack = "$title $className"
    foreach ($token in $tokens) {
      if ($haystack -like "*$token*") {
        [void]$candidates.Add($child)
        break
      }
    }
  }

  if ($candidates.Count -eq 0) {
    Write-JsonResult @{ ok = $false; reason = 'no_chat_pane'; message = 'No target window found' }
    exit 0
  }

  $matched = $candidates[0]
  $descendants = $matched.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )

  $bestPane = $null
  $bestArea = 0
  $listControlType = [System.Windows.Automation.ControlType]::List
  foreach ($d in $descendants) {
    if ($d.Current.ControlType -ne $listControlType) { continue }
    $r = $d.Current.BoundingRectangle
    if ($null -eq $r -or $r.IsEmpty) { continue }
    $area = [int]$r.Width * [int]$r.Height
    if ($area -gt $bestArea -and $r.Width -ge 220 -and $r.Height -ge 200) {
      $bestArea = $area
      $bestPane = $d
    }
  }

  if ($null -eq $bestPane) {
    Write-JsonResult @{ ok = $false; reason = 'no_chat_pane'; message = 'No List control found in window' }
    exit 0
  }

  $paneRect = $bestPane.Current.BoundingRectangle
  $chatCenterX = [int]([Math]::Round($paneRect.X + $paneRect.Width / 2))

  $children = $bestPane.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )

  $rows = New-Object System.Collections.ArrayList
  foreach ($child in $children) {
    $rowRect = $child.Current.BoundingRectangle
    if ($null -eq $rowRect -or $rowRect.IsEmpty) { continue }
    if ($rowRect.Width -lt 30 -or $rowRect.Height -lt 18) { continue }

    $text = ([string]$child.Current.Name).Trim()
    $autoId = [string]$child.Current.AutomationId
    $cls = [string]$child.Current.ClassName
    $ctrl = Control-TypeName $child.Current.ControlType
    $runtimeId = ($child.GetRuntimeId() -join '-')

    $rowX = [int]([Math]::Round($rowRect.X))
    $rowW = [int]$rowRect.Width
    $rowCenterX = $rowX + [int]([Math]::Round($rowW / 2))
    $offset = $rowCenterX - $chatCenterX
    $direction = 'unknown'
    if ($offset -gt 24) { $direction = 'self' }
    elseif ($offset -lt -24) { $direction = 'contact' }

    [void]$rows.Add(@{
      text         = $text
      senderName   = ''
      direction    = $direction
      automationId = $autoId
      runtimeId    = $runtimeId
      className    = $cls
      controlType  = $ctrl
      centerOffset = $offset
      bounds       = Convert-Rect $rowRect
    })
    if ($rows.Count -ge $maxRows) { break }
  }

  Write-JsonResult @{
    ok          = $true
    paneBounds  = Convert-Rect $paneRect
    chatCenterX = $chatCenterX
    rows        = @($rows)
  }
} catch {
  Write-JsonResult @{
    ok     = $false
    reason = 'uia_probe_failed'
    message = $_.Exception.Message
  }
}