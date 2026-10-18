/**
 * git.js — 「这个文件 git 跟踪着吗？」的查询层
 *
 * 为什么需要它：扫描器靠文件名/位置猜「像临时产物」，但正经项目里也可能有
 * `src/fix-imports.ps1`、`docs/*.log` 这类被 git 认真管理的文件。把已跟踪的文件
 * 标出来（并在清理时默认拒绝），能挡掉绝大多数误清运。
 *
 * 设计要点：
 *  - **只读**：只跑 `git ls-files`，绝不碰工作树（带 --cached，不会改写索引）。
 *  - **失败即降级**：不是 git 仓库、没装 git、超时 —— 一律返回空集合，扫描照常进行，
 *    只是少了这层保护。绝不能因为 git 不在就让整个扫描报错。
 *  - **不阻塞主流程太久**：默认 5 秒超时，大仓库也够；超时按「没拿到」处理。
 *  - 结果按进程内存缓存（带 TTL），同一工作区连续扫两次不必跑两次 git。
 */

import { execFile } from 'node:child_process';

/** 一次 ls-files 最长等多久（毫秒）。超时按「没拿到信息」处理。 */
const DEFAULT_TIMEOUT_MS = 5000;

/** 缓存有效期（毫秒）。短一点，避免用户刚 git add 完看到的还是旧状态。 */
const DEFAULT_TTL_MS = 15000;

/** 同一个工作区并发扫描时合并成一次 git 调用 */
const inflight = new Map();

/** path -> { at:number, set:Set<string> } */
const cache = new Map();

/**
 * 把绝对路径转成「相对仓库根、POSIX 分隔、小写」的比较键。
 * Windows 上 git 的 core.ignorecase 通常为 true（不区分大小写），统一小写比较最稳。
 * @param {string} repoRoot
 * @param {string} abs
 * @returns {string}
 */
function keyOf(repoRoot, abs) {
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const target = abs.replace(/\\/g, '/').toLowerCase();
  if (target === root) return '';
  if (!target.startsWith(`${root}/`)) return target;
  return target.slice(root.length + 1);
}

/**
 * 用 `git ls-files -z` 列出仓库里被跟踪的文件。
 *
 * 返回 null 表示「这个目录不是 git 仓库或 git 不可用」——调用方据此决定是否提示用户。
 *
 * ⚠ 关键坑：`git ls-files` 在子目录里运行时，输出的路径是**相对 cwd**的（不是相对仓库根），
 *    例如在 `<repo>/sub` 里跑会得到 `a.txt` 而不是 `sub/a.txt`。
 *    为了统一口径，这里改成**在仓库根执行** ls-files 并加 `--full-name`，
 *    保证集合里永远是「相对仓库根的路径」，与 keyOf() 的算法对齐。
 *
 * @param {string} workspace 工作区根目录（不一定是仓库根，子目录也行）
 * @param {{timeoutMs?:number, cwd?:string}} [options]
 * @returns {Promise<{repoRoot:string, files:Set<string>}|null>}
 */
export function gitTrackedFiles(workspace, options = {}) {
  const cwd = options.cwd || workspace;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', 'rev-parse', '--show-toplevel'],
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const repoRoot = String(stdout || '').trim();
        if (err || !repoRoot) {
          resolve(null);
          return;
        }
        const rootPosix = repoRoot.replace(/\\/g, '/');
        execFile(
          'git',
          ['-c', 'core.quotepath=false', 'ls-files', '-z', '--cached', '--full-name'],
          {
            // 必须在仓库根执行：子目录执行时输出口径会变（见上方说明）
            cwd: repoRoot,
            timeout: timeoutMs,
            windowsHide: true,
            // 大仓库动辄几万个文件名，1MB 默认缓冲区远远不够
            maxBuffer: 64 * 1024 * 1024,
          },
          (err2, stdout2) => {
            if (err2 || !stdout2) {
              resolve(null);
              return;
            }
            const files = new Set();
            for (const rel of String(stdout2).split('\0')) {
              if (rel) files.add(rel.replace(/\\/g, '/').toLowerCase());
            }
            resolve({ repoRoot: rootPosix, files });
          },
        );
      },
    );
  });
}

/**
 * 带缓存与并发合并的入口。
 *
 * @param {string} workspace
 * @param {{timeoutMs?:number, ttlMs?:number, noCache?:boolean}} [options]
 * @returns {Promise<{repoRoot:string, files:Set<string>}|null>} null = 非 git 仓库/不可用
 */
export async function trackedFileSet(workspace, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  const key = String(workspace).toLowerCase();
  const now = Date.now();

  if (!options.noCache) {
    const hit = cache.get(key);
    // 缓存里也可能是 null（上次就判定为「不是仓库」），同样在 TTL 内复用
    if (hit && now - hit.at < ttlMs) return hit.value;
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const task = gitTrackedFiles(workspace, options)
    .then((value) => value)
    .catch(() => null);

  inflight.set(key, task);
  const value = await task;
  inflight.delete(key);
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * 判断一组绝对路径里哪些被 git 跟踪。
 *
 * @param {string} workspace
 * @param {string[]} absPaths
 * @param {{timeoutMs?:number, ttlMs?:number, noCache?:boolean}} [options]
 * @returns {Promise<{available:boolean, repoRoot:string|null, tracked:Set<string>, untracked:Set<string>}>}
 *          tracked / untracked 存的都是**传进来的原始绝对路径**，方便调用方直接比对
 */
export async function partitionTracked(workspace, absPaths, options = {}) {
  const tracked = new Set();
  const untracked = new Set();
  const info = await trackedFileSet(workspace, options);
  if (!info) {
    for (const p of absPaths) untracked.add(p);
    return { available: false, repoRoot: null, tracked, untracked };
  }
  for (const p of absPaths) {
    if (info.files.has(keyOf(info.repoRoot, p))) tracked.add(p);
    else untracked.add(p);
  }
  return { available: true, repoRoot: info.repoRoot, tracked, untracked };
}

/**
 * 单个路径的便捷判断。git 不可用时返回 false（= 当作没被跟踪），
 * 调用方需要区分「确定没跟踪」和「问不出来」时用 partitionTracked。
 *
 * @param {string} workspace
 * @param {string} absPath
 * @param {{timeoutMs?:number, ttlMs?:number, noCache?:boolean}} [options]
 * @returns {Promise<boolean>}
 */
export async function isTracked(workspace, absPath, options = {}) {
  const info = await trackedFileSet(workspace, options);
  if (!info) return false;
  return info.files.has(keyOf(info.repoRoot, absPath));
}

/** 清空缓存（测试用；也供面板「刷新」按钮调用） */
export function clearGitCache() {
  cache.clear();
  inflight.clear();
}

export { keyOf as _keyOf };
