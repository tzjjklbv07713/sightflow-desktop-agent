const DEFAULT_MODEL = 'doubao-seed-2-0-lite-260215'
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_PROMPT = `你是一个微信自动回复助手。你会收到一张微信/企业微信的聊天窗口截图。

## 你的任务
分析截图中的聊天内容，生成合适的回复。

## 规则
1. 只输出回复文字，不要解释、不要添加多余内容
2. 防自我循环：仔细观察截图。聊天窗口中，右侧的气泡是"我"发送的。如果最后一条消息是右侧气泡，必须输出 [SKIP]
3. 如果最新消息是系统消息、群公告、红包、转账等非对话消息，输出 [SKIP]
4. 如果无法判断是否需要回复，输出 [SKIP]
5. 回复要自然、口语化，像真人对话`

const SAFETY_PROMPT = `\n\n## 程序级安全规则\n- 必须先判断最新一条聊天气泡来自谁。右侧气泡代表“我”已经发送的消息，左侧气泡代表对方消息。\n- 只允许回复最新一条左侧对方消息，不要回复历史消息、自己的上一条回复、系统提示或会话标题。\n- 如果最后一条消息是右侧气泡，必须只输出 [SKIP]，不要继续补充回复。\n- 如果最新左侧消息看得见，即使内容很短、很口语或有点模糊，也要围绕它自然回复；不确定对方意思时就简短追问。\n- 只有在完全看不清最新左侧消息，或最新消息明确不是聊天气泡时，才输出 [SKIP]。\n- 回复内容必须直接对应最新左侧消息，不要凭空编造未在截图中出现的问题。`

export const manifest = {
  id: 'volcengine-ark',
  apiVersion: 1
}

export function createProvider(context) {
  const providerConfig = context && context.providerConfig ? context.providerConfig : {}

  return {
    async *run(input) {
      if (!input || !input.screenshot) {
        yield { type: 'skip' }
        return
      }

      const apiKey = providerConfig.apiKey
      if (!apiKey) {
        yield { type: 'error', error: '聊天服务缺少接口密钥' }
        return
      }

      yield { type: 'thinking', content: '正在分析聊天内容...' }

      try {
        const reply = await requestReply({
          screenshot: input.screenshot,
          replyContext: input.replyContext,
          apiKey,
          baseURL: providerConfig.baseURL || DEFAULT_BASE_URL,
          model: providerConfig.model || DEFAULT_MODEL,
          systemPrompt: buildSystemPrompt(providerConfig.systemPrompt)
        })

        if (!reply || reply.trim() === '[SKIP]') {
          yield { type: 'skip' }
          return
        }

        yield { type: 'reply_text', content: reply.trim() }
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (context && context.host && typeof context.host.log === 'function') {
          context.host.log(`provider error: ${message}`)
        }
        yield { type: 'error', error: message || '聊天服务调用失败' }
      }
    }
  }
}

function buildSystemPrompt(customPrompt) {
  const base =
    customPrompt && String(customPrompt).trim() ? String(customPrompt).trim() : DEFAULT_PROMPT
  return `${base}${SAFETY_PROMPT}`
}

async function requestReply({ screenshot, replyContext, apiKey, baseURL, model, systemPrompt }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: normalizeImageUrl(screenshot) } },
          {
            type: 'text',
            text: buildUserInstruction(replyContext)
          }
        ]
      }
    ],
    thinking: { type: 'disabled' },
    stream: false
  }

  const response = await fetch(buildChatCompletionsUrl(baseURL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`)
  }

  const json = await response.json()
  return json && json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message.content || ''
    : ''
}

function buildUserInstruction(replyContext) {
  const latest = replyContext && replyContext.latestMessage ? replyContext.latestMessage : null
  const observation = latest
    ? [
        '## 程序观察结果',
        `- 是否检测到自己最近气泡: ${latest.detected ? '是' : '否'}`,
        `- 最新可见消息是否来自自己: ${latest.latestFromSelf ? '是' : '否'}`,
        `- 置信度: ${latest.confidence}`,
        latest.reason ? `- 原因: ${latest.reason}` : '',
        latest.error ? `- 检测错误: ${latest.error}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    : '## 程序观察结果\n- 未提供额外观察结果'

  return `${observation}

## 回复要求
请只根据截图中最新一条左侧对方消息生成回复。
- 如果程序观察结果显示“最新可见消息是否来自自己: 是”，必须输出 [SKIP]。
- 如果最新左侧消息看得见，就直接回复或简短追问。
- 不要回复历史消息、右侧自己发出的消息、系统提示或会话标题。
- 只有最新消息在右侧、完全看不清或不是聊天气泡时才输出 [SKIP]。`
}

function normalizeImageUrl(screenshot) {
  const rawBase64 = stripBase64Prefix(screenshot)
  if (rawBase64.startsWith('http')) {
    return rawBase64
  }
  return `data:image/png;base64,${rawBase64}`
}

function stripBase64Prefix(base64) {
  const idx = String(base64).indexOf('base64,')
  return idx !== -1 ? String(base64).slice(idx + 'base64,'.length) : String(base64)
}

function buildChatCompletionsUrl(baseURL) {
  const normalized = String(baseURL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '')
  if (normalized.endsWith('/chat/completions')) {
    return normalized
  }
  return `${normalized}/chat/completions`
}
