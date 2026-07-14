import { app, ipcMain } from 'electron'
import { runScreenshotTest } from '../src/core/rpa/tests/test-screenshot'
import { runReplyTest } from '../src/core/rpa/tests/test-reply'
import { runSwitchTest } from '../src/core/rpa/tests/test-switch'
import { runGroupDebugTest } from '../src/core/chat/tests/test-group-debug'
import { runGroupRulesTest } from '../src/core/chat/tests/test-group-rules'
import { runWorkbenchCaptureTest } from '../src/core/ui/tests/test-workbench-capture'
import { runOverlayCaptureTest } from '../src/core/ui/tests/test-overlay-capture'
import { runHybridPerceptionTest } from '../src/core/perception/tests/test-hybrid-perception'
import { runUiAutomationProbeTest } from '../src/core/uiautomation/tests/test-probe'
import { checkAndRequestPermissions } from '../src/main/permission'

app.whenReady().then(async () => {
  try {
    const action = process.env.TEST_MODE
    const needsPermission = new Set(['screenshot', 'reply', 'switch', 'perception', 'uia'])
    if (action && needsPermission.has(action)) {
      await checkAndRequestPermissions()
    }
    if (action === 'workbench-capture') {
      registerWorkbenchCaptureStubs()
    }
    console.log(`\n\n--- 🚀 Running isolated atom CLI test: ${action} ---\n\n`)
    
    if (action === 'screenshot') await runScreenshotTest()
    else if (action === 'reply') await runReplyTest()
    else if (action === 'switch') await runSwitchTest()
    else if (action === 'group-debug') await runGroupDebugTest()
    else if (action === 'group-rules') await runGroupRulesTest()
    else if (action === 'workbench-capture') await runWorkbenchCaptureTest()
    else if (action === 'overlay-capture') await runOverlayCaptureTest()
    else if (action === 'perception') await runHybridPerceptionTest()
    else if (action === 'uia') await runUiAutomationProbeTest()
    else console.error(`Unknown test mode: ${action}`)

  } catch (err) {
    console.error(err)
  } finally {
    console.log('\n\n--- 🏁 CLI Test Finished ---\n\n')
    app.quit()
  }
})

function registerWorkbenchCaptureStubs(): void {
  const settings = {
    locale: 'zh',
    appType: 'wechat',
    vision: {
      apiKey: '',
      model: 'doubao-seed-2-0-lite-260215',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3'
    },
    replyModel: {
      apiKey: '',
      model: 'doubao-seed-2-0-lite-260215',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3'
    },
    chatProvider: {
      manifestUrl: '',
      installed: null,
      config: {}
    },
    defaultCaptureStrategy: 'auto',
    reply: {
      mode: 'typing-with-paste-fallback',
      typingCpm: 280
    },
    automation: {
      executionMode: 'auto-send',
      maxReplyChars: 1200,
      globalRateLimitPerMinute: 12,
      perChatRateLimitPerMinute: 4,
      groupReplyMode: 'off',
      groupTriggerKeywords: [],
      groupWhitelist: []
    },
    capture: {}
  }

  ipcMain.handle('settings:getAll', async () => settings)
  ipcMain.handle('settings:getMeta', async () => ({
    replyModelUsesVisionFallback: false,
    replyModelMatchesVisionConfig: false
  }))
  ipcMain.handle('capture:getRegions', async () => null)
}
