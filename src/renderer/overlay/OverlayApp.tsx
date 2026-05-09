import { useEffect, useMemo, useRef, useState } from 'react'

type WizardStepKey = 'contactList' | 'chatMain' | 'inputBox' | 'unreadIndicator'

interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

interface BoxRegions {
  contactList: ScreenRect
  chatMain: ScreenRect
  inputBox: ScreenRect
  unreadIndicator: ScreenRect | null
  displayId?: number
  scaleFactor?: number
  capturedAt: number
}

interface InitPayload {
  id: string
  appType: string
  steps: WizardStepKey[]
  prefill: Partial<BoxRegions> | null
  display: {
    id: number
    bounds: { x: number; y: number; width: number; height: number }
    scaleFactor: number
  }
}

const STEP_TITLE: Record<WizardStepKey, string> = {
  contactList: '联系人 / 会话列表',
  chatMain: '会话主区域',
  inputBox: '消息输入框',
  unreadIndicator: '未读红点区域（可跳过）'
}

const STEP_HINT: Record<WizardStepKey, string> = {
  contactList: '框选你想监控的会话列表区域，例如左侧最近聊天列表。',
  chatMain: '框选当前对话窗口（消息显示区），用来检测是否有新内容。',
  inputBox: '框选回复时要输入文字的输入框，越精确越好。',
  unreadIndicator:
    '可选：框选未读消息红点常出现的位置，可显著提升识别精度。如果该 App 用蓝点或数字徽章，可跳过。'
}

const MIN_DRAG_PX = 6

interface PointerState {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
}

function rectFromPointer(p: PointerState): ScreenRect {
  const left = Math.min(p.startX, p.currentX)
  const top = Math.min(p.startY, p.currentY)
  const width = Math.abs(p.currentX - p.startX)
  const height = Math.abs(p.currentY - p.startY)
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(width),
    height: Math.round(height)
  }
}

declare global {
  interface Window {
    electron?: {
      on: (channel: string, callback: (...args: unknown[]) => void) => () => void
      send: (channel: string, ...args: unknown[]) => void
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    }
  }
}

export function OverlayApp(): React.ReactElement {
  const [init, setInit] = useState<InitPayload | null>(null)
  const [stepIdx, setStepIdx] = useState(0)
  const [pointer, setPointer] = useState<PointerState | null>(null)
  const [committed, setCommitted] = useState<Partial<Record<WizardStepKey, ScreenRect>>>({})
  const cancelArmedRef = useRef(false)

  useEffect(() => {
    const cleanup = window.electron?.on('overlay-wizard:init', (payload) => {
      setInit(payload as InitPayload)
      setStepIdx(0)
      setCommitted({})
    })
    return cleanup
  }, [])

  const steps = init?.steps ?? []
  const currentStep = steps[stepIdx]
  const total = steps.length

  // Cancellation: first Esc cancels current draft if drawing; otherwise cancels the whole wizard.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape' || !init) return
      if (pointer) {
        setPointer(null)
        cancelArmedRef.current = false
        return
      }
      if (cancelArmedRef.current) {
        window.electron?.send('overlay-wizard:cancel', { id: init.id })
      } else {
        cancelArmedRef.current = true
        window.setTimeout(() => {
          cancelArmedRef.current = false
        }, 1500)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [init, pointer])

  function toAbsolute(rect: ScreenRect): ScreenRect {
    if (!init) return rect
    return {
      x: rect.x + init.display.bounds.x,
      y: rect.y + init.display.bounds.y,
      width: rect.width,
      height: rect.height
    }
  }

  function commitStep(key: WizardStepKey, rect: ScreenRect | null): void {
    setCommitted((prev) => ({ ...prev, [key]: rect ?? undefined }))
  }

  function advanceOrFinish(
    nextIdx: number,
    draft: Partial<Record<WizardStepKey, ScreenRect>>
  ): void {
    if (!init) return
    if (nextIdx < total) {
      setStepIdx(nextIdx)
      return
    }
    const regions: BoxRegions = {
      contactList: toAbsolute(draft.contactList!),
      chatMain: toAbsolute(draft.chatMain!),
      inputBox: toAbsolute(draft.inputBox!),
      unreadIndicator: draft.unreadIndicator ? toAbsolute(draft.unreadIndicator) : null,
      displayId: init.display.id,
      scaleFactor: init.display.scaleFactor,
      capturedAt: Date.now()
    }
    window.electron?.send('overlay-wizard:complete', { id: init.id, regions })
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (!currentStep) return
    if (e.button !== 0) return
    const x = e.clientX
    const y = e.clientY
    setPointer({ pointerId: e.pointerId, startX: x, startY: y, currentX: x, currentY: y })
    if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (!pointer || pointer.pointerId !== e.pointerId) return
    setPointer({ ...pointer, currentX: e.clientX, currentY: e.clientY })
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    if (!pointer || pointer.pointerId !== e.pointerId) return
    const final = rectFromPointer(pointer)
    setPointer(null)
    if (!currentStep) return
    if (final.width < MIN_DRAG_PX || final.height < MIN_DRAG_PX) {
      // too small → treat as cancel of this step only
      return
    }
    const next = { ...committed, [currentStep]: final }
    commitStep(currentStep, final)
    advanceOrFinish(stepIdx + 1, next)
  }

  function onSkip(): void {
    if (!currentStep || currentStep !== 'unreadIndicator') return
    const next = { ...committed, unreadIndicator: undefined }
    setCommitted(next)
    advanceOrFinish(stepIdx + 1, next)
  }

  function onAbort(): void {
    if (!init) return
    window.electron?.send('overlay-wizard:cancel', { id: init.id })
  }

  function onBack(): void {
    if (stepIdx === 0 || !currentStep) return
    const previousStepKey = steps[stepIdx - 1]
    setCommitted((prev) => {
      const next = { ...prev }
      delete next[previousStepKey]
      return next
    })
    setStepIdx(stepIdx - 1)
  }

  const liveRect = useMemo(() => (pointer ? rectFromPointer(pointer) : null), [pointer])

  if (!init || !currentStep) {
    return (
      <div className="overlay">
        <div className="overlay__header">
          <span className="overlay__hint">正在加载框选向导...</span>
        </div>
      </div>
    )
  }

  const showSkip = currentStep === 'unreadIndicator'

  return (
    <div
      className="overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="overlay__header">
        <span className="overlay__step">
          步骤 {stepIdx + 1} / {total}
        </span>
        <span className="overlay__hint">
          <strong>{STEP_TITLE[currentStep]}</strong>
          {' — '}
          {STEP_HINT[currentStep]}
        </span>
        <div className="overlay__actions">
          {stepIdx > 0 && (
            <button className="overlay__btn" onClick={onBack}>
              上一步
            </button>
          )}
          {showSkip && (
            <button className="overlay__btn" onClick={onSkip}>
              跳过此步
            </button>
          )}
          <button className="overlay__btn" onClick={onAbort}>
            取消
          </button>
        </div>
      </div>

      {/* committed rects from previous steps */}
      {(Object.keys(committed) as WizardStepKey[]).map((key) => {
        const rect = committed[key]
        if (!rect) return null
        return (
          <div
            key={key}
            className="overlay__committed"
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
          >
            <span className="overlay__committed-label">{STEP_TITLE[key]}</span>
          </div>
        )
      })}

      {/* live drag rect */}
      {liveRect && (
        <div
          className="overlay__rect"
          style={{
            left: liveRect.x,
            top: liveRect.y,
            width: liveRect.width,
            height: liveRect.height
          }}
        />
      )}

      <div className="overlay__footer">
        提示：拖动鼠标框出区域；松开提交，按 Esc 取消，连按两次 Esc 退出向导。
      </div>
    </div>
  )
}
