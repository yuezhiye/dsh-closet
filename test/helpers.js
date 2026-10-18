import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 测试用临时目录工厂。
 *
 * 规则：
 *  1. 优先建在 `deepseek/.dsh-fix/testtmp/` 下（与源码同盘，避免跨卷 EXDEV 干扰普通用例）；
 *  2. 该目录不可写时退回系统临时目录；
 *  3. 所有现场在 after 钩子里清理，不污染工作区根目录。
 */
const PREFERRED_BASE = path.resolve('..', '.dsh-fix', 'testtmp', 'run');

/** 本次进程启动时刻：只清理比自己更老的残留，避免多个测试进程互相踩 */
const SESSION_START = Date.now();

let swept = false;

/**
 * 清扫上次异常中断留下的目录。
 * 只删邻居里「最后修改时间早于本进程启动」的条目：上一次跑挂掉时进程已退出，
 * 它的目录不会再被写，可以安全清掉；并发跑的另一个测试进程正在用的目录必须放过。
 */
function sweepStale(base) {
  if (swept) return;
  swept = true;
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = path.join(base, ent.name);
    // 上一轮遗留：非目录条目（测试故意写在工作区外、位于 tmp 下的“逃逸”文件）
    if (!ent.isDirectory()) {
      removeDir(abs);
      continue;
    }
    try {
      const st = fs.lstatSync(abs);
      if (st.mtimeMs < SESSION_START - 60_000) removeDir(abs);
    } catch {
      /* 单个条目清理失败不影响其它 */
    }
  }
}

/**
 * 用例自己的清理计划：由 after 钩子统一执行。
 *
 * 注意：这个文件会被当成测试文件加载（`node --test "test/*.test.js"` 不含它，
 * 但手工指定目录时可能包含），所以这里不能有会抛错的临时副作用，
 * 所有目录一律先登记、后清理。
 * @type {string[]}
 */
const created = [];

/**
 * 创建一个唯一的临时目录并返回路径（已创建），并登记到 after 清理清单。
 * @param {string} [prefix]
 * @returns {string}
 */
export function makeTempDir(prefix = 'case') {
  let base = PREFERRED_BASE;
  try {
    fs.mkdirSync(base, { recursive: true });
    sweepStale(base);
  } catch {
    base = os.tmpdir();
  }
  const uniq = `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = fs.mkdtempSync(path.join(base, `${uniq}-`));
  created.push(dir);
  return dir;
}

/**
 * 显式指定父目录创建唯一临时目录（已创建），同样登记到清理清单。
 * 用于需要「跨卷」的用例：父目录必须在另一个盘上。
 * @param {string} parent 父目录绝对路径
 * @param {string} [prefix]
 * @returns {string}
 */
export function makeTempDirIn(parent, prefix = 'case') {
  // 盘根（H:\）本身不需要也不能被创建，mkdir 会 EPERM
  const isRoot = path.dirname(parent) === parent;
  if (!isRoot) fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, `${prefix}-${process.pid}-`));
  created.push(dir);
  return dir;
}

/** 清理本次进程登记过的所有临时目录（在 after 钩子调用，失败不抛） */
export function cleanupTempDirs() {
  while (created.length) removeDir(created.pop());
}

/**
 * 递归删除目录，失败不抛（测试清理用）。
 * @param {string} dir
 */
export function removeDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* 清理失败不影响断言结果 */
  }
}

/**
 * 递归快照目录：相对路径 → { size, mtimeMs, sha }，用于「扫描前后无改动」比对。
 * @param {string} root
 * @returns {Record<string, {size:number, mtimeMs:number, sha:string}>}
 */
export function snapshotTree(root, crypto) {
  const out = {};
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        out[path.relative(root, abs)] = { link: fs.readlinkSync(abs) };
        continue;
      }
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      const st = fs.statSync(abs);
      const body = fs.readFileSync(abs);
      out[path.relative(root, abs)] = {
        size: st.size,
        mtimeMs: st.mtimeMs,
        sha: crypto.createHash('sha1').update(body).digest('hex'),
      };
    }
  };
  walk(root);
  return out;
}
