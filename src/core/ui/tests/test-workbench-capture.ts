import { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type CapturePreset = {
  label: string
  width: number
  height: number
  theme: 'light' | 'dark'
  query?: string
  settingsSection?: 'base' | 'agent'
}

export async function runWorkbenchCaptureTest(): Promise<void> {
  const htmlPath = path.join(process.cwd(), 'out', 'renderer', 'index.html')
  const preloadPath = path.join(process.cwd(), 'out', 'preload', 'index.js')
  const outputDir = path.join(process.cwd(), 'tmp-workbench-captures')
  mkdirSync(outputDir, { recursive: true })
  const preset = readCapturePreset()
  const pageUrl = `${pathToFileURL(htmlPath).toString()}${preset.query || ''}`
  const win = new BrowserWindow({
    width: preset.width,
    height: preset.height,
    show: false,
    backgroundColor: preset.theme === 'dark' ? '#0a0b10' : '#edf2f7',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false
    }
  })

  try {
    await win.loadURL(pageUrl)
    await win.webContents.executeJavaScript(
      `
        localStorage.setItem('sightflow-theme', '${preset.theme}');
        window.location.reload();
      `,
      true
    )
    await waitForDidFinishLoad(win)
    await win.webContents.executeJavaScript(
      `
        const style = document.createElement('style');
        style.textContent = \`
          *, *::before, *::after {
            animation: none !important;
            transition: none !important;
          }
          .fade-in, .slide-up {
            opacity: 1 !important;
            transform: none !important;
          }
        \`;
        document.head.appendChild(style);
      `,
      true
    )
    if (preset.settingsSection) {
      await win.webContents.executeJavaScript(
        `
          const target = ${JSON.stringify(preset.settingsSection)};
          const buttons = Array.from(document.querySelectorAll('.settings-nav-item'));
          const index = target === 'agent' ? 1 : 0;
          const button = buttons[index];
          if (button instanceof HTMLElement) {
            button.click();
          }
        `,
        true
      )
    }
    await delay(900)
    const image = await win.webContents.capturePage()
    const targetPath = path.join(outputDir, `${preset.label}.png`)
    writeFileSync(targetPath, image.toPNG())
    console.log(`[Workbench Capture] saved ${targetPath}`)
  } finally {
    if (!win.isDestroyed()) {
      win.destroy()
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForDidFinishLoad(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (win.webContents.isLoadingMainFrame()) {
      win.webContents.once('did-finish-load', () => resolve())
      return
    }
    resolve()
  })
}

function readCapturePreset(): CapturePreset {
  const theme = process.env.WORKBENCH_CAPTURE_THEME === 'light' ? 'light' : 'dark'
  const width = Number.parseInt(process.env.WORKBENCH_CAPTURE_WIDTH || '1440', 10) || 1440
  const height = Number.parseInt(process.env.WORKBENCH_CAPTURE_HEIGHT || '900', 10) || 900
  const label = process.env.WORKBENCH_CAPTURE_LABEL || `${theme}-${width}`
  const query = process.env.WORKBENCH_CAPTURE_QUERY || ''
  const settingsSection = process.env.WORKBENCH_CAPTURE_SETTINGS_SECTION === 'agent' ? 'agent' : undefined
  return { label, width, height, theme, query, settingsSection }
}
