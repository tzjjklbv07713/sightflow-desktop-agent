import { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type OverlayCapturePreset = {
  label: string
  width: number
  height: number
  query: string
}

export async function runOverlayCaptureTest(): Promise<void> {
  const htmlPath = path.join(process.cwd(), 'out', 'renderer', 'overlay.html')
  const preloadPath = path.join(process.cwd(), 'out', 'preload', 'index.js')
  const outputDir = path.join(process.cwd(), 'tmp-workbench-captures')
  mkdirSync(outputDir, { recursive: true })

  const preset = readOverlayCapturePreset()
  const pageUrl = `${pathToFileURL(htmlPath).toString()}${preset.query}`
  const win = new BrowserWindow({
    width: preset.width,
    height: preset.height,
    show: false,
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false
    }
  })

  try {
    console.log(`[Overlay Capture] loading ${pageUrl}`)
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error(`[Overlay Capture] did-fail-load ${errorCode} ${errorDescription}`)
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[Overlay Capture] render-process-gone ${details.reason}`)
    })
    win.webContents.on('console-message', (_event, level, message) => {
      console.log(`[Overlay Renderer:${level}] ${message}`)
    })
    await win.loadURL(pageUrl)
    console.log('[Overlay Capture] page loaded')
    await delay(250)
    console.log('[Overlay Capture] renderer settled')
    await win.webContents.executeJavaScript(
      `
        document.body.style.background = 'radial-gradient(circle at 18% 18%, rgba(37, 99, 235, 0.35), transparent 32%), linear-gradient(135deg, #0f172a 0%, #111827 48%, #0b1220 100%)';
        const style = document.createElement('style');
        style.textContent = \`
          *, *::before, *::after {
            animation: none !important;
            transition: none !important;
          }
        \`;
        document.head.appendChild(style);
      `,
      true
    )
    console.log('[Overlay Capture] preview background injected')
    await delay(400)
    const image = await win.webContents.capturePage()
    const targetPath = path.join(outputDir, `${preset.label}.png`)
    writeFileSync(targetPath, image.toPNG())
    console.log(`[Overlay Capture] saved ${targetPath}`)
  } finally {
    if (!win.isDestroyed()) {
      win.destroy()
    }
  }
}

function readOverlayCapturePreset(): OverlayCapturePreset {
  const width = Number.parseInt(process.env.OVERLAY_CAPTURE_WIDTH || '1366', 10) || 1366
  const height = Number.parseInt(process.env.OVERLAY_CAPTURE_HEIGHT || '820', 10) || 820
  const label = process.env.OVERLAY_CAPTURE_LABEL || 'overlay-preview'
  const query = process.env.OVERLAY_CAPTURE_QUERY || '?overlayPreview=demo&step=inputBox'
  return { label, width, height, query }
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
