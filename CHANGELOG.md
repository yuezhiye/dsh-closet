# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.6] - 2026-10-19

### 新增

- **扫描表支持一键全选**：表头第一个单元格现在是复选框，点一下把当次扫描出的所有可清运文件勾上，再点一下全部取消。被 git 跟踪的文件不参与全选（它们本来就不允许清运），因此「全选」不会勾出注定失败的行。手动只勾一部分时，表头复选框显示为半选（横线）状态。

## [0.1.5] - 2026-10-19

### 修复

- **面板表格里的判定标签被挤成两行**：窗口或设置页较窄时，「待确认」会折成「待确 / 认」。标签现在强制 `white-space: nowrap` 且 `display: inline-block`；同时新增 `tdFit`（`width:1%; white-space:nowrap`）应用到「勾选框 / 大小 / 判定」这类定宽不需要拉伸的列，让浏览器把剩余宽度全部让给「文件」与「理由」；文件列改 `word-break: break-all`，长路径在单元格内正常换行而不是撑破表格。回收站表格的「条目 / 体积 / 还原」三列同样按内容定宽，批次号列允许折断。

## [0.1.4] - 2026-10-19

### 修复

- **`peerDependencies` 的预发布范围匹配不到当前内核**：原范围写的是 `>=0.2.0-rc.0 <0.3.0-0`。node-semver 只有在「比较符的 `major.minor.patch` 元组与版本完全一致、且该比较符自身带预发布标签」时才放行预发布版本，因此这个看似覆盖整个 0.2 线的范围**匹配不到 0.2.1-rc.2**（内核当前版本），用户 `npm install` 会撞 `ERESOLVE` 并需要手工加 `--force`。已改为逐个小版本枚举的 `||` 分支（`>=0.2.0-0 <0.3.0-0 || >=0.2.1-0 <0.3.0-0 || …`，覆盖 0.2.0–0.2.9），`engines.dsh` 同步修正。这是插件市场贡献指南里点名的常见坑。

### 测试

- 修掉一条**测试隔离**导致的偶发假失败：`test/trash.test.js` 的「工作区外文件被拒绝」用例把「逃逸文件」直接放在共享的 `..\\.dsh-fix\\testtmp\\run\\` 根目录下，而 `node --test` 会让多个测试文件并行起进程，另一个进程启动时 `makeTempDir` 的 `sweepStale` 会无条件清掉该根目录下的非目录条目 —— 文件被别的进程删掉，断言就随机挂。改为把工作区与外部目录都建成独立 `outer` 目录下的兄弟目录，连续跑 3 次均 108/108。单测总数仍为 108。

## [0.1.3] - 2026-10-19

### 修复

- **面板「清运」从来没搬动过任何文件**：`moveToTrash` 历史上只认 `{ path }` 对象，而面板的 `POST /clean` 传的是路径字符串数组，于是每一项都被当成「空路径」跳过 —— 批次目录照建、清单里却是「0 条目 0 体积」的幽灵记录。现在 `moveToTrash` 同时接受路径字符串与 `{ path, reason }` 对象两种形状。
- **不再产生空批次**：批次目录改为「真有文件搬进来才创建」，一个都没搬成时直接返回 `batch: null`，回收站清单里不会再出现空壳记录。工具侧文案同步改为「一个文件都没搬成，没有生成回收站批次」。
- **扫描体积永远显示 0**：`lib/scan.js` 的汇总字段是 `summary.bytes`，面板读的却是 `summary.totalBytes`，取不到就落到 `|| 0`。已改正。
- **点「连接」后还要再点一次「扫描」**：`connect` 现在一次拉全 status/scripts/trash/scan，进入面板时若工作区已有内容会自动连一次，扫描结果随连接一起出现。

### 测试

- 端到端冒烟新增两条**路由层**用例：`POST /clean` 真的把文件搬进回收站并让批次统计不再为 0；全部失败时不留下空批次。此前冒烟只走工具层（`closet_clean`），路由层的形状错配一直没被拦住。冒烟 16 → 18 条。
- 单测 106 → 108 条（补字符串数组入参与空批次语义）。

## [0.1.2] - 2026-10-19

### 修复

- **插件无法启动的致命 bug**：`lib/config.js` 在拿不到 `@deepseek-ai/schemastery` 时把 `Config` 退化成纯函数 `(value) => normalizeConfig(value)`，而内核用 `isNativeConfigSchema` 判定配置时要求四条同时成立（对象或函数 / `Symbol.for("schemastery") === true` / `type` 是字符串 / `meta` 是非 null 对象），纯函数一条都不满足，于是加载即报 `dsh: error: Config is not a native Schemastery schema` 并把该插件标记为 `unsupported`。改为手写满足四条件的兼容 schema（`validate` 委托 `normalizeConfig`，并带 Standard Schema 的 `~standard.validate`），拿不到 schemastery 也不会失配。
- 说明：`@deepseek-ai/schemastery` 并不在 profile 的 `node_modules` 里（它打包在 `app.asar` 内），因此这里的兜底分支是常态路径而不是罕见路径。

### 新增

- `lib/config.js` 导出 `CONFIG_FIELDS`（每个配置项的键名、类型、说明、默认值），供面板与文档共用同一份真源。

### 测试

- 新增 `test/config-schema.test.js`（7 条）：逐字复刻内核的 `isNativeConfigSchema` 四条判定，钉住「四条件必须全中」，并用反面用例锁死「纯函数式 Config」这个错误写法。单测 99 → 106 全绿。
- 真装验证（沙盒 profile `closet-test`）：`dsh --profile closet-test --dump-config-schema` 从 exit=1、`status: "unsupported"`、`Config is not a native Schemastery schema`，变为 **exit=0、`status: "schema"`、`diagnostics: []`**。

## [0.1.1] - 2026-10-18

### 新增

- **git 跟踪保护**（`lib/git.js`）：扫描照常列出已被版本库跟踪的文件，但标 `tracked` + 追加「⚠ 已被 git 跟踪」，判定固定为 `review`；`closet_clean` 默认整批拒收被跟踪文件（全部被拦时抛 `CLOSET_TRACKED_FILE`），确需处理要显式 `force: true`；`closet_scan` 的 `skipTracked: true` 可完全不显示它们。`git ls-files` 结果带 15 秒 TTL 缓存并合并并发请求，任何 git 失败都降级为「保护未生效」并在输出里明说。
- 面板：被跟踪行显示「git 已跟踪」标签且复选框禁用，并新增「隐藏已被 git 跟踪的文件」开关。

### 修复

- `resolveWorkspace` 只认 `ctx.get('workingDirectory').path`，当宿主给的是字符串时会静默回退到 `process.cwd()`，导致工具在不带 `workspace` 参数时操作错目录。

### 测试

- 新增 `test/git-protect.test.js`（9 条）与 `test/clean-git.test.js`（5 条），单测 85 → 99 全绿。

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
- **git 跟踪保护**（`lib/git.js`）：扫描照常列出已被版本库跟踪的文件，但标 `tracked` + 追加「⚠ 已被 git 跟踪」，判定固定为 `review`；`closet_clean` 默认整批拒收被跟踪文件，确需处理要显式 `force: true`；`closet_scan` 的 `skipTracked: true` 可完全不显示它们。`git ls-files` 结果带 15 秒 TTL 缓存并合并并发请求，任何 git 失败都降级为「保护未生效」并在输出里明说，绝不影响扫描本身。

### 测试

- 单测 99 条（store / scan / run / trash / git 保护 / 契约自检）。
- 端到端冒烟 `test/smoke.mjs` 16 条：用假 ctx 真注册 7 个工具与 8 条路由，在系统临时目录建一次性工作区，跑完登记 → 扫描 → 执行 → 清运 → 回收站 → HTTP 接口全链路，并校验每个工具的返回值都过得了自己的 `output.schema`。
- `test/docs-check.mjs`：文档里提到的工具名与模块必须真实存在，防止 README 写漂。
- `test/host-stubs.js`：用 `module.register()` 把 `@deepseek-ai/dsh-llm` 等宿主包替换成桩，让 `lib/index.js` 在纯 Node 下也能 import 并受测。

### 已知限制

- 面板不提供「新增登记」表单，登记以 AI 工具调用或手改 `registry.json` 为准。
- `expire` 之外的删除行为不在本插件职责内：本插件永不动 `.dsh-fix/` 以外的文件。
- git 保护只认「当前工作区所在的仓库」；工作区不是仓库、或本机没装 git 时保护自动降级（会在扫描结果里提示）。
- 扫描的判定依据仍是文件名/后缀模式，`src/fix-imports.ps1` 这类正经文件会被列出（但被 git 跟踪的话不可清运）。
