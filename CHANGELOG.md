# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-18

首个可用版本。

### 新增

- **登记册**：`<工作区>/.dsh-fix/registry.json`，记录脚本路径、语言、用途、状态（active/done/obsolete）、创建时间、运行次数；原子写 + 损坏自愈（坏文件改名留存，重建空表）。
- **只读扫描**：按文件名模式（fix/patch/upgrade/restart/cleanup 前缀、`.bak`/`.tmp`/`.orig` 等后缀）与临时目录名（`tmp`、`scratch`、`.cache` 等）判定疑似遗留物，给出 `keep` / `archive` / `review` 建议与理由；支持 `ignore` 配置（目录名与 glob）与深度、文件数上限。
- **多语言执行**：PowerShell / Node / Python / 批处理 / Shell，按扩展名自动识别；每次执行输出落到 `.dsh-fix/logs/<脚本名>/<时间戳>.log`；超时用 `taskkill /T` 杀整棵进程树。
- **可还原回收站**：批次目录 + `manifest.json`；还原前检查原位置是否已被新文件占用（不覆盖用户文件）；过期清理是唯一真删入口，默认 30 天、默认只预演。
- **7 个 Agent 工具**：`closet_register` / `closet_list` / `closet_scan` / `closet_run` / `closet_clean` / `closet_trash` / `closet_logs`。
- **设置面板**：「设置 → 脚本与日志」，四个分区（已登记脚本 / 扫描遗留物 / 回收站 / 执行日志），走 `/dsh-closet/api/*` 同源接口，无第三方 UI 依赖。
- **安全边界**：所有移动操作做「字面路径 + 真实路径」双重内区校验，挡 `..` 穿越、大小写变体、软链接/目录联接绕过；扫描不跟随软链接。

### 测试

- 单测 85 条（store / scan / run / trash / 契约自检）。
- 端到端冒烟 `test/smoke.mjs` 16 条：用假 ctx 真注册 7 个工具与 8 条路由，在系统临时目录建一次性工作区，跑完登记 → 扫描 → 执行 → 清运 → 回收站 → HTTP 接口全链路，并校验每个工具的返回值都过得了自己的 `output.schema`。
- `test/docs-check.mjs`：文档里提到的工具名与模块必须真实存在，防止 README 写漂。
- `test/host-stubs.js`：用 `module.register()` 把 `@deepseek-ai/dsh-llm` 等宿主包替换成桩，让 `lib/index.js` 在纯 Node 下也能 import 并受测。

### 已知限制

- 面板不提供「新增登记」表单，登记以 AI 工具调用或手改 `registry.json` 为准。
- `expire` 之外的删除行为不在本插件职责内：本插件永不动 `.dsh-fix/` 以外的文件。
- 未做「git 已跟踪文件」保护（扫描会列出 `src/fix-imports.ps1` 这类正经文件，只是标 `review`，不会自动清理）。
