// src/renderer/src/i18n.ts
// 简单的中英文国际化

export type Locale = 'zh' | 'en'

const translations = {
  zh: {
    // Header
    'app.title': 'SightFlow Desktop',
    'app.version': 'v0.1.0',

    // Tabs
    'tab.control': '控制',
    'tab.settings': '设置',

    // Control
    'control.status': '引擎状态',
    'status.idle': '待命',
    'status.running': '运行中',
    'status.error': '异常',
    'control.start': '启动引擎',
    'control.stop': '停止引擎',
    'control.start.novisionkey': '请先在设置页填写视觉接口密钥',
    'control.start.noreplykey': '请先在设置页填写回复模型 API Key',
    'control.start.noprovider': '请先安装聊天服务',
    'control.start.missingProviderField': '聊天服务缺少必填项',
    'control.log': '运行日志',
    'control.log.empty': '引擎尚未启动',
    'control.log.thinking': '思考',
    'control.log.reply': '回复',
    'control.log.skip': '跳过',
    'control.log.error': '错误',
    'control.log.metric': '性能',
    'control.log.filter.all': '全部',
    'control.log.filter.thinking': '思考',
    'control.log.filter.reply': '回复',
    'control.log.filter.skip': '跳过',
    'control.log.filter.error': '错误',
    'control.log.filter.metric': '性能',

    // Settings
    'settings.vision': '视觉配置',
    'settings.appType': '应用类型',
    'settings.visionApiKey': '视觉接口密钥',
    'settings.visionApiKey.placeholder': '输入 OpenAI 兼容接口的 API Key',
    'settings.visionApiKey.hint': '用于布局分析、未读检测和界面定位',
    'settings.visionModel': '视觉模型',
    'settings.fetchModels': '拉取模型',
    'settings.fetchModels.fetching': '拉取中...',
    'settings.fetchModels.success': '已拉取模型列表',
    'settings.fetchModels.fail': '拉取模型失败',
    'settings.fetchModels.restartRequired': '当前进程还没加载到拉取模型接口，请完全退出后重新启动应用',
    'settings.visionOnly': '只看视觉模型',
    'settings.models.expand': '展开候选',
    'settings.models.collapse': '收起候选',
    'settings.visionBaseUrl': '视觉服务地址',
    'settings.testConnection': '测试连接',
    'settings.testConnection.testing': '测试中...',
    'settings.testConnection.success': '连接成功',
    'settings.testConnection.fail': '连接失败',
    'settings.saveSettings': '保存设置',
    'settings.replyModel': '回复模型配置',
    'settings.replyApiKey': '回复模型 API Key',
    'settings.replyApiKey.placeholder': '输入用于生成回复的 OpenAI 兼容 API Key',
    'settings.replyApiKey.hint': '用于根据聊天内容生成回复，可与视觉模型使用不同中转站或模型。',
    'settings.replyModelName': '回复模型',
    'settings.replyBaseUrl': '回复服务地址',
    'settings.reply': '回复输出',
    'settings.reply.mode': '输出模式',
    'settings.reply.mode.hybrid': '逐字输入 + 粘贴回退',
    'settings.reply.mode.typing': '逐字输入',
    'settings.reply.mode.paste': '剪贴板粘贴',
    'settings.reply.mode.hint': '默认推荐逐字输入，遇到特殊字符或输入失败时会回退到粘贴。',
    'settings.reply.typingCpm': '输入速度（CPM）',
    'settings.reply.typingCpm.hint': '每分钟输入字符数，允许 60-1200，建议 260-420。',
    'settings.saved': '配置已保存',
    'settings.chatProvider': '聊天服务',
    'settings.providerManifest': '配置清单地址',
    'settings.providerManifest.placeholder': '输入 manifest.json 地址或 file:// 本地路径',
    'settings.providerManifest.required': '请先填写配置清单地址',
    'settings.providerInstall': '安装 / 更新服务',
    'settings.providerInstall.installing': '安装中...',
    'settings.providerInstall.success': '聊天服务安装成功',
    'settings.providerInstall.failed': '聊天服务安装失败',
    'settings.providerInstall.required': '请先安装聊天服务',
    'settings.providerInstalled': '已安装服务',
    'settings.provider.save': '保存聊天配置',
    'settings.provider.saved': '聊天配置已保存',
    'settings.providerField.required': '缺少必填项',

    'settings.general': '通用设置',
    'settings.language': '语言',

    // Toast
    'toast.engineStarted': '引擎已启动',
    'toast.engineStopped': '引擎已停止',
    'toast.startFailed': '启动失败',
  },
  en: {
    'app.title': 'SightFlow Desktop',
    'app.version': 'v0.1.0',

    'tab.control': 'Control',
    'tab.settings': 'Settings',

    'control.status': 'Engine Status',
    'status.idle': 'Idle',
    'status.running': 'Running',
    'status.error': 'Error',
    'control.start': 'Start Engine',
    'control.stop': 'Stop Engine',
    'control.start.novisionkey': 'Please set Vision API Key first',
    'control.start.noreplykey': 'Please set Reply Model API Key first',
    'control.start.noprovider': 'Please install a chat provider first',
    'control.start.missingProviderField': 'Missing required provider field',
    'control.log': 'Activity Log',
    'control.log.empty': 'Engine not started yet',
    'control.log.thinking': 'Thinking',
    'control.log.reply': 'Reply',
    'control.log.skip': 'Skip',
    'control.log.error': 'Error',
    'control.log.metric': 'Metric',
    'control.log.filter.all': 'All',
    'control.log.filter.thinking': 'Thinking',
    'control.log.filter.reply': 'Reply',
    'control.log.filter.skip': 'Skip',
    'control.log.filter.error': 'Error',
    'control.log.filter.metric': 'Metrics',

    'settings.vision': 'Vision',
    'settings.appType': 'App Type',
    'settings.visionApiKey': 'Vision API Key',
    'settings.visionApiKey.placeholder': 'Enter your OpenAI-compatible API key',
    'settings.visionApiKey.hint': 'Used for layout measurement and UI detection',
    'settings.visionModel': 'Vision Model',
    'settings.fetchModels': 'Fetch Models',
    'settings.fetchModels.fetching': 'Fetching...',
    'settings.fetchModels.success': 'Model list loaded',
    'settings.fetchModels.fail': 'Failed to fetch models',
    'settings.fetchModels.restartRequired': 'The current process has not loaded the model-fetch IPC yet. Fully restart the app.',
    'settings.visionOnly': 'Vision only',
    'settings.models.expand': 'Expand candidates',
    'settings.models.collapse': 'Collapse candidates',
    'settings.visionBaseUrl': 'Vision Base URL',
    'settings.testConnection': 'Test Connection',
    'settings.testConnection.testing': 'Testing...',
    'settings.testConnection.success': 'Connection OK',
    'settings.testConnection.fail': 'Connection Failed',
    'settings.saveSettings': 'Save Settings',
    'settings.replyModel': 'Reply Model',
    'settings.replyApiKey': 'Reply API Key',
    'settings.replyApiKey.placeholder': 'Enter the OpenAI-compatible API key used for replies',
    'settings.replyApiKey.hint': 'Used to generate replies. It can use a different relay or model than vision.',
    'settings.replyModelName': 'Reply Model',
    'settings.replyBaseUrl': 'Reply Base URL',
    'settings.reply': 'Reply Output',
    'settings.reply.mode': 'Output Mode',
    'settings.reply.mode.hybrid': 'Typing + paste fallback',
    'settings.reply.mode.typing': 'Typing',
    'settings.reply.mode.paste': 'Paste',
    'settings.reply.mode.hint': 'Typing is recommended. The app falls back to paste if typing fails or special characters need it.',
    'settings.reply.typingCpm': 'Typing Speed (CPM)',
    'settings.reply.typingCpm.hint': 'Characters per minute, allowed 60-1200, suggested range 260-420.',
    'settings.saved': 'Settings saved',
    'settings.chatProvider': 'Chat Provider',
    'settings.providerManifest': 'Manifest URL',
    'settings.providerManifest.placeholder': 'Enter manifest.json URL or file:// path',
    'settings.providerManifest.required': 'Manifest URL is required',
    'settings.providerInstall': 'Install / Update Provider',
    'settings.providerInstall.installing': 'Installing...',
    'settings.providerInstall.success': 'Provider installed',
    'settings.providerInstall.failed': 'Provider install failed',
    'settings.providerInstall.required': 'Please install a chat provider first',
    'settings.providerInstalled': 'Installed Provider',
    'settings.provider.save': 'Save Provider Config',
    'settings.provider.saved': 'Provider config saved',
    'settings.providerField.required': 'Missing required field',

    'settings.general': 'General',
    'settings.language': 'Language',

    'toast.engineStarted': 'Engine started',
    'toast.engineStopped': 'Engine stopped',
    'toast.startFailed': 'Failed to start',
  }
} as const

type TranslationKey = keyof typeof translations['zh']

let currentLocale: Locale = 'zh'

export function setLocale(locale: Locale): void {
  currentLocale = locale
}

export function getLocale(): Locale {
  return currentLocale
}

export function t(key: TranslationKey): string {
  return translations[currentLocale]?.[key] || translations.zh[key] || key
}
