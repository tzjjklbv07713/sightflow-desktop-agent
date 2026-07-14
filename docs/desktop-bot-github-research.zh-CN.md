# 桌面实时聊天机器人 GitHub 对标报告

本文档记录 SightFlow 桌面实时聊天机器人方向的外部项目调研，以及已经吸收进本项目的第一阶段设计。

## 结论

SightFlow 不适合直接复制某个微信机器人项目。更稳妥的路线是分层吸收：

1. 从 `wxauto` 学习 Windows 桌面微信的 UIAutomation 思路，用结构化控件信息减少纯截图识别。
2. 从 `WeChatFerry` 学习消息模型、收发队列、多端客户端封装，但不引入 Hook 注入路线。
3. 从 `LangBot`、`CowAgent/chatgpt-on-wechat` 学习机器人平台层：消息管线、插件、知识库、记忆、权限、限流、监控。
4. 从 `wechat-daily-report-bot` 学习工程上的降级、dry-run、规则热加载、后端自动选择、指令路由。

核心原则：不直接抄第三方源码；借鉴结构、重新实现。尤其是微信自动化项目，很多 README 或免责声明都明确限制生产、商业或非法用途，必须避免把限制性代码直接合并进来。

## 项目对比

| 项目 | 路线 | 值得借鉴 | 不建议照搬 |
| --- | --- | --- | --- |
| wxauto | Windows UIAutomation 控制桌面微信 | 会话列表、未读检测、消息 runtime id 去重、独立聊天窗口监听、结构化消息类型、`@` 支持 | README 明确仅用于 UIAutomation 学习交流，禁止生产/商业用途；源码不直接复制 |
| WeChatFerry | 微信 Hook / 多语言客户端 | 消息类型体系、联系人/数据库/媒体能力、接收消息开关、多客户端 SDK 形态 | Hook 路线风险更高，不适合直接集成到当前桌面 RPA 产品 |
| LangBot | 生产级多平台 IM Bot 平台 | platform / provider / pipeline / plugin 分层，限流、敏感词、监控、知识库、多模型 | 体量太大，不适合整套搬入 Electron 客户端 |
| CowAgent / chatgpt-on-wechat | 多渠道 AI 助手 / 原微信机器人演进 | channel / bridge / plugin / agent / memory 思路，长期记忆、自我演进、工具调用 | 自我进化和多渠道框架应分阶段做，不能先堆复杂度 |
| wechat-daily-report-bot | 业务型微信群自动化 | 规则热加载、dry-run 模式、后端兼容链、命令路由、失败重试 | 业务场景较窄，不适合直接复用流程 |

## 适合融入 SightFlow 的能力

### 1. 结构化消息层

当前 SightFlow 主要依赖截图、像素 diff、VLM 判断。短期可用，但容易出现：

- 未读切换错。
- 最新消息来源判断错。
- 对方消息文本拿不到，回复和上下文无关。
- 群聊里不清楚谁发言、是否 @ 机器人。

应新增统一消息模型：

- `chatId`
- `chatName`
- `chatType`: `direct | group | service | official | unknown`
- `direction`: `self | contact | system | unknown`
- `kind`: `text | image | file | voice | link | quote | emoji | mixed | unknown`
- `content`
- `senderName`
- `timestamp`
- `confidence`
- `source`: `vision | uiautomation | manual | unknown`

第一阶段已新增：

- `src/core/chat/message-types.ts`

### 2. 消息去重

成熟项目不会只靠截图变化判断是否新消息。`wxauto` 的重点做法是用 UI 控件 runtime id 建立 `usedmsgid`，只处理没见过的新消息。

SightFlow 后续应实现：

- 当前会话 `lastSeenMessageIds`
- 单会话消息窗口
- 同一条消息只回复一次
- 同一回复内容短时间不重复发送

第一阶段已新增：

- `src/core/chat/reply-policy.ts` 内的重复回复拦截

### 3. 会话队列和最大轮次

未读切换不能无限循环。成熟项目会限制一次扫描的最大轮次，例如只处理最多 N 个未读会话，避免卡死和异常高频操作。

SightFlow 后续应实现：

- `UnreadChatQueue`
- `maxSwitchPerCycle`
- `maxSwitchPerHour`
- per-chat cooldown
- group/direct 不同优先级

第一阶段已新增：

- `src/core/chat/rate-limiter.ts`
- `GenericChannelSession` 发送前全局/单会话限流

### 4. 群聊回复策略

群聊不能像私聊一样“看到就回”。推荐默认：

- 群聊默认不主动回复。
- 只有被 @、命令触发、关键词命中、白名单群才回复。
- 高频群、刷屏群直接跳过或进入人工确认。
- 回复时优先草稿模式或提示人工确认。

这需要结构化消息层能识别 `chatType=group` 和 `mentioned=true` 后再完整落地。

### 5. 回复前策略闸门

AI 生成内容不应直接发送。需要先经过策略层：

- 空回复拦截。
- 过长回复拦截。
- 最近一条是自己发的，拦截。
- 重复回复拦截。
- 全局频率限制。
- 单会话频率限制。
- 后续增加敏感词、黑白名单、人工确认。

第一阶段已实现并接入：

- `src/core/chat/reply-policy.ts`
- `src/core/generic-channel-session.ts`

### 6. 可观测性和 dry-run

`wechat-daily-report-bot` 的 dry-run 值得借鉴。桌面端自动化必须能在不真实发送消息的情况下跑完整流程。

后续应增加：

- 只生成草稿，不按 Enter。
- dry-run：只日志记录，不点击、不输入。
- 每次决策记录：为什么回复、为什么跳过、截图/消息依据是什么。
- 每个会话的最近处理历史。

## 已完成的第一阶段代码变更

本轮已把“回复前策略闸门”融入核心链路：

1. 新增 `src/core/chat/message-types.ts`
   - 定义结构化消息基础模型。
   - 把当前视觉检测结果转换成 `ObservedChatMessage`。

2. 新增 `src/core/chat/rate-limiter.ts`
   - 提供 keyed sliding window 限流器。
   - 支持全局和单会话频控。

3. 新增 `src/core/chat/reply-policy.ts`
   - 拦截空回复、过长回复、自己消息后的回复、重复回复、过高频回复。
   - 默认全局 1 分钟最多 12 条，单会话 1 分钟最多 4 条。

4. 修改 `src/core/generic-channel-session.ts`
   - 保存最近一次消息观察结果。
   - Provider 返回 `reply_text` 后，先走 `ReplyPolicy`。
   - 通过策略才调用 `device.sendMessage()`。
   - 会话启动/停止时清理策略状态。

## 下一阶段实现建议

### 阶段 A：先把安全模式补完整

- 增加草稿模式：输入内容但不自动发送。
- 增加 dry-run 模式：不操作微信，仅记录将要执行的动作。
- 增加 UI 设置项：全局限流、单会话限流、最大回复长度、是否允许群聊自动回复。
- 增加登录异常/二维码界面检测，发现后自动暂停。

### 阶段 B：引入 UIAutomation 感知后端

- 新增 `DesktopPerceptionBackend` 接口。
- 新增 `VisionPerceptionBackend` 兼容现有截图/VLM。
- 新增 `UIAutomationPerceptionBackend`，优先在 Windows 微信上读取控件树。
- 实现消息 runtime id 去重。
- 实现会话列表扫描和未读队列。

### 阶段 C：群聊能力

- 识别群聊、私聊、公众号、客服。
- 群聊默认只处理 @、关键词和命令。
- 支持群白名单、联系人白名单。
- 支持回复前人工确认。

### 阶段 D：长期记忆和主人风格学习

- 先做“可编辑回复样例库”，不要直接自动学习所有聊天记录。
- 用人工确认的回复作为正样本。
- 支持按联系人/场景拆分风格。
- 生成回复时引用最近上下文、常用短语、禁用语。
- 所有学习数据本地可查看、可删除、可导出。

## 外部来源

- wxauto: https://github.com/cluic/wxauto
- WeChatFerry: https://github.com/lich0821/WeChatFerry
- LangBot: https://github.com/langbot-app/LangBot
- CowAgent / chatgpt-on-wechat: https://github.com/zhayujie/chatgpt-on-wechat
- wechat-daily-report-bot: https://github.com/perrycan/wechat-daily-report-bot
