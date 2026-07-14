# SightFlow 1.0.0 商用试点真机验收清单

本清单适用于在真实客服 Windows 机器上完成商用试点第一次验收,所有项必须打勾才能宣告试点启动。

## 0. 准备

- [ ] 拿到 SightFlow-1.0.0-setup.exe(真机构建,非沙箱解压版)
- [ ] 拿到商用授权码 SF-COM-XXXX-XXXX-XXXX(若已签合同)
- [ ] 拿到客户内部署的回复模型 / 视觉模型 Base URL 与 API Key
- [ ] 拿到知识库 JSON / CSV 文件(可选)
- [ ] 准备一台独立的备用手机或客户微信小号,用于冒烟用例
- [ ] 准备一份 pilot-install-guide.zh-CN.md,按章节走

## 1. 部署前 6 项检查

- [ ] 操作系统是 64 位 Windows 10 22H2+ 或 Windows 11
- [ ] 任务管理器里没有残留的 WeChat.exe / WXWork.exe / SightFlow.exe
- [ ] 屏幕缩放 100% 或 125%(右键桌面 → 显示设置 → 缩放)
- [ ] 测试 ping 通视觉模型 / 回复模型 / 授权服务
- [ ] C 盘剩余空间 ≥ 5 GB
- [ ] 杀毒软件已对 SightFlow 安装目录放行

## 2. 安装后基础验证

- [ ] SightFlow 安装在 C:\Program Files\SightFlow
- [ ] 桌面有 SightFlow 快捷方式
- [ ] 开始菜单能找到 SightFlow 卸载项
- [ ] 第一次启动自动弹出初始化向导(4 步:IM 选择 / 模型配置 / 知识库 / 烟雾测试)
- [ ] 初始化完成后,重启 SightFlow 不再弹向导
- [ ] 状态栏不再显示"未激活"

## 3. 授权验证

- [ ] 不填激活码 → 状态显示"试用 14 天"
- [ ] 填入 SF-COM- 开头激活码 → 状态显示"商用 366 天"
- [ ] 控制台 → 授权 面板显示的机器码和服务端登记一致
- [ ] %APPDATA%\SightFlow\license.json 内容包含正确 plan / expiresAt

## 4. 6 条最小冒烟用例

在控制台 → 概览 面板观察每一次消息产生的 trace:

- [ ] 用例 1:用备用手机给客服号发"在吗" → 5 秒内收到自动回复,trace 状态 = sent
- [ ] 用例 2:用客服电脑自己发"你好"给客户 → 不触发自动回复,trace 状态 = skipped,原因 = own-message
- [ ] 用例 3:用备用手机发"我要投诉" → 不自动回复,trace 状态 = blocked,原因含 high-risk
- [ ] 用例 4:把客服号加到一个测试群,不发 @ 直接发消息 → 不自动回复,trace 状态 = skipped,原因含 group-not-mention
- [ ] 用例 5:在群里 @ 客服号 → 自动回复,trace 状态 = sent
- [ ] 用例 6:把 IM 主窗口最小化 / 切到桌面 → Console 出现 warning / 引擎自动暂停

## 5. 8 小时稳定性

- [ ] 让 SightFlow 连续开机 8 小时,期间用备用手机随机发 30 条消息
- [ ] 8 小时后 SightFlow 进程仍在(任务管理器)
- [ ] 内存增长 < 200 MB(用 perfmon 或任务管理器观察)
- [ ] Console 没有出现红色 failed trace
- [ ] Console → 诊断 导出诊断包,确认 zip 包含 traces / screenshots / config

## 6. 审计与可观测

- [ ] Console → 会话记录 能看到本次 8h 跑过的所有 trace
- [ ] 点开任意一条 sent trace,能看到:截图、识别结果、模型输入摘要、策略判断、发送结果、耗时
- [ ] Console → 概览 顶部 6 个数字与 sessions 数对得上
- [ ] Console → 知识库 面板显示导入的条目数

## 7. 回滚演练(等级 A)

- [ ] 在主界面点停止引擎 → 状态变 idle
- [ ] 备用手机发消息 → 不再自动回复,只生成草稿
- [ ] 点启动引擎 → 恢复自动回复
- [ ] 把某客户设为"人工接管" → 该会话不再自动回复,其它会话仍正常
- [ ] 把该客户取消"人工接管" → 恢复自动回复

## 8. 配置导入导出(批量部署前必跑)

- [ ] 在本机控制台 → 设置 导出当前配置,得到 sightflow-settings-*.json
- [ ] 复制到第二台客服机,导入配置
- [ ] 重启后,第二台客服机的设置和第一台一致(授权码 / 知识库 / trace 不导入,符合预期)
- [ ] 第二台客服机跑用例 1 ~ 3,全部通过

## 9. 现场文档核对

- [ ] 客服电脑桌面有 pilot-install-guide.zh-CN.md 快捷方式
- [ ] 客服电脑桌面有 pilot-faq.zh-CN.md 快捷方式
- [ ] 实施工程师留存了 pilot-rollback.zh-CN.md 打印件
- [ ] 工程 oncall 邮箱已加入客服侧的故障通知群

## 10. 验收签字

| 角色 | 姓名 | 日期 | 签字 |
| --- | --- | --- | --- |
| 实施工程师 | | | |
| 客户对接人 | | | |
| 客服负责人 | | | |
| SightFlow oncall | | | |

4 项全部签字 + 9 个章节全部打勾后,把本清单 + 诊断包 + license.json 备份,作为试点第一周交付物归档。
