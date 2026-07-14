import { clipboard } from 'electron'
import { AppType } from './types'
import { getWindowInfo } from './window-utils'
import { getInputAreaFromCache } from './vision-utils'
import { delay, randomDelayIn, getRobot } from './util'

const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const MIN_TYPING_CPM = 60
const MAX_TYPING_CPM = 1200
const DEFAULT_TYPING_CPM = 280

export type ReplyOutputMode = 'typing' | 'paste' | 'typing-with-paste-fallback'

export interface ReplyOutputConfig {
  mode: ReplyOutputMode
  typingCpm: number
}

export interface ReplySendOptions {
  submit?: boolean
}

const DEFAULT_REPLY_OUTPUT_CONFIG: ReplyOutputConfig = {
  mode: 'typing-with-paste-fallback',
  typingCpm: DEFAULT_TYPING_CPM
}

let replyOutputConfig: ReplyOutputConfig = { ...DEFAULT_REPLY_OUTPUT_CONFIG }

export function setReplyOutputConfig(config: Partial<ReplyOutputConfig> | null | undefined): void {
  replyOutputConfig = {
    mode: isReplyOutputMode(config?.mode) ? config.mode : DEFAULT_REPLY_OUTPUT_CONFIG.mode,
    typingCpm: normalizeTypingCpm(config?.typingCpm)
  }
}

export function getReplyOutputConfig(): ReplyOutputConfig {
  return { ...replyOutputConfig }
}

async function humanLikeMove(
  targetX: number,
  targetY: number,
  options: {
    minSteps?: number
    maxSteps?: number
    baseDelay?: number
  } = {}
): Promise<void> {
  const robot = getRobot()
  if (!robot) return

  const { minSteps = 5, maxSteps = 15, baseDelay = 2 } = options

  const startPos = robot.getMousePos()
  const dx = targetX - startPos.x
  const dy = targetY - startPos.y
  const distance = Math.sqrt(dx * dx + dy * dy)

  if (distance < 1) {
    robot.moveMouse(Math.round(targetX), Math.round(targetY))
    return
  }

  const steps = Math.min(
    maxSteps,
    Math.max(minSteps, Math.floor(distance / 40) + Math.floor(Math.random() * 3))
  )

  const ctrl1X = startPos.x + dx * Math.random() * 0.5 + (Math.random() - 0.5) * distance * 0.2
  const ctrl1Y = startPos.y + dy * Math.random() * 0.5 + (Math.random() - 0.5) * distance * 0.2
  const ctrl2X = startPos.x + dx * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * distance * 0.2
  const ctrl2Y = startPos.y + dy * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * distance * 0.2

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const easeT = t * (2 - t)
    const mt = 1 - easeT
    const mt2 = mt * mt
    const mt3 = mt2 * mt
    const easeT2 = easeT * easeT
    const easeT3 = easeT2 * easeT

    const x = mt3 * startPos.x + 3 * mt2 * easeT * ctrl1X + 3 * mt * easeT2 * ctrl2X + easeT3 * targetX
    const y = mt3 * startPos.y + 3 * mt2 * easeT * ctrl1Y + 3 * mt * easeT2 * ctrl2Y + easeT3 * targetY

    const jitterX = i === steps ? 0 : (Math.random() - 0.5) * 2
    const jitterY = i === steps ? 0 : (Math.random() - 0.5) * 2

    robot.moveMouse(Math.round(x + jitterX), Math.round(y + jitterY))

    let stepDelay = baseDelay + Math.random() * 2
    if (i > steps * 0.8) stepDelay += 2

    await delay(stepDelay)
  }
}

export async function humanLikeClick(button: 'left' | 'right' = 'left'): Promise<void> {
  const robot = getRobot()
  if (!robot) return

  try {
    robot.mouseToggle('down', button)
    const pressDuration = 120 + Math.random() * 100
    await delay(Math.round(pressDuration))
    robot.mouseToggle('up', button)
    const afterClickDelay = 50 + Math.random() * 100
    await delay(Math.round(afterClickDelay))
  } catch (error) {
    console.error('模拟人化点击执行失败', error)
    robot.mouseClick(button)
  }
}

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

const getWeChatInputPosition = (bounds: WindowBounds, scaleFactor: number): { inputX: number; inputY: number } => {
  if (IS_WINDOWS) {
    const baseInputX = Math.round((bounds.x + bounds.width - 150) * scaleFactor)
    const baseInputY = Math.round((bounds.y + bounds.height - 40) * scaleFactor)
    return { inputX: baseInputX + (Math.random() - 0.5) * 20, inputY: baseInputY - Math.random() * 5 }
  }
  const baseInputX = bounds.x + bounds.width - 250
  const baseInputY = bounds.y + bounds.height - 20
  return { inputX: baseInputX + (Math.random() - 0.5) * 20, inputY: baseInputY - Math.random() * 5 }
}

export async function sendReplyByCoordsAction(
  x: number,
  y: number,
  text: string,
  outputMode: ReplyOutputMode = replyOutputConfig.mode,
  options: ReplySendOptions = {}
): Promise<boolean> {
  const robot = getRobot()
  if (!robot) {
    console.error('[sendReplyByCoordsAction] RobotJS 缺失')
    return false
  }

  try {
    await humanLikeMove(x, y)
    await randomDelayIn(100, 200)

    robot.mouseClick('left')
    await randomDelayIn(200, 300)

    const typingCpm = normalizeTypingCpm(replyOutputConfig.typingCpm)
    console.log(`[sendReplyByCoordsAction] outputMode=${outputMode}, typingCpm=${typingCpm}`)

    const typed = await typeReplyText(robot, text, outputMode, typingCpm)
    if (!typed) {
      return false
    }

    if (options.submit !== false) {
      await randomDelayIn(280, 420)
      robot.keyTap('enter')
    } else {
      console.log('[sendReplyByCoordsAction] draft mode: skipped Enter submit')
    }
    return true
  } catch (err: unknown) {
    console.error('[sendReplyByCoordsAction] Failed:', err)
    return false
  }
}

export async function sendReplyAction(
  appType: AppType,
  text: string,
  options: ReplySendOptions = {}
): Promise<boolean> {
  const windowInfo = await getWindowInfo(appType, false)
  if (!windowInfo || !windowInfo.bounds) {
    console.error('[sendReplyAction] 无法获取窗口信息')
    return false
  }

  let inputX: number | undefined
  let inputY: number | undefined

  const inputArea = getInputAreaFromCache(appType)
  if (inputArea) {
    inputX = inputArea.coordinates[0] + (Math.random() - 0.5) * 10
    inputY = inputArea.coordinates[1] + (Math.random() - 0.5) * 4
    console.log(`[sendReplyAction] 使用缓存输入框坐标 (${inputX}, ${inputY})`)
  }

  if (inputX === undefined || inputY === undefined) {
    console.log('[sendReplyAction] 使用 Fallback 逻辑生成输入框坐标')
    const pos = getWeChatInputPosition(windowInfo.bounds, windowInfo.scaleFactor || 1)
    inputX = pos.inputX
    inputY = pos.inputY
  }

  return sendReplyByCoordsAction(inputX, inputY, text, replyOutputConfig.mode, options)
}

export type ClickPolicy = 'single' | 'double'

export function defaultClickPolicy(appType: AppType): ClickPolicy {
  return appType === 'wechat' ? 'double' : 'single'
}

export async function activeUnreadByClickAction(
  coordinates: [number, number],
  appType: AppType,
  clickPolicy?: ClickPolicy
): Promise<void> {
  const robot = getRobot()
  if (!robot) return

  const [centerX, centerY] = coordinates
  const policy: ClickPolicy = clickPolicy ?? defaultClickPolicy(appType)
  const isSingleClick = policy === 'single'

  console.log(`[activeUnreadByClick] ${isSingleClick ? '单击' : '双击'}红点`, {
    centerX,
    centerY,
    appType,
    policy
  })

  await humanLikeMove(centerX, centerY)
  await randomDelayIn(150, 250)

  robot.mouseClick('left')
  if (!isSingleClick) {
    await randomDelayIn(40, 60)
    robot.mouseClick('left')
  }
}

export async function clickUnreadContactAction(coordinates: [number, number]): Promise<void> {
  const robot = getRobot()
  if (!robot) return

  const [firstContactX, firstContactY] = coordinates
  console.log('[clickUnreadContact] 点击联系人', {
    firstContactX,
    firstContactY
  })

  await humanLikeMove(firstContactX, firstContactY)
  await randomDelayIn(150, 250)

  robot.mouseClick('left')
  console.log('[clickUnreadContact] 点击完成')
  await randomDelayIn(150, 250)
}

async function typeReplyText(
  robot: ReturnType<typeof getRobot>,
  text: string,
  outputMode: ReplyOutputMode,
  typingCpm: number
): Promise<boolean> {
  if (!text) return true

  if (outputMode === 'paste') {
    console.log('[typeReplyText] outputMode=paste')
    return pasteText(robot, text)
  }

  try {
    console.log(`[typeReplyText] outputMode=${outputMode}, typingCpm=${typingCpm}`)
    await typeStringHumanly(robot, text, typingCpm)
    return true
  } catch (error) {
    console.error('[typeReplyText] 逐字输入失败:', error)
    if (outputMode !== 'typing-with-paste-fallback') {
      return false
    }
    return pasteText(robot, text)
  }
}

function pasteText(robot: ReturnType<typeof getRobot>, text: string): boolean {
  try {
    clipboard.writeText(text)
    if (IS_MAC) {
      robot.keyTap('v', ['command'])
    } else {
      robot.keyTap('v', ['control'])
    }
    return true
  } catch (error) {
    console.error('[pasteText] 粘贴失败:', error)
    return false
  }
}

async function typeStringHumanly(
  robot: ReturnType<typeof getRobot>,
  text: string,
  typingCpm: number
): Promise<void> {
  const normalizedCpm = normalizeTypingCpm(typingCpm)
  for (const char of Array.from(text)) {
    await typeUnicodeCharacter(robot, char)
    await delay(charDelayMs(char, normalizedCpm))
  }
}

async function typeUnicodeCharacter(robot: ReturnType<typeof getRobot>, char: string): Promise<void> {
  const codePoint = char.codePointAt(0)
  if (codePoint !== undefined && typeof robot.unicodeTap === 'function') {
    robot.unicodeTap(codePoint)
    return
  }

  if (typeof robot.typeString === 'function') {
    robot.typeString(char)
    return
  }

  throw new Error(`Unsupported character input: ${char}`)
}

function randomTypingCpm(baseCpm: number): number {
  const clamped = normalizeTypingCpm(baseCpm)
  const jitter = Math.max(20, Math.round(clamped * 0.15))
  const next = clamped + Math.floor(Math.random() * (jitter * 2 + 1)) - jitter
  return Math.max(MIN_TYPING_CPM, Math.min(MAX_TYPING_CPM, next))
}

function charDelayMs(char: string, typingCpm: number): number {
  const clamped = randomTypingCpm(typingCpm)
  const base = 60000 / clamped
  const jitter = Math.max(18, Math.round(base * 0.22))
  let delayMs = base + Math.floor(Math.random() * (jitter * 2 + 1)) - jitter

  if (/[\n\r]/.test(char)) delayMs += 180 + Math.random() * 120
  else if (/[。！？；：.!?;:]/.test(char)) delayMs += 100 + Math.random() * 100
  else if (/[，、,]/.test(char)) delayMs += 60 + Math.random() * 60
  else if (/\s/.test(char)) delayMs += 20 + Math.random() * 40

  return Math.max(25, Math.round(delayMs))
}

function normalizeTypingCpm(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_TYPING_CPM
  return Math.max(MIN_TYPING_CPM, Math.min(MAX_TYPING_CPM, Math.round(numeric)))
}

function isReplyOutputMode(value: unknown): value is ReplyOutputMode {
  return value === 'typing' || value === 'paste' || value === 'typing-with-paste-fallback'
}


