# SightFlow.dev

<img width="1201" height="495" alt="SightFlow" src="https://github.com/user-attachments/assets/99a7cfec-eb22-4f65-8a76-a6974e46bcf0" />

Official website: [https://sightflow.dev](https://sightflow.dev/)

用户使用说明书：[/docs/user-guide.zh-CN.md](./docs/user-guide.zh-CN.md)

## 项目简介

SightFlow Desktop Agent 是一个桌面聊天智能体。它可以观察指定聊天窗口中的新消息，调用模型分析聊天内容，并把生成的回复发送到当前聊天窗口。

当前项目重点能力包括：

- 微信 / 企业微信桌面聊天辅助回复
- 基于视觉模型的窗口布局识别
- 手动框选模式下的多桌面聊天软件支持
- 视觉模型与回复模型分开配置
- 设置页内的连接测试、模型拉取、诊断导出、启动前预检

## AI 模型与智能体配置

项目依赖 OpenAI 兼容接口。

桌面端配置主要分成两层：

- 基础配置：填写视觉模型和回复模型的 API Key、模型名、Base URL。
- 智能体：选择负责聊天分析和回复生成的 Provider。

如果你只配置了视觉模型，也可以在设置页中把视觉配置一键同步到回复模型配置。

## 目标应用与识别方式

主界面提供目标应用选择，用来决定桌面端如何测量聊天窗口布局：

- 微信、企业微信：默认优先使用 VLM 自动识别
- 钉钉、飞书、Slack、Telegram、其他桌面应用：默认使用手动框选

框选模式下，首次使用需要依次框选：

1. 会话列表
2. 聊天内容区
3. 输入框

框选结果会保存到本地，后续可复用，也可以随时重新框选。

## 启动前建议

启动前建议先完成以下检查：

1. 视觉模型和回复模型配置完整
2. 在设置页点击测试连接
3. 在设置页拉取或刷新模型列表
4. 查看最近诊断与右侧 Service Health
5. 查看 Startup Preflight 是否显示“可启动”

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 本地开发运行

```bash
npm run dev
```

启动后请先完成：

- 选择目标应用
- 必要时完成框选
- 打开设置页填写模型配置
- 确认当前启用的智能体

### 3. 构建检查

```bash
npm run typecheck
npm run build
```

### 4. 打包

```bash
# Windows
npm run build:win

# macOS
npm run build:mac
```

## Provider Hub

当前应用内置一个简单的 Provider Hub：

- 默认从 `https://sightflow.dev/provider-hub.json` 拉取候选 Provider 列表
- 首次加载后会缓存到本地
- 本地始终保留内置的豆包 Seed 作为默认 Provider

外部 Provider 接入说明见：[/docs/provider.md](./docs/provider.md)

## 相关文档

- 用户使用说明：[/docs/user-guide.zh-CN.md](./docs/user-guide.zh-CN.md)
- Provider 接入：[/docs/provider.md](./docs/provider.md)
- 项目分析：[/docs/project-analysis.zh-CN.md](./docs/project-analysis.zh-CN.md)
- 长期路线图：[/docs/roadmap.long-term.zh-CN.md](./docs/roadmap.long-term.zh-CN.md)
- WorkBuddy 接手计划：[/docs/workbuddy-handoff-plan.zh-CN.md](./docs/workbuddy-handoff-plan.zh-CN.md)


## 工程基线（1.0.0 商用版）

以下是接手人在新机器上能复现的最小命令集。三条命令全部为绿色才能认为基线 OK：

```bash
npm run typecheck       # node + web 双 0 错
npm run test:core       # 11/11 套件全过（Redact / ReplyPolicy / KB / UIA / CircuitBreaker / SettingsExport 等）
npm run build           # Vite 三 bundle 成功
npm run stability:sim   # 8h 模拟跑 out/stability-report.json（0 崩溃 / p99<5s / 内存<200MB）
npm run acceptance:check # 55/55 断言（源文件 / 试点文档 / IPC / 安全闸门 / 子命令 / 必备 scripts）
```

当前快照（2026-06-23）：

| 指标 | 值 |
| --- | --- |
| typecheck | node + web 0 错 |
| test:core | 11/11 套件 |
| build | main 140KB / renderer 554KB |
| acceptance:check | 55/55 断言 |
| 8h 模拟 | 14400 消息 / 0 崩溃 / 发送 200 / 拦截 2846 / 跳过 11354 |
| p99 延迟 | 3.15s |
| 内存增长 | 5.1MB |
| 燃断器 | 未跳 |

新接入测试或修改后，至少需要把上面 4 条命令跑通再发版。完整变动记录见 [CHANGELOG.md](./CHANGELOG.md)。
## 开发环境建议

- [VSCode](https://code.visualstudio.com/)
- [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)
- [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
