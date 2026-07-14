# SightFlow Changelog

本 CHANGELOG 按 12 周商用路线图组织,每条记录都对应到路线图里的某个里程碑,方便团队 review 时按周回溯。

## 1.0.0 — 2026-06-23 商用试点首发

第一版商用试点,默认 auto-send 模式,带完整安全闸门。

### 第 1-2 周:稳定主链路

- 修复 src/main/index.ts 的文件头 UTF-8 BOM 与 30+ 处三元/optional chaining/zh 占位符错位。
- 修 try/catch 闭合、`app.whenReady().then()` 嵌套、null 断言。
- 顶层声明 `settingsExportService` / `onboardingCompletedAt`,在 app.whenReady 中实例化。
- `setHumanHandoff` reason 改可选、IPC handler 收集齐全。
- 验收:`npm run typecheck` / `npm run test:core`(9/9)/ `npm run build` 全过。

### 第 3-4 周:结构化消息识别

- `ObservedChatMessage` 商用字段扩展:`messageId` / `chatId` / `chatType` / `direction` / `kind` / `content` / `senderName` / `confidence` / `source`。
- 接入 UIAutomation 优先读取 Windows 微信消息控件,失败回退视觉。
- `MessageDedupe` 24 小时内同 message id 不重复回复。
- 验收:同一客户连续发 3 条消息,只回复最新未处理消息;自己发的消息不触发回复。
- 测试:`MessageDedupe`、`UIA chat-messages`、`UIA observed-from-uia` 三个套件。

### 第 5-6 周:全自动安全闸门

- `ReplyPolicy` 扩展:敏感词、金额、投诉、售后争议、群聊策略、黑白名单。
- 自动发送前窗口安全检查:目标 IM、目标输入框、最新消息方向、会话人工接管状态。
- `Session circuit-breaker` 连续失败熔断。
- 自动发送失败后停止会话并生成诊断记录。
- 验收:高风险消息不自动发送;窗口切错、输入框找不到、连续失败时自动暂停。
- 测试:`ReplyPolicy (high-risk)`、`ReplyPolicy (UIA group/scope)`、`Session circuit-breaker`。

### 第 7-8 周:知识库与客服回复质量

- 本地 FAQ / 商品说明 / 售后规则 / 禁答规则 / 品牌语气 知识库模块。
- Provider 输入从"截图"升级为"结构化消息 + 会话上下文 + 知识检索结果 + 截图证据"。
- 模型输出包含:回复文本、引用依据、置信度、是否建议人工接管。
- 低置信度 / 知识库无答案 / 客户情绪负面 / 涉及交易纠纷 不自动发送,转人工或草稿。
- 验收:常见问题回复能引用知识库;未知问题进入人工接管或草稿。
- 测试:`KnowledgeBase`、`RateLimiter`。

### 第 9-10 周:商用控制台与审计

- Console 6 面板:总览 / 会话记录 / Trace 详情 / 知识库 / 授权 / 诊断。
- Trace 回放:截图、识别、决策、发送全过程。
- 运行指标:识别成功率、回复成功率、发送成功率、平均耗时、熔断次数、人工接管次数。
- 诊断导出包:配置摘要 + 错误日志 + 关键截图 + 运行指标。
- 人工接管状态:接管后该会话自动化暂停,人工解除后恢复。
- 验收:每条自动回复都能查到为什么回、回了什么、是否发送成功。
- 新增 IPC:`conversation:list`、`conversation:getTrace`、`conversation:setHandoff`、`knowledge:list`、`knowledge:import`、`license:getState`、`license:activate`、`diagnostics:export`、`settings:export`、`settings:import`、`onboarding:status`、`onboarding:complete`、`onboarding:reset`。

### 第 11-12 周:安装包、授权与试点交付

- Windows NSIS 安装器(electron-builder.yml 已配),出包在真机构建。
- 授权校验:机器码 + 试用期(14 天)+ 商用授权(366 天,SF-COM- 前缀)+ 本地 license.json 缓存。
- 初始化向导(IM 选择 / 模型配置 / 知识库 / 烟雾测试)+ 重新初始化入口。
- 配置导入导出(`SettingsExportService`)。
- 试点交付物:`docs/pilot-install-guide.zh-CN.md`、`docs/pilot-rollback.zh-CN.md`、`docs/pilot-faq.zh-CN.md`、`docs/pilot-acceptance-checklist.zh-CN.md`、`docs/pilot-release-notes.zh-CN.md`。
- 验收:在一台干净 Windows 机器上完成安装、授权、配置、测试自动回复、跑通真机验收清单。
- 测试:`SettingsExportService`(27 断言)。

### 1.0.0-patch1 — 2026-06-23 试点准入收尾

- Console 诊断包面板增加"导出前脱敏" checkbox（默认开），对应 `data-testid="diagnostics-redact-toggle"`。Console 主体保留 `redactDiagnostics` state，导出时将 `{ redact }` 传给 `diagnostics:export` IPC，main 端默认 `redact !== false`，与试点合规默认一致。
- [src/main/diagnostics-service.ts](src/main/diagnostics-service.ts) 接受 `DiagnosticsExportOptions { redact, redactOptions }`，返回值增加 `redacted: boolean` 字段。
- [src/core/redact.ts](src/core/redact.ts) 三个公开函数变成 `options?: RedactionOptions` 可选参数，默认值由 `DEFAULT_REDACTION_OPTIONS` 接管（`stripScreenshots=true`, `redactPII=true`, `keepKnowledgeTitles=false`）。
- [scripts/acceptance-check.mjs](scripts/acceptance-check.mjs) 上线：55 个 assert 覆盖源文件 / 试点文档 / IPC 接线 / 安全闸门代码签名 / test:core / 8h 稳定性报告 / 必备 npm scripts。
- [package.json](package.json) 新增 `npm run stability:sim` 与 `npm run acceptance:check`。
- console.tsx 中控件全部改为 prop 类型签名，避免 TSX 在 prop 类型中把泛型 `<unknown>` / `<void>` 误识别为 JSX 标签的陷阱。
- 验收：`npm run typecheck` 0 错 / `npm run test:core` 11/11 套件全过 / `npm run build` 三 bundle 成功 / `npm run acceptance:check` 55/55 全过。
- 稳定性报告（out/stability-report.json）：8h 模拟 14400 条消息，0 崩溃，发送 200 / 拦截 2846 / 跳过 11354，p99 3.15s，内存增长 5.1MB，燃断器未跳。
## 风险与已知问题

- `npm run build:win` 在受限网络环境(沙箱)会卡在 `app-builder-bin` 拉取,真机出包不受影响。
- 屏幕缩放 150% 及以上 UIAutomation 准确率显著下降,要求客服电脑缩放保持 100% 或 125%。
- Windows 微信 / 企微 大版本更新后布局检测可能失效,需重新走初始化向导。
- 商用授权与机器码绑定,主板更换或重装系统需要重新申请。

## 工程基线(1.0.0)

| 项 | 状态 |
| --- | --- |
| npm run typecheck | 通过(node + web) |
| npm run test:core | 通过(9/9 套件) |
| npm run build | 通过(out/main/index.js 136KB) |
| 单测覆盖模块 | KnowledgeBase / ReplyPolicy x2 / MessageDedupe / RateLimiter / UIA x2 / Session circuit-breaker / SettingsExportService |
| 已注册 IPC handler | 34 个(覆盖 settings / engine / capture / provider / conversation / knowledge / license / onboarding / diagnostics) |

## 后续里程碑(暂定)

- 1.1.0:回复质量回归用例集 + 长期稳定性 8h 自动化。
- 1.2.0:CRM / 工单系统双向同步(本版本只支持单向 trace 导出)。
- 1.3.0:多客服协作 / 知识库云端共享。
- 2.0.0:macOS / Linux 商用支持(本版本只验证 Windows)。
