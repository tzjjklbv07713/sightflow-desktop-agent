import { useCallback, useEffect, useMemo, useState } from 'react'

interface OnboardingStatus {
  completed: boolean
  completedAt: string | null
}

interface StepProps {
  onNext: () => void
  onBack?: () => void
}

const IM_OPTIONS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'wechat', label: 'WeChat (Windows)', hint: 'Recommended for private-domain support on Windows.' },
  { id: 'wework', label: 'WeCom', hint: 'For corporate private-domain conversations.' },
  { id: 'generic', label: 'Other IM', hint: 'Bring your own IM via generic capture.' }
]

const PROVIDER_OPTIONS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'doubao', label: 'Built-in Doubao', hint: 'Zero-config default, no manifest URL required.' },
  { id: 'openai', label: 'OpenAI-compatible', hint: 'Paste a manifest.json URL during the next step.' }
]

function StepHeader(props: { index: number; total: number; title: string; subtitle: string }): React.JSX.Element {
  return (
    <header className="wizard__header">
      <div className="wizard__progress">
        Step {props.index} / {props.total}
      </div>
      <h2 className="wizard__title">{props.title}</h2>
      <p className="wizard__subtitle">{props.subtitle}</p>
    </header>
  )
}

function StepSelectIM(props: { value: string; onChange: (v: string) => void } & StepProps): React.JSX.Element {
  return (
    <div className="wizard__step">
      <StepHeader
        index={1}
        total={4}
        title="Pick the IM to drive"
        subtitle="We will tune capture and reply flow to the target instant messenger."
      />
      <div className="wizard__options">
        {IM_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={'wizard__option' + (props.value === opt.id ? ' wizard__option--active' : '')}
            onClick={() => {
              props.onChange(opt.id)
            }}
          >
            <span className="wizard__option-label">{opt.label}</span>
            <span className="wizard__option-hint">{opt.hint}</span>
          </button>
        ))}
      </div>
      <div className="wizard__actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={props.onNext}
          disabled={!props.value}
        >
          Continue
        </button>
      </div>
    </div>
  )
}

function StepProvider(props: {
  imValue: string
  provider: string
  onChange: (v: string) => void
  apiKey: string
  onApiKeyChange: (v: string) => void
  baseUrl: string
  onBaseUrlChange: (v: string) => void
} & StepProps): React.JSX.Element {
  return (
    <div className="wizard__step">
      <StepHeader
        index={2}
        total={4}
        title="Configure a chat provider"
        subtitle="Vision + reply models will use this provider. Built-in Doubao is the safest default."
      />
      <div className="wizard__options wizard__options--compact">
        {PROVIDER_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={'wizard__option' + (props.provider === opt.id ? ' wizard__option--active' : '')}
            onClick={() => props.onChange(opt.id)}
          >
            <span className="wizard__option-label">{opt.label}</span>
            <span className="wizard__option-hint">{opt.hint}</span>
          </button>
        ))}
      </div>
      <div className="wizard__form">
        <label className="form-group">
          <span className="form-label">API key</span>
          <input
            type="password"
            className="form-input"
            value={props.apiKey}
            onChange={(e) => props.onApiKeyChange(e.target.value)}
            placeholder="Paste the OpenAI-compatible key"
            autoComplete="off"
          />
        </label>
        <label className="form-group">
          <span className="form-label">Base URL</span>
          <input
            type="url"
            className="form-input"
            value={props.baseUrl}
            onChange={(e) => props.onBaseUrlChange(e.target.value)}
            placeholder="https://ark.cn-beijing.volces.com/api/v3"
            autoComplete="off"
          />
        </label>
      </div>
      <div className="wizard__actions">
        <button type="button" className="btn btn-secondary" onClick={props.onBack}>
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={props.onNext}
          disabled={!props.provider || !props.apiKey}
        >
          Continue
        </button>
      </div>
    </div>
  )
}

function StepKnowledge(props: {
  imported: boolean
  onImport: () => void
} & StepProps): React.JSX.Element {
  return (
    <div className="wizard__step">
      <StepHeader
        index={3}
        total={4}
        title="Import knowledge (optional)"
        subtitle="Paste FAQ, product info, or tone rules. You can do this later from the Console view."
      />
      <div className="wizard__card">
        {props.imported ? (
          <p className="wizard__hint">Knowledge base received. You can refine it later.</p>
        ) : (
          <p className="wizard__hint">Skip for now to run a smoke test, or import from the Console.</p>
        )}
      </div>
      <div className="wizard__actions">
        <button type="button" className="btn btn-secondary" onClick={props.onBack}>
          Back
        </button>
        <button type="button" className="btn btn-secondary" onClick={props.onImport}>
          {props.imported ? 'Re-import' : 'Import now'}
        </button>
        <button type="button" className="btn btn-primary" onClick={props.onNext}>
          Continue
        </button>
      </div>
    </div>
  )
}

function StepTest(props: { im: string; onFinish: () => void }): React.JSX.Element {
  const [result, setResult] = useState<'idle' | 'pending' | 'ok' | 'fail'>('idle')
  const [error, setError] = useState<string | null>(null)

  const runSmoke = useCallback(async () => {
    setResult('pending')
    setError(null)
    try {
      const preflight = (await window.electron?.invoke('engine:preflight', {})) as { ready?: boolean; summary?: string }
      if (!preflight || preflight.ready !== true) {
        setResult('fail')
        setError(preflight?.summary || 'Preflight reported not ready')
        return
      }
      setResult('ok')
    } catch (e) {
      setResult('fail')
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  return (
    <div className="wizard__step">
      <StepHeader
        index={4}
        total={4}
        title="Run a smoke test"
        subtitle={`Run engine preflight against ${props.im}. Confirm Vision + reply are wired before going live.`}
      />
      <div className="wizard__card">
        {result === 'idle' ? <p>Press the button to ping the engine.</p> : null}
        {result === 'pending' ? <p>Running preflight...</p> : null}
        {result === 'ok' ? <p className="wizard__hint">Preflight passed. You are ready.</p> : null}
        {result === 'fail' ? <p className="wizard__error">Failed: {error || 'unknown'}</p> : null}
      </div>
      <div className="wizard__actions">
        <button type="button" className="btn btn-secondary" onClick={runSmoke} disabled={result === 'pending'}>
          Run preflight
        </button>
        <button type="button" className="btn btn-primary" onClick={props.onFinish}>
          Finish setup
        </button>
      </div>
    </div>
  )
}

export function OnboardingWizard(props: { onComplete: () => void }): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [im, setIm] = useState('wechat')
  const [provider, setProvider] = useState('doubao')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://ark.cn-beijing.volces.com/api/v3')
  const [imported, setImported] = useState(false)

  const next = useCallback(() => setStep((s) => s + 1), [])
  const back = useCallback(() => setStep((s) => Math.max(0, s - 1)), [])

  const importKb = useCallback(() => {
    setImported(true)
  }, [])

  const finish = useCallback(async () => {
    try {
      await window.electron?.invoke('settings:setAll', {
        appType: im,
        chatProvider: {
          installed: provider === 'doubao' ? { id: 'doubao', name: 'Built-in Doubao', version: '1.0.0' } : null,
          manifestUrl: provider === 'openai' ? '' : '',
          config: provider === 'doubao' ? { apiKey, baseURL: baseUrl } : {}
        }
      })
      await window.electron?.invoke('onboarding:complete', { completedAt: new Date().toISOString() })
    } catch {
      // best-effort: even if persistence fails, treat as completed locally
    }
    props.onComplete()
  }, [apiKey, baseUrl, im, provider, props])

  const stepNode = useMemo(() => {
    if (step === 0) return <StepSelectIM value={im} onChange={setIm} onNext={next} />
    if (step === 1)
      return (
        <StepProvider
          imValue={im}
          provider={provider}
          onChange={setProvider}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          baseUrl={baseUrl}
          onBaseUrlChange={setBaseUrl}
          onNext={next}
          onBack={back}
        />
      )
    if (step === 2) return <StepKnowledge imported={imported} onImport={importKb} onNext={next} onBack={back} />
    return <StepTest im={im} onFinish={finish} />
  }, [step, im, provider, apiKey, baseUrl, imported, importKb, next, back, finish])

  return (
    <div className="wizard" role="dialog" aria-modal="true" aria-label="Onboarding wizard">
      <div className="wizard__shell">{stepNode}</div>
    </div>
  )
}

export function useOnboardingStatus(): { status: OnboardingStatus | null; reload: () => Promise<void> } {
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const reload = useCallback(async () => {
    try {
      const r = (await window.electron?.invoke('onboarding:status')) as OnboardingStatus | undefined
      if (r) setStatus(r)
    } catch {
      setStatus({ completed: false, completedAt: null })
    }
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  return { status, reload }
}
