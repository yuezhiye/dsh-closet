/**
 * dsh-closet 插件入口。
 *
 * 这里只做三件事：归一化 config、把四个纯逻辑模块包成 Agent 工具、把面板路由挂上。
 * 所有碰文件的操作都下沉在 lib/{store,scan,run,trash}.js 里，本文件不直接操作磁盘，
 * 这样纯逻辑层可以脱离 DSH 单独测试。
 *
 * 【为什么 inject 必须写 'tools'】
 * cordis 只在 inject 声明的服务齐全时才调用 apply()。不写 'tools'，ctx.tools 就是
 * undefined，注册代码整段不执行 —— 插件看起来装上了，实际一个工具都没有。
 * 这是第三方插件最常见的「装了但没反应」原因。面板用的 webServer 走 ctx.inject 二次注入，
 * 不写进这里，否则没有 webServer 的 headless 环境会让整个插件拒绝加载。
 */

import { HarnessError } from '@deepseek-ai/dsh-llm';

import { Config, DEFAULTS, normalizeConfig } from './config.js';
import {
  closetPaths,
  list as listEntries,
  register as registerEntry,
  unregister as unregisterEntry,
  markRun as markEntryRun,
  readRegistry,
  ensureLayout,
} from './store.js';
import { scan as scanWorkspace, listLogs } from './scan.js';
import { runScript, tailLog } from './run.js';
import { moveToTrash, listTrash, restoreBatch, expireTrash } from './trash.js';
import { installWebServer } from './routes.js';
import { partitionTracked } from './git.js';

export const name = 'dsh-closet';

/** 需要工具注册表；面板路由走 ctx.inject(['webServer'], ...) 单独注入，不占这里。 */
export const inject = ['tools'];

export { Config };
export { DEFAULTS };

/**
 * 工具定义（声明与实现）单独放在这个数组里，`registerTools` 只负责把它们逐条交给 ctx.tools。
 *
 * 为什么不在 registerTools 里直接写 ctx.tools.register({...})：工具的参数 schema 受内核
 * 严格限制（只支持 JSON Schema 的一个子集，`pattern` / `minLength` / `anyOf` 这类会**在注册期
 * 直接抛错**），一旦写错，表现是「插件装上但整段 apply 抛异常」。把定义抽成纯数据后，
 * test/contract.test.js 可以在不启动 DSH 的情况下逐条校验形状，装配期不再冒这个险。
 *
 * 元素形状与 ctx.tools.register 的入参一致，只是多了 `execute(ctx, args, exec)` 第一参数，
 * 由 registerTools 在装配时用闭包包上。
 *
 * 注意：这个数组在 module 求值期被下面的 defineTool 逐条填充，所以它必须声明在那些调用**之前**。
 */
export const toolDefs = [];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} rawConfig cordis.patch.yml 里该行的 config，已由 Config 校验填默认值
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);

  // 面板是可选能力：没有 webServer（比如 headless 场景）就静默跳过，不影响工具可用。
  installWebServer(ctx, config);

  if (!config.enabled) return;
  if (!ctx.tools) return;

  registerTools(ctx, config);
}

/**
 * 统一的工作区取值：工具的 workspace 参数优先，缺省用 ctx 提供的当前工作目录。
 * 两者都拿不到就直接报错 —— 绝不能拿一个「猜的」目录当回收站边界。
 */
function resolveWorkspace(ctx, given) {
  const fromCtx = ctx.get?.('workingDirectory');
  const ws = given || (typeof fromCtx === 'string' ? fromCtx : fromCtx?.path) || process.cwd();
  if (!ws || typeof ws !== 'string') {
    throw new HarnessError('拿不到工作区路径，请显式传 workspace', 'CLOSET_NO_WORKSPACE');
  }
  return ws;
}

/** exec.signal 被取消时立刻抛错，避免白跑。 */
function throwIfAborted(exec) {
  if (exec && exec.signal && exec.signal.aborted) {
    throw new HarnessError('工具调用已被取消', 'CLOSET_ABORTED');
  }
}

/** 统一的文本输出块。render 只返回 text 块 —— 消息层对 text 的支持最确定。 */
const textRender = (_args, value) => [{ type: 'text', text: String(value && value.text ? value.text : '') }];

/** 工具输出 schema 复用同一个形状：全部是 { text, ...少量标量 }。 */
function outSchema(extraProps, requiredExtra = []) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['text', ...requiredExtra],
    properties: {
      text: { type: 'string', description: '给人看的文本结果，会原样渲染到界面' },
      ...extraProps,
    },
  };
}

/** 字节数转人话，清单里天天用。 */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 登记一条工具定义：往 toolDefs 里追加一项纯数据描述。
 *
 * 定义里只写 name/description/parameters/output/execute（execute 的第一参数是 ctx，
 * 由 registerTools 装配时补上），这样测试可以直接对 toolDefs 做 schema 体检。
 */
function defineTool(def) {
  toolDefs.push(def);
}

/**
 * 把纯数据定义装配进 ctx.tools。
 * 装配层只做一件事：用闭包把 ctx 与归一化后的 config 交给 execute，其余原样转发 ——
 * 保证测试看到的 schema 与内核真正校验的是同一份对象。
 */
function registerTools(ctx, config) {
  for (const def of toolDefs) {
    ctx.tools.register({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: def.output,
      presentationMeta: def.presentationMeta,
      execute: (args, exec) => def.execute(ctx, args, exec, config),
    });
  }
}

  // ── closet_register ────────────────────────────────────────────────
  defineTool({
    name: 'closet_register',
    description:
      '把一个临时脚本登记到当前工作区的收纳间（登记册）。记录路径、语言、用途，之后可以查找、运行与清运。' +
      '只登记，不执行脚本、不移动文件。同一路径重复登记视为更新用途。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'purpose'],
      properties: {
        path: { type: 'string', description: '脚本路径。相对工作区根，或绝对路径但必须落在工作区内' },
        purpose: { type: 'string', description: '这个脚本是干什么用的，一句话说明' },
        language: {
          type: 'string',
          description: '脚本语言；省略时按扩展名自动识别',
          enum: ['powershell', 'node', 'python', 'batch', 'shell'],
        },
        notes: { type: 'string', description: '附加备注，可省略' },
        workspace: { type: 'string', description: '工作区根目录；省略时取当前工作目录' },
      },
    },
    output: {
      schema: outSchema({ id: { type: 'string' }, path: { type: 'string' }, created: { type: 'boolean' } }, [
        'id',
        'path',
      ]),
      render: textRender,
    },
    async execute(ctx, args, exec, config) {
      throwIfAborted(exec);
      const workspace = resolveWorkspace(ctx, args.workspace);
      await ensureLayout(workspace);
      const { entry, created } = await registerEntry(workspace, {
        path: args.path,
        purpose: args.purpose,
        language: args.language,
        notes: args.notes,
      });
      return {
        id: entry.id,
        path: entry.path,
        created,
        text: [
          created ? '已登记到收纳间' : '该脚本已在册，用途已更新',
          `  编号：${entry.id}`,
          `  路径：${entry.path}`,
          `  语言：${entry.language}`,
          `  用途：${entry.purpose}`,
        ].join('\n'),
      };
    },
  });

  // ── closet_list ────────────────────────────────────────────────────
  defineTool({
    name: 'closet_list',
    description:
      '列出当前工作区收纳间里登记的脚本，带状态、运行次数、日志条数与文件是否还在。' +
      '可按状态过滤（active 在用 / done 已完成 / obsolete 待清运）。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          description: '只列出该状态的条目；省略则全部列出',
          enum: ['active', 'done', 'obsolete'],
        },
        limit: { type: 'number', description: '最多返回多少条，默认 50' },
        workspace: { type: 'string', description: '工作区根目录；省略时取当前工作目录' },
      },
    },
    output: {
      schema: outSchema({ count: { type: 'number' } }, ['count']),
      render: textRender,
    },
    async execute(ctx, args, exec, config) {
      throwIfAborted(exec);
      const workspace = resolveWorkspace(ctx, args.workspace);
      const { scripts, recovered, error } = await listEntries(workspace, { status: args.status });
      if (scripts.length === 0) {
        const tail = recovered ? `\n（登记册损坏已重建：${error}）` : '';
        return { count: 0, text: `收纳间是空的（${closetPaths(workspace).registry}）。${tail}` };
      }
      const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 50;
      const shown = scripts.slice(0, limit);
      const lines = [`共 ${scripts.length} 条，显示 ${shown.length} 条：`];
      for (const e of shown) {
        const flags = [];
        if (e.exists === false) flags.push('⚠ 文件已不存在');
        if (e.runs) flags.push(`运行 ${e.runs} 次`);
        if (e.lastRunAt) flags.push(`上次 ${e.lastRunAt}`);
        lines.push(`- [${e.status}] ${e.id}  ${e.path}`);
        lines.push(`    (${e.language}) ${e.purpose}${flags.length ? `  ${flags.join(' · ')}` : ''}`);
      }
      if (scripts.length > shown.length) lines.push(`…还有 ${scripts.length - shown.length} 条，用 limit 调整`);
      return { count: scripts.length, text: lines.join('\n') };
    },
  });

  // ── closet_scan ────────────────────────────────────────────────────
  defineTool({
    name: 'closet_scan',
    description:
      '只读扫描当前工作区里的遗留物：台账外疑似临时脚本、临时产物（.bak/.orig/.rej 等）、孤儿日志、已结项条目。' +
      '给每项标出 type 与理由，**绝不删除、也绝不移动任何文件**，扫描前后文件树完全一致。' +
      '清理前必须先跑这个拿到清单，再把清单交给用户确认。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeUnregistered: { type: 'boolean', description: '是否列出未登记的疑似临时脚本，默认 true' },
        skipTracked: {
          type: 'boolean',
          description: 'true 则把已被 git 跟踪的文件从清单里完全剔除（最保守）；默认 false，只看不删',
        },
        maxFiles: { type: 'number', description: '最多检查多少个文件，默认取配置 maxScanFiles' },
        workspace: { type: 'string', description: '工作区根目录；省略时取当前工作目录' },
      },
    },
    output: {
      schema: outSchema({ count: { type: 'number' }, bytes: { type: 'number' }, truncated: { type: 'boolean' } }, [
        'count',
        'bytes',
      ]),
      render: textRender,
    },
    async execute(ctx, args, exec, config) {
      throwIfAborted(exec);
      const workspace = resolveWorkspace(ctx, args.workspace);
      const { registry } = await readRegistry(workspace);
      const { items, summary, truncated, git } = await scanWorkspace(workspace, registry, {
        includeRegistered: args.includeUnregistered !== false,
        skipTracked: args.skipTracked === true,
        maxFiles: Number.isFinite(args.maxFiles) ? Math.floor(args.maxFiles) : config.maxScanFiles,
        maxDepth: config.maxScanDepth,
        ignorePatterns: config.ignore,
      });

      if (items.length === 0) {
        return { count: 0, bytes: 0, truncated, text: '没有发现遗留物，工作区很干净。' };
      }
      const lines = [
        `发现 ${items.length} 项遗留物，合计 ${fmtBytes(summary.bytes)}（只列出，未做任何改动）：`,
      ];
      for (const it of items) {
        const mark = it.registered ? `[已登记·${it.status}] ` : '';
        lines.push(`${mark}${it.relative}  ${fmtBytes(it.size)}`);
        lines.push(`    type=${it.category}  建议=${it.suggestion}  理由：${it.reason}`);
      }
      if (truncated) lines.push('', '⚠ 文件数超过上限，清单不完整：调大 maxScanFiles 或缩小工作区范围再看。');
      if (summary.tracked) {
        lines.push('', `其中 ${summary.tracked} 项已被 git 跟踪：closet_clean 默认会拒收，确有需要请带 force:true。`);
      } else if (git && git.available === false && git.trackedNotice) {
        lines.push('', `说明：${git.trackedNotice}`);
      }
      return { count: items.length, bytes: summary.bytes, truncated, text: lines.join('\n') };
    },
  });

  // ── closet_run ─────────────────────────────────────────────────────
  defineTool({
    name: 'closet_run',
    description:
      '运行一个已登记的脚本，输出同时回显并写入日志（<收纳间>/logs/<脚本名>/<时间戳>.log）。' +
      '超时会结束整棵进程树（含脚本派生的孙进程）。只允许运行登记册里的脚本。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '登记册里的条目编号' },
        args: { type: 'array', description: '传给脚本的参数', items: { type: 'string' } },
        timeoutMs: { type: 'number', description: '超时毫秒数，省略则取配置 runTimeoutMs' },
        workspace: { type: 'string', description: '工作区根目录；省略时取当前工作目录' },
      },
    },
    output: {
      schema: outSchema(
        { timedOut: { type: 'boolean' }, logFile: { type: 'string' }, durationMs: { type: 'number' } },
        ['logFile'],
      ),
      render: textRender,
    },
    async execute(ctx, args, exec, config) {
      throwIfAborted(exec);
      const { resolve } = await import('node:path');
      const workspace = resolveWorkspace(ctx, args.workspace);
      const { scripts } = await listEntries(workspace, {});
      const entry = scripts.find((e) => e.id === args.id);
      if (!entry) {
        throw new HarnessError(`登记册里没有编号为 ${args.id} 的脚本`, 'CLOSET_NOT_FOUND');
      }

      const result = await runScript({
        workspace,
        scriptPath: resolve(workspace, entry.path),
        language: entry.language,
        args: Array.isArray(args.args) ? args.args : [],
        timeoutMs: Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : config.runTimeoutMs,
        config,
      });

      await markEntryRun(workspace, entry.id);

      const clip = (s) =>
        s.length > 4000 ? `${s.slice(0, 4000)}\n…（输出过长已截断，完整内容见日志）` : s;
      const parts = [
        result.timedOut ? '运行超时（已结束整棵进程树）' : `运行结束，退出码 ${result.code}`,
        `用时：${result.durationMs}ms`,
        `日志：${result.logFile}`,
      ];
      if (result.stdout) parts.push('', '── 标准输出 ──', clip(result.stdout));
      if (result.stderr) parts.push('', '── 标准错误 ──', clip(result.stderr));

      return {
        timedOut: !!result.timedOut,
        logFile: result.logFile,
        durationMs: result.durationMs,
        text: parts.join('\n'),
      };
    },
  });

  // ── closet_clean ───────────────────────────────────────────────────
  defineTool({
    name: 'closet_clean',
    description:
      '把指定路径移入工作区回收站（<收纳间>/trash/<批次>/，可整批还原），**不是直接删除**。' +
      '必须先调用 closet_scan 拿到清单、并向用户确认后才能调用。只接受工作区内的普通文件；' +
      '符号链接、目录、工作区外的路径一律拒绝。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['paths', 'reason'],
      properties: {
        paths: {
          type: 'array',
          description: '要清运的路径列表，必须来自 closet_scan 返回的 relative（相对工作区）或绝对路径',
          items: { type: 'string' },
        },
        reason: { type: 'string', description: '为什么清运，会写进回收站清单，方便日后还原时判断' },
        force: {
          type: 'boolean',
          description: 'true 才允许清运已被 git 跟踪的文件；默认 false（拒收并逐条说明）',
        },
        workspace: { type: 'string', description: '工作区根目录；省略时取当前工作目录' },
      },
    },
    output: {
      schema: outSchema({ moved: { type: 'number' }, failed: { type: 'number' }, batch: { type: 'string' } }, [
        'moved',
        'batch',
      ]),
      render: textRender,
    },
    async execute(ctx, args, exec, config) {
      throwIfAborted(exec);
      const { resolve } = await import('node:path');
      const workspace = resolveWorkspace(ctx, args.workspace);
      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === 'string' && p.trim()) : [];
      if (paths.length === 0) {
        throw new HarnessError('closet_clean 至少需要一个路径', 'CLOSET_EMPTY_PATHS');
      }
      if (paths.length > config.maxCleanBatch) {
        throw new HarnessError(
          `一次最多清运 ${config.maxCleanBatch} 项，请分批进行（本次给了 ${paths.length} 项）`,
          'CLOSET_BATCH_TOO_LARGE',
        );
      }

      await ensureLayout(workspace);
      // 累计体积先看一眼再搬：超上限时整批拒绝，避免「搬了一半才发现太大」
      const { items } = await scanWorkspace(workspace, (await readRegistry(workspace)).registry, {
        includeRegistered: true,
      });
      const sizeByAbs = new Map(items.map((it) => [it.path.toLowerCase(), it.size]));
      let total = 0;
      for (const p of paths) total += sizeByAbs.get(resolve(workspace, p).toLowerCase()) || 0;
      if (config.maxCleanBytes > 0 && total > config.maxCleanBytes) {
        throw new HarnessError(
          `这批文件合计 ${fmtBytes(total)}，超过单次上限 ${fmtBytes(config.maxCleanBytes)}，请分批清运`,
          'CLOSET_TOO_LARGE',
        );
      }

      // ── git 保护（方案 B）────────────────────────────────────────────
      // 属于版本库的文件是「有人认真在管」的，清运它几乎一定是误操作。
      // 默认整条拒收并把哪些是跟踪文件讲清楚；用户带了 force:true 才放行。
      const absList = paths.map((p) => resolve(workspace, p));
      const preBlocked = new Map(); // abs -> 拒绝理由
      if (args.force !== true) {
        const tracked = await partitionTracked(workspace, absList);
        if (tracked.tracked.size > 0) {
          for (const p of tracked.tracked) {
            preBlocked.set(p, '已被 git 跟踪，已跳过（确需清运请带 force:true）');
          }
          if (preBlocked.size === absList.length) {
            throw new HarnessError(
              `这 ${preBlocked.size} 项全部被 git 跟踪，默认拒绝清运：\n` +
                absList.map((p) => `  · ${p}`).join('\n') +
                '\n\n如果确实要清运（例如已从版本库移除），请重新调用并带 force:true。',
              'CLOSET_TRACKED_FILE',
            );
          }
        }
      }

      const allowed = absList.filter((p) => !preBlocked.has(p));
      const { batch, moved, failed } = await moveToTrash(
        workspace,
        allowed.map((p) => ({ path: p, reason: args.reason })),
        { root: workspace, label: 'clean' },
      );
      for (const [p, why] of preBlocked) failed.push({ path: p, error: why });

      // 被清运的脚本若还在登记册里：删掉记录（文件已经在回收站，留着记录只会让 list 出现孤儿）
      const { scripts } = await listEntries(workspace, {});
      for (const m of moved) {
        const hit = scripts.find((e) => String(e.path).toLowerCase() === String(m.from).toLowerCase());
        if (hit) await unregisterEntry(workspace, hit.id).catch(() => {});
      }

      const lines = [`已移入回收站 ${moved.length} 项（批次 ${batch}，可随时还原）：`];
      for (const m of moved) lines.push(`  ✓ ${m.from}  ${fmtBytes(m.size)}`);
      for (const f of failed) lines.push(`  ✗ ${f.path}：${f.error}`);
      lines.push('', `回收站位置：${closetPaths(workspace).trash}`);
      if (failed.length) lines.push('还原：closet_trash action=restore batch=' + batch);

      return { moved: moved.length, failed: failed.length, batch, text: lines.join('\n') };
    },
  });

  // ── closet_trash ───────────────────────────────────────────────────
  defineTool({
    name: 'closet_trash',
    description:
      '回收站操作。action=list 列批次；action=restore 还原指定批次（原位置已有同名文件则拒绝覆盖）；' +
      'action=expire 只报告超过保留期的批次，默认不真删。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          description: 'list 列出 / restore 还原 / expire 查过期',
          enum: ['list', 'restore', 'expire'],
        },
        batch: { type: 'string', description: 'action=restore 时必填，批次目录名' },
        workspace: { type: 'string', description: '工作区根目录；省略时取当前工作目录' },
      },
    },
    output: {
      schema: outSchema({ count: { type: 'number' } }, ['count']),
      render: textRender,
    },
    async execute(ctx, args, exec, config) {
      throwIfAborted(exec);
      const workspace = resolveWorkspace(ctx, args.workspace);

      if (args.action === 'list') {
        const batches = await listTrash(workspace);
        if (batches.length === 0) return { count: 0, text: '回收站是空的。' };
        const lines = [`回收站有 ${batches.length} 个批次：`];
        for (const b of batches) {
          lines.push(`- ${b.batch}  ${b.count} 项  ${fmtBytes(b.bytes)}  ${b.createdAt}${b.label ? `  [${b.label}]` : ''}`);
        }
        lines.push('', '还原：closet_trash action=restore batch=<批次名>');
        return { count: batches.length, text: lines.join('\n') };
      }

      if (args.action === 'restore') {
        if (!args.batch) {
          throw new HarnessError('action=restore 需要 batch 参数', 'CLOSET_NO_BATCH');
        }
        const r = await restoreBatch(workspace, args.batch);
        const lines = [`批次 ${args.batch}：成功 ${r.restored.length} 项，失败 ${r.failed.length} 项`];
        for (const p of r.restored) lines.push(`  ✓ ${p}`);
        for (const f of r.failed) lines.push(`  ✗ ${f.path}：${f.error}`);
        return { count: r.restored.length, text: lines.join('\n') };
      }

      // expire：dryRun，永不真删
      const r = await expireTrash(workspace, { days: config.trashRetentionDays, dryRun: true });
      if (!r.expired.length) {
        return { count: 0, text: `没有超过 ${config.trashRetentionDays} 天保留期的批次。` };
      }
      return {
        count: r.expired.length,
        text: [
          `有 ${r.expired.length} 个批次超过 ${config.trashRetentionDays} 天（仅报告，未删除）：`,
          ...r.expired.map((b) => `- ${b.batch}  ${b.count} 项  ${fmtBytes(b.bytes)}  ${b.createdAt}`),
          '',
          '删除过期批次属于不可逆操作，请在面板确认后再执行。',
        ].join('\n'),
      };
    },
  });

  // ── closet_logs ────────────────────────────────────────────────────
  defineTool({
    name: 'closet_logs',
    description: '列出某个已登记脚本的运行日志，或读取最新一份日志的尾部。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '登记册里的条目编号' },
        lines: { type: 'number', description: '读取最后多少行，默认 120' },
        read: { type: 'boolean', description: 'true 则直接返回最新日志尾部内容；false 只列文件' },
        workspace: { type: 'string', description: '工作区根目录；省略时取当前工作目录' },
      },
    },
    output: {
      schema: outSchema({ count: { type: 'number' } }, ['count']),
      render: textRender,
    },
    async execute(ctx, args, exec, config) {
      throwIfAborted(exec);
      const workspace = resolveWorkspace(ctx, args.workspace);
      const { scripts } = await listEntries(workspace, {});
      const entry = scripts.find((e) => e.id === args.id);
      if (!entry) {
        throw new HarnessError(`登记册里没有编号为 ${args.id} 的脚本`, 'CLOSET_NOT_FOUND');
      }

      // listLogs 收的是「脚本文件名」，不是条目对象
      const files = await listLogs(workspace, entry.path.split(/[\\/]/).pop());
      if (files.length === 0) {
        return { count: 0, text: `脚本 ${entry.id} 还没有运行日志。` };
      }

      if (args.read) {
        const latest = files[0];
        const n = Number.isFinite(args.lines) && args.lines > 0 ? Math.floor(args.lines) : 120;
        const body = await tailLog(latest.path, n);
        return { count: files.length, text: `最新日志：${latest.path}\n\n${body}` };
      }

      return {
        count: files.length,
        text: [
          `共 ${files.length} 份日志（新的在前）：`,
          ...files.map((f) => `- ${f.path}  ${fmtBytes(f.size)}  ${f.mtime}`),
        ].join('\n'),
      };
    },
  });
