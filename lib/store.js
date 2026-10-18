/**
 * store.js — 登记册读写层
 *
 * 职责：管理 `<工作区>/.dsh-fix/registry.json`，是整个插件的唯一数据源。
 * 设计要点：
 *  1. 原子写入：先写 `.tmp` 再 rename，避免断电/崩溃写出半个 JSON。
 *  2. 版本号：文件带 `schemaVersion`，将来迁移有据可依。
 *  3. 纯 Node，不依赖 DSH —— 可单测、可被别的宿主复用。
 *  4. 所有路径写入前都规范化成绝对路径并统一分隔符，避免 Windows 大小写/斜杠差异导致重复登记。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 当前登记册格式版本 */
export const SCHEMA_VERSION = 1;

/** 收纳间目录名（放在工作区根下） */
export const CLOSET_DIRNAME = '.dsh-fix';

/** 登记的脚本状态取值 */
export const STATUSES = ['active', 'done', 'obsolete'];

/** 支持的语言及其识别依据 */
export const LANGUAGES = {
  powershell: ['.ps1', '.psm1', '.psd1'],
  node: ['.js', '.mjs', '.cjs', '.ts'],
  python: ['.py'],
  batch: ['.bat', '.cmd'],
  shell: ['.sh', '.bash', '.zsh'],
};

/**
 * 按扩展名判断脚本语言。
 * @param {string} filePath 文件路径
 * @returns {string|null} 语言名，未识别返回 null
 */
export function detectLanguage(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  for (const [lang, exts] of Object.entries(LANGUAGES)) {
    if (exts.includes(ext)) return lang;
  }
  return null;
}

/**
 * 把路径规范化成统一形式，用于比较与落盘。
 * Windows 下统一盘符大写、反斜杠，但不改路径主体的大小写（保留用户原样）。
 * @param {string} p 路径
 * @returns {string}
 */
export function normalizePath(p) {
  if (!p) return '';
  let out;
  try {
    out = path.resolve(String(p));
  } catch {
    // 非法路径（含 NUL 等）不能让整个插件崩掉
    return '';
  }
  if (process.platform === 'win32') {
    out = out.replace(/\//g, '\\');
    if (/^[a-z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1);
  }
  return out;
}

/**
 * 大小写不敏感的路径比较键（Windows 全盘不敏感；其它平台保持敏感）。
 * @param {string} p
 * @returns {string}
 */
export function pathKey(p) {
  const n = normalizePath(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * 判断 `child` 是否等于 `parent` 或位于其内部（按路径边界比较，不做字符串前缀拼接）。
 *
 * 坑一：直接 `child.startsWith(parent)` 会把 `C:\ws-other` 误判成在 `C:\ws` 之内。
 * 坑二：`path.relative` 在跨盘符时返回绝对路径，必须用 isAbsolute 兜住。
 * 坑三：`path.relative` 的第二个参数若是相对路径，会相对 `process.cwd()` 解析，
 *       结果看似「后代」实为随手传错——这里先把两边都 resolve 成绝对路径。
 *
 * 注意：本函数只做**字面**判断。目录联接/符号链接能把字面在内、实际在外的路径伪装成
 * 「在工作区内」，凡是拿它当安全闸门的调用方（回收站）必须改用 realPath() 之后再判断。
 *
 * @param {string} parent 父目录
 * @param {string} child 子路径
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const a = pathKey(parent);
  const b = pathKey(child);
  if (!a || !b) return false;
  if (a === b) return true;
  const rel = path.relative(a, b);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/**
 * 尽力求出路径的「真实形态」：把中间的目录联接/符号链接解析掉。
 * 用于安全闸门——`C:\ws\link-out\secret.txt` 字面上在工作区内，
 * 实际上指向工作区之外，只比字面路径是挡不住的。
 *
 * 注意：Windows 的目录联接（Junction）也能被 `fs.realpathSync.native` 解析，
 * 但 `lstat().isSymbolicLink()` 对它同样返回 true，两者都可用。
 *
 * @param {string} p 任意路径（可以还不存在，取最近存在祖先的真实路径再拼回剩余部分）
 * @returns {string} 解析后的路径；完全解析失败时原样返回规范化结果
 */
export function realPath(p) {
  const abs = normalizePath(p);
  if (!abs) return '';
  let cur = abs;
  const tail = [];
  // 向上找第一个存在的祖先，再把不存在的部分原样拼回去
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native(cur);
      return normalizePath(tail.length ? path.join(real, ...tail.reverse()) : real);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return abs;
}

/**
 * 收纳间路径计算。
 * @param {string} workspace 工作区根目录
 */
export function closetPaths(workspace) {
  const root = path.join(normalizePath(workspace), CLOSET_DIRNAME);
  return {
    root,
    registry: path.join(root, 'registry.json'),
    scripts: path.join(root, 'scripts'),
    logs: path.join(root, 'logs'),
    trash: path.join(root, 'trash'),
    tmp: path.join(root, '.tmp'),
  };
}

/** 空登记册 */
function emptyRegistry() {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), scripts: [] };
}

/**
 * 读取登记册。文件不存在或损坏时返回空结构，不抛错（插件不能因为脏数据起不来）。
 * @param {string} workspace
 * @returns {Promise<{registry: object, recovered: boolean, error?: string}>}
 */
export async function readRegistry(workspace) {
  const { registry: file } = closetPaths(workspace);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { registry: emptyRegistry(), recovered: false };
    return { registry: emptyRegistry(), recovered: true, error: String(err && err.message) };
  }
  try {
    const parsed = JSON.parse(raw);
    // JSON 合法但结构离谱（null、数组、字符串）时不能当正常表用，否则 migrate 之外
    // 的调用方会拿到一个没有 scripts 的对象，后续 push 直接抛错。
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('登记册结构非法（不是对象）');
    }
    return { registry: migrate(parsed), recovered: false };
  } catch (err) {
    // 损坏时留一份现场再返回空表，不静默丢弃用户数据。
    // 加序号而不是只用时间戳：同一毫秒内连读两次时，rename 到已存在的目标名在 Windows 上会 EPERM/EEXIST，
    // 现场文件就没保住。序号确保一定落盘，绝不覆盖更早的现场。
    let n = 0;
    for (;;) {
      const target = `${file}.corrupt-${Date.now()}${n ? `-${n}` : ''}`;
      try {
        await fsp.rename(file, target);
        break;
      } catch {
        // 撞名或改名失败：换一个名字再试，重试次数用尽就当改名失败，不阻塞主流程
        if (++n >= 5) break;
      }
    }
    return { registry: emptyRegistry(), recovered: true, error: String(err && err.message) };
  }
}

/**
 * 把任意版本的登记册升级到当前格式。
 * @param {any} parsed
 */
function migrate(parsed) {
  if (!parsed || typeof parsed !== 'object') return emptyRegistry();
  const scripts = Array.isArray(parsed.scripts) ? parsed.scripts : [];
  const out = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: parsed.updatedAt || new Date().toISOString(),
    scripts: scripts.map(normalizeEntry).filter(Boolean),
  };
  return out;
}

/**
 * 补齐单条记录缺失字段，过滤非法条目。
 * @param {any} e
 */
function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const filePath = normalizePath(e.path || '');
  if (!filePath) return null;
  return {
    id: String(e.id || makeId(filePath)),
    path: filePath,
    language: LANGUAGES[e.language] ? e.language : detectLanguage(filePath) || 'unknown',
    purpose: String(e.purpose || ''),
    status: STATUSES.includes(e.status) ? e.status : 'active',
    createdAt: e.createdAt || new Date().toISOString(),
    lastRunAt: e.lastRunAt || null,
    runs: Number.isFinite(e.runs) ? e.runs : 0,
    notes: String(e.notes || ''),
  };
}

/**
 * 由路径生成稳定 id（同一文件重复登记得到同一 id）。
 * @param {string} p
 */
export function makeId(p) {
  const key = pathKey(p);
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `s_${hash.toString(16).padStart(8, '0')}`;
}

/**
 * 把任意字符串变成安全的单段文件名（用于日志目录名等）。
 *
 * 为什么放在 store：run 需要它给日志目录取名，而 run → scan → store 这条链
 * 只为借一个纯字符串函数，会让 run 白白依赖整个扫描逻辑。
 *
 * 需要处理的情况：
 *  - Windows 保留字符 `\ / : * ? " < > |`；
 *  - 全由点组成（`.` / `..` / `...`）会被当成上级目录；
 *  - 以点或空格结尾在 Windows 上会被系统静默截掉，和别的目录撞名；
 *  - NUL 等控制字符会直接让 fs 抛错。
 *
 * @param {string} name
 */
export function sanitizeName(name) {
  let out = String(name || '')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 80);
  // 以点或空格结尾在 Windows 上会被系统静默截掉，容易和别的目录撞名
  out = out.replace(/[. ]+$/, '');
  // 只剩点（`.`、`..`）时拼进路径会指向上级目录，直接给个固定名
  if (!out || /^\.+$/.test(out)) out = '_';
  return out;
}

/**
 * 读-改-写串行队列（按工作区分别排队）。
 *
 * 为什么必须有：`register()` 是「readRegistry → 改 → writeRegistry」，
 * 两个并发 register 会互相覆盖对方的写入（lost update，第二个用旧表覆盖第一个的条目）。
 * 另外原子写的临时文件名只用到 `pid + Date.now()`，
 * 同一毫秒内的两次并发写会撞同名临时文件，后一次 rename 报 ENOENT。
 *
 * @type {Map<string, Promise<any>>}
 */
const writeQueues = new Map();

/**
 * 把一次对登记册的「读改写」放进工作区私有队列里串行执行。
 * 前一个任务无论成功失败都不会卡住后面的任务。
 *
 * @template T
 * @param {string} workspace
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function withRegistryLock(workspace, task) {
  const key = pathKey(workspace);
  const prev = writeQueues.get(key) || Promise.resolve();
  const next = prev.then(task, task);
  // 队列尾巴只用于串联，不能把错误冒泡成 unhandledRejection
  const tail = next.catch(() => {});
  writeQueues.set(key, tail);
  tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return next;
}

/**
 * 原子写入登记册。
 * @param {string} workspace
 * @param {object} registry
 */
export async function writeRegistry(workspace, registry) {
  const p = closetPaths(workspace);
  await fsp.mkdir(p.root, { recursive: true });
  await fsp.mkdir(p.tmp, { recursive: true });
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    scripts: (registry.scripts || []).map(normalizeEntry).filter(Boolean),
  };
  // 临时文件名必须唯一：同进程同一毫秒、甚至不同进程都可能撞名
  const tmpFile = path.join(
    p.tmp,
    `registry-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.json`,
  );
  const body = JSON.stringify(payload, null, 2) + '\n';
  try {
    const handle = await fsp.open(tmpFile, 'w');
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync(); // 落盘再 rename，防止正文还在页缓存时断电
    } finally {
      await handle.close();
    }
    await fsp.rename(tmpFile, p.registry);
  } catch (err) {
    // 半成品临时文件不能留在 .tmp 里发霉
    await fsp.rm(tmpFile, { force: true }).catch(() => {});
    throw err;
  }
  return payload;
}

/**
 * 登记（或更新）一条脚本记录。同一路径重复调用不会产生重复条目。
 * 整个「读-改-写」在 withRegistryLock 内完成，并发调用不会丢条目。
 * @param {string} workspace
 * @param {{path:string, purpose?:string, language?:string, notes?:string, status?:string}} input
 * @returns {Promise<{entry: object, registry: object, created: boolean}>}
 */
export async function register(workspace, input) {
  const filePath = normalizePath(input && input.path);
  if (!filePath) throw new Error('register 需要 path 参数（脚本的绝对或相对路径）');

  return withRegistryLock(workspace, async () => {
    const { registry } = await readRegistry(workspace);
    const key = pathKey(filePath);
    const existing = registry.scripts.find((s) => pathKey(s.path) === key);

    if (existing) {
      if (input.purpose !== undefined) existing.purpose = String(input.purpose);
      if (input.notes !== undefined) existing.notes = String(input.notes);
      if (input.status !== undefined && STATUSES.includes(input.status)) existing.status = input.status;
      if (input.language !== undefined && LANGUAGES[input.language]) existing.language = input.language;
      const saved = await writeRegistry(workspace, registry);
      return { entry: existing, registry: saved, created: false };
    }

    const entry = normalizeEntry({
      path: filePath,
      purpose: input.purpose,
      notes: input.notes,
      language: input.language || detectLanguage(filePath),
      status: STATUSES.includes(input.status) ? input.status : 'active',
      createdAt: new Date().toISOString(),
      runs: 0,
    });
    registry.scripts.push(entry);
    const saved = await writeRegistry(workspace, registry);
    return { entry, registry: saved, created: true };
  });
}

/**
 * 注销一条记录（只从登记册移除，不动文件）。
 * @param {string} workspace
 * @param {string} idOrPath
 */
export async function unregister(workspace, idOrPath) {
  return withRegistryLock(workspace, async () => {
    const { registry } = await readRegistry(workspace);
    const key = pathKey(idOrPath);
    const before = registry.scripts.length;
    registry.scripts = registry.scripts.filter((s) => s.id !== idOrPath && pathKey(s.path) !== key);
    const removed = before - registry.scripts.length;
    if (removed > 0) await writeRegistry(workspace, registry);
    return { removed, registry };
  });
}

/**
 * 记录一次执行（累加计数、刷新时间）。
 * @param {string} workspace
 * @param {string} id
 */
export async function markRun(workspace, id) {
  return withRegistryLock(workspace, async () => {
    const { registry } = await readRegistry(workspace);
    const entry = registry.scripts.find((s) => s.id === id);
    if (!entry) return null;
    entry.runs = (Number(entry.runs) || 0) + 1;
    entry.lastRunAt = new Date().toISOString();
    await writeRegistry(workspace, registry);
    return entry;
  });
}

/**
 * 列出登记册内容，可按状态过滤。
 * @param {string} workspace
 * @param {{status?:string}} [options]
 */
export async function list(workspace, options = {}) {
  const { registry, recovered, error } = await readRegistry(workspace);
  let scripts = registry.scripts;
  if (options.status) scripts = scripts.filter((s) => s.status === options.status);
  // 同时报告文件是否还在，方便用户发现「登记了但文件被删」的孤儿记录
  const enriched = await Promise.all(
    scripts.map(async (s) => ({
      ...s,
      exists: await fsp.access(s.path).then(() => true, () => false),
    })),
  );
  return { scripts: enriched, recovered, error };
}

/**
 * 确保收纳间的目录骨架存在（首次使用时调用）。
 * @param {string} workspace
 */
export async function ensureLayout(workspace) {
  const p = closetPaths(workspace);
  for (const dir of [p.root, p.scripts, p.logs, p.trash]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  return p;
}

/**
 * 递归列出目录下的文件（跳过符号链接，避免 OneDrive 占位符死循环）。
 *
 * 返回的 `path` 一律是**相对 dir 的 POSIX 风格路径**（分隔符统一成 `/`），
 * 理由：Windows 的 `path.relative` 返回 `a\b`，直接拿来当 URL / 跨平台比对会出错；
 * 调用方要绝对路径就自己 `path.join(dir, rel)`。
 *
 * @param {string} dir
 * @param {{ignore?:(absPath:string)=>boolean, maxFiles?:number, maxDepth?:number}} [options]
 * @returns {Promise<Array<{path:string,size:number,mtimeMs:number}>>}
 */
export async function walk(dir, options = {}) {
  const out = [];
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : Infinity;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 64;
  const seen = new Set(); // 真实路径去重：双 Hardlink / 目录联接都可能造成重复遍历
  // 去重键的大小写策略与 pathKey 保持一致（Linux 上大小写敏感，不能一律 toLowerCase）
  const foldCase = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);

  /** @param {string} cur @param {number} depth */
  const visit = async (cur, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      return; // 权限不足 / 目录刚被删：跳过，不中断整次遍历
    }
    // 排序：保证同一目录下结果稳定，便于测试与用户复现
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      const abs = path.join(cur, ent.name);
      if (options.ignore && options.ignore(abs)) continue;
      // 符号链接一律跳过：可能指向工作区外，也可能自指成环。
      // OneDrive 的「占位文件」是重解析点，lstat 同样报 symbolic link——跳过正好符合预期：
      // 只会顺带「少列」，绝不会把云上还没下载的文件误判成遗留物。
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        await visit(abs, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue; // FIFO / socket / 设备文件不当作普通文件
      const real = realPath(abs);
      if (seen.has(foldCase(real))) continue;
      seen.add(foldCase(real));
      let st;
      try {
        st = await fsp.stat(abs);
      } catch {
        continue;
      }
      out.push({
        // 相对路径跨盘符时 path.relative 会返回绝对路径，这里兜一手，保证永远是相对的
        path: toRelPosix(dir, abs),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  };
  await visit(dir, 0);
  return out;
}

/**
 * 把绝对路径转成「相对 base 的 POSIX 风格路径」；跨盘符等转不出来时退回文件名。
 * @param {string} base
 * @param {string} abs
 */
function toRelPosix(base, abs) {
  const rel = path.relative(base, abs);
  if (!rel || path.isAbsolute(rel)) return path.basename(abs);
  return rel.split(path.sep).join('/');
}

export { fs, fsp, path };
