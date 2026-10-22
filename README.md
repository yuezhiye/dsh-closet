# 收纳间 dsh-closet

> DSH（DeepSeek Harness）的临时脚本与日志管理器：**按工作区登记脚本、只读扫描遗留物、一键清运进可还原回收站。**

中文 | [English](./README.en.md)

DSH 干活时会留下大量临时脚本和日志 —— `fix-xxx.ps1`、`upgrade-xxx.ps1`、`restart-dsh.log`、`*.bak`…… 事后没人记得哪个还能用、哪个已经过期、哪个可以删。

收纳间就是给这些产物准备的**一个抽屉**：放进去的都记在册上，没放的会被扫出来问你，清掉的先进回收站，随时能捞回来。

## 三条铁律

1. **跟着工作区走**：数据存在 `<工作区>/.dsh-fix/`，换工作区就是换一个抽屉，绝不往用户目录乱写。
2. **扫描永不删除**：`closet_scan` 只列清单、给理由，一个字节都不动。
3. **清理只做移动**：`closet_clean` 把文件移进 `.dsh-fix/trash/<批次>/`，附带 `manifest.json` 记录原路径，随时可还原；真正的删除只有「过期清理」一处入口，默认 30 天后才允许，且默认只做预演。

## 目录结构

```
<工作区>/
└── .dsh-fix/                    # 收纳间（dataDir 可配置）
    ├── registry.json            # 登记册：路径/语言/用途/状态/运行次数
    ├── logs/<脚本名>/            # 每次执行的完整输出，按时间戳分文件
    │   └── 20261018-165530.log
    └── trash/<批次>/             # 回收站
        ├── manifest.json        # 每个文件的原路径与体积
        └── <搬进来的文件>
```

## 工具

装上插件后，AI 可以直接调用 8 个工具：

| 工具 | 作用 | 会改文件吗 |
| --- | --- | --- |
| `closet_workspaces` | 列出 DSH 里已登记的工作区（标题、路径、会话数、目录是否还在），最新的排前面；`onlyExisting: true` 只留目录还在的 | 否 |
| `closet_register` | 登记一个脚本：路径、用途、语言、状态（active/done/obsolete） | 只写登记册 |
| `closet_list` | 列出登记册，并标注「文件还在不在」 | 否 |
| `closet_scan` | 扫描工作区，列出疑似遗留物及判定理由；`skipTracked: true` 可完全不显示已被 git 跟踪的文件 | **否** |
| `closet_run` | 按语言执行登记过的脚本，输出写进日志 | 只写日志 |
| `closet_clean` | 把指定文件移进回收站（可还原）；**已被 git 跟踪的文件会被拒收**，确需清运要带 `force: true` | 移动 |
| `closet_trash` | 查看回收站批次；`expire: true` 才做过期清理（默认预演） | 只在过期清理时删除 |
| `closet_logs` | 列出某个脚本的执行日志，或读取某份日志的末尾 | 否 |

也可以在 GUI 的 **设置 → 脚本与日志** 面板里点点点。

### 一个典型回合

```
用户：这次排查完了，把临时脚本收拾一下
AI  ：closet_register { path: ".dsh-fix/upgrade-wbc.ps1", purpose: "升级 workbuddy 连接器", status: "done" }
AI  ：closet_scan → 发现 8 个遗留物（3 个 .bak、2 个日志、3 个临时脚本），附判定理由
用户：前 5 个可以清
AI  ：closet_clean { paths: [...] } → 已移入回收站批次 20261018-165530
```

## 支持的语言

按扩展名自动识别，多语言通用：

| 语言 | 扩展名 | 缺省解释器 |
| --- | --- | --- |
| PowerShell | `.ps1` `.psm1` `.psd1` | `pwsh`，缺失时退到 `powershell.exe` |
| Node | `.js` `.mjs` `.cjs` `.ts` | `node` |
| Python | `.py` | `python`，缺失时退到 `py -3` |
| 批处理 | `.bat` `.cmd` | `cmd.exe /d /c` |
| Shell | `.sh` `.bash` `.zsh` | `bash` |

解释器路径可在配置里覆盖，见下。

## 配置

写在插件条目的 `config` 下（`cordis.yml`，或安装后由 `cordis.patch.yml` 注入的默认值）：

```yaml
dsh-closet:
  enabled: true
  dataDir: .dsh-fix              # 收纳间目录名，相对工作区
  trashRetentionDays: 30         # 回收站保留天数
  ignore: []                     # 额外忽略的目录名或 glob，如 ['*.bak', 'build']
  maxScanFiles: 5000             # 扫描上限，防止在大仓库里扫穿
  maxScanDepth: 64               # 扫描最大深度
  runTimeoutMs: 120000           # 单次执行超时（毫秒）
  maxLogBytes: 2097152           # 单个日志文件上限（字节）
  maxCleanBatch: 200             # 单次最多清运多少项
  maxCleanBytes: 209715200       # 单次最多清运多少字节（200 MB）
  interpreters: {}               # 覆盖解释器，键为语言名，值为 argv 数组
```

`ignore` 里写错的值会被丢弃而不是「忽略一切」——配置写坏只会让扫描结果变多，不会让它变空。

## 面板

安装后在 **设置 → 脚本与日志** 里：

- 已登记脚本：状态、路径、运行次数；文件已被删掉的会标红提示。
- 顶部下拉框：自动列出 DSH 里所有已登记的工作区，选一个就能直接看它的脚本、扫描结果和日志，不用再手打路径；也仍然可以手动填任意目录。
- 扫描遗留物：勾选后点「移进回收站」，一次一批。表头第一个复选框可一键全选（被 git 跟踪的文件不参与），部分勾选时显示半选状态。
- 回收站：按批次列出体积与条目，可一键还原。
- 执行日志：按脚本分组，点开看最近 200 行。

面板接口走 `/dsh-closet/api/*`，只接受同源请求（拒 `cross-site` 与 `origin: null`）。

## 安全设计

- **不会误删**：`closet_clean` 只移动；真正删除只有 `closet_trash { expire: true }` 一条路，默认 `dryRun`。
- **不动版本库里的东西**：扫描会照常列出已被 git 跟踪的文件（标 `tracked` + 「⚠ 已被 git 跟踪」），但判定固定为「待确认」，`closet_clean` 默认整批拒收；确需处理要显式带 `force: true`。工作区不是 git 仓库或本机没装 git 时，保护自动降级并在结果里明说。
- **不会越界**：只能处理**工作区内**的文件；`..` 穿越、大小写变体、软链接/目录联接绕过都被拦截（字面路径与真实路径双重校验）。
- **不会扫穿**：`node_modules`、`.git` 等默认跳过，软链接不跟随，深度与文件数有上限。
- **不会写坏**：`registry.json` 走「写临时文件 → rename」的原子写；文件损坏时先改名留存现场再重建。
- **不会拖死**：脚本执行有超时保护，超时用 `taskkill /T` 连同子进程整棵树杀掉（POSIX 走进程组）。

## 开发

```bash
npm test           # 单测 115 + 端到端冒烟 18 + 文档一致性；零依赖，全用 Node 内置 test runner
npm run test:unit  # 只跑单测
npm run lint:syntax
```

项目结构：

```
lib/
├── store.js    登记册读写（原子写、路径规范化、语言识别）
├── scan.js     遗留物扫描（只读）
├── run.js      多语言执行（spawn + 日志 + 超时 + 进程树强杀）
├── trash.js    回收站（移动/还原/过期清理）
├── config.js   配置归一化 + 原生 Schemastery schema（拿不到内核依赖时用自带的兼容 schema）
├── routes.js   HTTP 面板接口
├── client.js   设置面板（CJS factory 单文件，无需构建）
├── workspaces.js 读 DSH 的工作区登记表（只读，拿不到就降级返回空列表）
└── index.js    插件入口，8 个工具的定义与装配

test/
├── *.test.js       单测（store / scan / run / trash / contract）
├── smoke.mjs       端到端冒烟：真 ctx + 真文件系统，工具与路由都跑一遍
├── docs-check.mjs  文档与实现一致性（工具名 / 模块 / 版本号）
└── host-stubs.js   把 @deepseek-ai/dsh-llm 等宿主包替换成桩，让纯 Node 也能 import 入口
```

`store` / `scan` / `run` / `trash` 四层**不依赖 DSH**，可以单独用、单独测、换宿主也能跑。

`lib/client.js` 是手写的 `window.__ModuleLoader__` CJS factory，改完不需要重启，HMR 会自己刷新（React 组件状态会丢）。改 `lib/index.js`、`package.json` 或 `cordis.patch.yml` 需要重启 DSH。

## 许可

MIT
