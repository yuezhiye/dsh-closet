/**
 * run.js — 多语言脚本执行层
 *
 * 职责：按语言找到正确的解释器，执行脚本，把输出同时写进日志文件。
 * 设计要点：
 *  1. 不靠 shell 拼接字符串（Windows 下引号/中文路径会被吃掉），统一走 spawn + 参数数组。
 *  2. 解释器来自配置，配置为空时按平台默认值探测。
 *  3. 日志一律落盘到 `<工作区>/.dsh-fix/logs/<脚本名>/<时间戳>.log`，失败也落盘。
 *  4. 有超时保护：脚本卡死不能把 DSH 一起拖死。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { closetPaths, detectLanguage, sanitizeName } from './store.js';

/** 各语言的默认解释器（按平台区分） */
export const DEFAULT_INTERPRETERS = {
  powershell: {
    win32: ['pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'],
    default: ['pwsh', '-NoProfile', '-NonInteractive', '-File'],
    /** 没有 pwsh 时退到 Windows PowerShell 5.1 */
    fallbackWin32: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'],
  },
  node: { win32: ['node'], default: ['node'] },
  python: { win32: ['python'], default: ['python3'], fallbackWin32: ['py', '-3'] },
  batch: { win32: ['cmd.exe', '/d', '/c'], default: [] },
  shell: { win32: ['bash'], default: ['bash'] },
};

/** 每种语言的脚本文件参数（在解释器之后追加） */
const SCRIPT_ARG = {
  powershell: (p) => [p],
  node: (p) => [p],
  python: (p) => [p],
  batch: (p) => [p],
  shell: (p) => [p],
};

/**
 * 生成一次运行的日志文件路径。
 *
 * 时间戳精确到秒，同一脚本在一秒内跑两次就会撞名；而日志流是 `flags: 'a'` 追加写，
 * 撞名不会报错，只会把两次运行的输出糊进同一个文件（头部出现两遍、退出码对不上）。
 * 所以在路径里再掺一段随机后缀，保证一次运行一个文件。
 *
 * @param {string} workspace
 * @param {string} scriptPath
 */
export function logPathFor(workspace, scriptPath) {
  const p = closetPaths(workspace);
  const dir = path.join(p.logs, sanitizeName(path.basename(scriptPath)));
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  const uniq = crypto.randomBytes(4).toString('hex');
  return { dir, file: path.join(dir, `${stamp}-${uniq}.log`) };
}

/**
 * 组装命令行：返回 { command, args }。
 * @param {string} language
 * @param {string} scriptPath
 * @param {string[]} extraArgs
 * @param {{interpreters?:object}} [config]
 * @param {(cmd:string)=>Promise<boolean>} [exists] 解释器是否存在探测函数（单测可注入）
 */
export async function buildCommand(language, scriptPath, extraArgs, config = {}, exists = defaultExists) {
  const custom = config && config.interpreters ? config.interpreters[language] : null;
  const base = custom || DEFAULT_INTERPRETERS[language];
  if (!base) throw new Error(`不支持的语言：${language}`);

  let candidates = [];
  if (Array.isArray(base)) {
    candidates = [base];
  } else {
    const platKey = process.platform === 'win32' ? 'win32' : 'default';
    if (base[platKey] && base[platKey].length) candidates.push(base[platKey]);
    if (process.platform === 'win32' && base.fallbackWin32 && base.fallbackWin32.length) {
      candidates.push(base.fallbackWin32);
    }
  }
  if (!candidates.length) throw new Error(`语言 ${language} 在当前平台没有可用的解释器配置`);

  const tail = SCRIPT_ARG[language];
  if (!tail) throw new Error(`语言 ${language} 缺少脚本参数定义`);

  /**
   * 单条候选的检查：探测存在 + 拼出参数。
   * @param {string[]} c
   */
  const pick = (c) => ({ command: c[0], args: [...c.slice(1), ...tail(scriptPath), ...(extraArgs || [])] });

  // 显式配置的解释器：用户/配置说了算，不做探测（可能是不在 PATH 里的绝对路径或有意的包装脚本）
  if (custom && custom.length) return pick(custom);

  // 一个都探不到时，报错必须说清楚「试过哪些命令」：
  // 否则用户只看得到「找不到解释器 pwsh」，完全不知道还有 5.1 / py -3 之类可配
  const probed = candidates.map((c) => c.join(' '));
  for (const c of candidates) {
    if (await exists(c[0])) return pick(c);
  }
  const err = new Error(
    `找不到可用的 ${language} 解释器，已探测：${probed.join(' / ')}。` +
      `请安装其中之一，或在 config.interpreters.${language} 里配置解释器路径`,
  );
  err.code = 'ENOENT_INTERPRETER';
  err.probed = probed;
  throw err;
}

/**
 * 探测某个可执行文件是否在 PATH 里。
 * @param {string} cmd
 */
export async function defaultExists(cmd) {
  if (!cmd) return false;
  if (path.isAbsolute(cmd)) return fsp.access(cmd).then(() => true, () => false);
  const pathExt = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of pathExt) {
      const candidate = path.join(dir, cmd.toLowerCase().endsWith(ext.toLowerCase()) ? cmd : cmd + ext);
      if (await fsp.access(candidate).then(() => true, () => false)) return true;
    }
  }
  return false;
}

/**
 * 执行脚本。
 *
 * @param {object} params
 * @param {string} params.workspace 工作区
 * @param {string} params.scriptPath 脚本绝对路径
 * @param {string} [params.language] 语言，缺省按扩展名识别
 * @param {string[]} [params.args] 传给脚本的参数
 * @param {number} [params.timeoutMs] 超时毫秒，缺省 120000
 * @param {object} [params.config] 插件配置（interpreters、maxLogBytes 等）
 * @param {string} [params.cwd] 工作目录，缺省为脚本所在目录
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, logFile:string, durationMs:number, timedOut:boolean}>}
 */
export async function runScript(params) {
  const {
    workspace,
    scriptPath,
    args = [],
    timeoutMs = 120000,
    config = {},
    cwd = path.dirname(scriptPath),
  } = params;

  const language = params.language && params.language !== 'unknown' ? params.language : detectLanguage(scriptPath);
  if (!language) throw new Error(`无法识别脚本语言：${scriptPath}`);

  const { command, args: cmdArgs } = await buildCommand(language, scriptPath, args, config);

  const { dir, file } = logPathFor(workspace, scriptPath);
  await fsp.mkdir(dir, { recursive: true });

  const stream = fs.createWriteStream(file, { flags: 'a' });

  const started = Date.now();
  stream.write(`# dsh-closet run\n# time    : ${new Date().toISOString()}\n`);
  stream.write(`# script  : ${scriptPath}\n# language: ${language}\n`);
  stream.write(`# command : ${command} ${cmdArgs.join(' ')}\n# cwd     : ${cwd}\n\n`);

  // 只写一次探针：解释器必须先在 PATH（或绝对路径）里找得到，否则 spawn 的 ENOENT
  // 会被异步吞进 error 事件，报错信息里连命令名都不一定清楚，用户看到的是「莫名其妙失败」。
  // 放在日志流打开之后再探：失败也要在日志里留下「命令是什么、为什么没跑起来」。
  if (!(await defaultExists(command))) {
    stream.write(`# error   : 找不到解释器「${command}」（语言 ${language}）\n`);
    await new Promise((resolve) => stream.end(resolve));
    throw new Error(
      `找不到解释器「${command}」（语言 ${language}）：请安装它，或在 config.interpreters 里配置绝对路径`,
    );
  }

  const child = spawn(command, cmdArgs, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX 下单独成组，超时才能 process.kill(-pid) 一次带走整棵树；Windows 下该选项影响
    // 控制台窗口创建，显式关闭以免弹黑框。两平台都不需要脱离父进程生命周期。
    detached: process.platform !== 'win32',
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const cap = Number.isFinite(config.maxLogBytes) ? config.maxLogBytes : 2 * 1024 * 1024;

  child.stdout.on('data', (buf) => {
    stream.write(buf);
    if (stdout.length < cap) stdout += buf.toString('utf8');
  });
  child.stderr.on('data', (buf) => {
    stream.write(buf);
    if (stderr.length < cap) stderr += buf.toString('utf8');
  });

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, Math.max(1, timeoutMs));

  const result = await new Promise((resolve) => {
    child.on('error', (err) => {
      resolve({ code: null, signal: null, spawnError: String(err && err.message) });
    });
    child.on('close', (code, signal) => {
      resolve({ code, signal });
    });
  });

  clearTimeout(timer);
  // 事件监听器随子进程销毁，这里显式摘掉，避免长驻进程里反复运行时累积引用
  child.stdout.removeAllListeners('data');
  child.stderr.removeAllListeners('data');
  const durationMs = Date.now() - started;

  stream.write(
    `\n# exit    : ${result.code}${result.signal ? ` signal=${result.signal}` : ''}` +
      `${timedOut ? ' (TIMEOUT)' : ''}\n# elapsed : ${durationMs}ms\n`,
  );
  await new Promise((resolve) => stream.end(resolve));

  if (result.spawnError) {
    throw new Error(`启动 ${command} 失败：${result.spawnError}`);
  }

  return {
    code: result.code,
    signal: result.signal,
    stdout,
    stderr,
    logFile: file,
    durationMs,
    timedOut,
  };
}

/**
 * 杀掉整个进程树。
 *
 * 为什么不能只用 child.kill()：Windows 没有真正的信号，kill 走 TerminateProcess，
 * **只结束直接子进程**。脚本若自己再起进程（python 调 ffmpeg、pwsh 里 Start-Process、
 * batch 里 start），这些孙进程会变成孤儿继续跑，把文件句柄占住，导致后续移动/删除失败。
 *
 * 策略（按可靠性排序，逐个尝试）：
 *  1. Windows：`taskkill /PID <pid> /T /F`（/T 才杀整棵树）
 *  2. 非 Windows 且子进程是进程组组长：`process.kill(-pid, 'SIGKILL')` 杀整组
 *  3. 兜底：`child.kill('SIGKILL')`
 *
 * @param {import('node:child_process').ChildProcess} child
 */
export function killTree(child) {
  const pid = child && child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    try {
      // detached+stdio ignore、windowsHide：不要新开黑框；错误本身无意义，忽略即可
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      });
      killer.unref?.();
      return;
    } catch {
      /* 落到下面的兜底 */
    }
  }

  // POSIX：负 pid 表示整个进程组（spawn 时若 detached 才成立，否则退化为杀单进程）
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

/**
 * 读取日志尾部若干行（给面板预览用）。
 * @param {string} file
 * @param {number} [lines]
 */
export async function tailLog(file, lines = 200) {
  const buf = await fsp.readFile(file, 'utf8').catch(() => '');
  const arr = buf.split(/\r?\n/);
  return arr.slice(Math.max(0, arr.length - lines)).join('\n');
}
