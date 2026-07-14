import { DEFAULT_REPLY_POLICY_CONFIG, ReplyPolicy } from '../reply-policy'
import type { ObservedChatMessage } from '../message-types'

interface TestResult {
  name: string
  pass: boolean
  detail?: string
}

const results: TestResult[] = []
let failed = 0

function expect(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    results.push({ name, pass: true })
  } else {
    results.push({ name, pass: false, detail })
    failed += 1
  }
}

function uiaObserved(
  overrides: {
    chatType?: 'direct' | 'group' | 'service' | 'official' | 'unknown'
    mentioned?: boolean
    content?: string
    chatName?: string
    senderName?: string
    confidence?: number
  } = {}
): ObservedChatMessage {
  return {
    chat: {
      id: 'wechat:test',
      type: overrides.chatType ?? 'direct',
      name: overrides.chatName ?? 'Tester',
      whitelisted: false
    },
    direction: 'contact',
    kind: 'text',
    content: overrides.content ?? 'hello',
    senderName: overrides.senderName ?? 'Alice',
    mentioned: overrides.mentioned,
    timestamp: 1700000000000,
    confidence: overrides.confidence ?? 0.9,
    source: 'uiautomation'
  }
}

const directOnlyPolicy = new ReplyPolicy({
  ...DEFAULT_REPLY_POLICY_CONFIG,
  autoSendScope: 'direct-only',
  groupReplyMode: 'off',
  groupTriggerKeywords: [],
  minReplyIntervalMs: 0
})

// Production-shape policy: autoSendScope gates the scope, then the
// whitelist mode picks the specific groups allowed inside that scope.
const scopeAndWhitelistPolicy = new ReplyPolicy({
  ...DEFAULT_REPLY_POLICY_CONFIG,
  autoSendScope: 'direct-and-whitelist-groups',
  groupReplyMode: 'whitelist',
  groupWhitelist: ['VIP客户群'],
  groupTriggerKeywords: [],
  minReplyIntervalMs: 0
})

const mentionOnlyPolicy = new ReplyPolicy({
  ...DEFAULT_REPLY_POLICY_CONFIG,
  autoSendScope: 'all',
  groupReplyMode: 'mention-only',
  groupTriggerKeywords: [],
  minReplyIntervalMs: 0
})

const mentionOrKeywordPolicy = new ReplyPolicy({
  ...DEFAULT_REPLY_POLICY_CONFIG,
  autoSendScope: 'all',
  groupReplyMode: 'mention-or-keyword',
  groupTriggerKeywords: ['help', 'refund'],
  minReplyIntervalMs: 0
})

const allGroupsPolicy = new ReplyPolicy({
  ...DEFAULT_REPLY_POLICY_CONFIG,
  autoSendScope: 'all',
  groupReplyMode: 'off',
  groupTriggerKeywords: [],
  minReplyIntervalMs: 0
})

const directHit = directOnlyPolicy.evaluate({
  appType: 'wechat',
  replyText: 'hi',
  observedMessage: uiaObserved({ content: 'hi' }),
  now: 1700000000000
})
expect('UIA direct chat in direct-only scope is allowed',
  directHit.allowed === true,
  JSON.stringify(directHit))

const uiaGroupDirectOnly = directOnlyPolicy.evaluate({
  appType: 'wechat',
  replyText: 'ok',
  observedMessage: uiaObserved({ chatType: 'group', content: 'hi' }),
  now: 1700000000000
})
expect('UIA group in direct-only scope is blocked (scope reason)',
  uiaGroupDirectOnly.allowed === false &&
    uiaGroupDirectOnly.reason === 'group_not_in_auto_send_scope',
  JSON.stringify(uiaGroupDirectOnly))

const uiaWhitelistedGroup = scopeAndWhitelistPolicy.evaluate({
  appType: 'wechat',
  replyText: 'ok',
  observedMessage: uiaObserved({
    chatType: 'group',
    chatName: 'VIP客户群',
    content: 'price please'
  }),
  now: 1700000000000
})
expect('UIA whitelisted group is allowed under scope+whitelist',
  uiaWhitelistedGroup.allowed === true,
  JSON.stringify(uiaWhitelistedGroup))

const uiaNonWhitelistedGroup = scopeAndWhitelistPolicy.evaluate({
  appType: 'wechat',
  replyText: 'ok',
  observedMessage: uiaObserved({
    chatType: 'group',
    chatName: 'Random Customer Group',
    content: 'price please'
  }),
  now: 1700000000000
})
expect('UIA non-whitelisted group in direct-and-whitelist scope is blocked',
  uiaNonWhitelistedGroup.allowed === false &&
    uiaNonWhitelistedGroup.reason === 'group_not_in_auto_send_scope',
  JSON.stringify(uiaNonWhitelistedGroup))

const uiaMention = mentionOnlyPolicy.evaluate({
  appType: 'wechat',
  replyText: 'yes',
  observedMessage: uiaObserved({
    chatType: 'group',
    content: '@小助手 help please',
    mentioned: true
  }),
  now: 1700000000000
})
expect('UIA group with @-mention is allowed under mention-only',
  uiaMention.allowed === true,
  JSON.stringify(uiaMention))

const uiaKeywordHit = mentionOrKeywordPolicy.evaluate({
  appType: 'wechat',
  replyText: 'yes',
  observedMessage: uiaObserved({
    chatType: 'group',
    content: 'I need a refund',
    mentioned: false
  }),
  now: 1700000000000
})
expect('UIA group with keyword hit is allowed under mention-or-keyword',
  uiaKeywordHit.allowed === true,
  JSON.stringify(uiaKeywordHit))

const uiaUntriggered = mentionOrKeywordPolicy.evaluate({
  appType: 'wechat',
  replyText: 'yes',
  observedMessage: uiaObserved({
    chatType: 'group',
    content: 'just chatting',
    mentioned: false
  }),
  now: 1700000000000
})
expect('UIA group with no mention or keyword is blocked (group_not_triggered)',
  uiaUntriggered.allowed === false &&
    uiaUntriggered.reason === 'group_not_triggered',
  JSON.stringify(uiaUntriggered))

const uiaGroupModeOff = allGroupsPolicy.evaluate({
  appType: 'wechat',
  replyText: 'ok',
  observedMessage: uiaObserved({ chatType: 'group', content: 'hi' }),
  now: 1700000000000
})
expect('UIA group in scope=all with mode=off is blocked',
  uiaGroupModeOff.allowed === false &&
    uiaGroupModeOff.reason === 'group_reply_disabled',
  JSON.stringify(uiaGroupModeOff))

const uiaSelf = directOnlyPolicy.evaluate({
  appType: 'wechat',
  replyText: 'reply',
  observedMessage: {
    ...uiaObserved({ content: 'echo' }),
    direction: 'self',
    confidence: 0.9
  },
  now: 1700000000000
})
expect('UIA self-message observation is blocked',
  uiaSelf.allowed === false &&
    uiaSelf.reason === 'latest_message_from_self',
  JSON.stringify(uiaSelf))

console.log('[ReplyPolicy UIA group/scope] results', results)
if (failed > 0) {
  console.error('[ReplyPolicy UIA group/scope] failed: ' + failed)
  process.exit(1)
}